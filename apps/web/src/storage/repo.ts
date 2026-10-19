import {
  InkDocument, documentPlainText, newId, type DistributiveOmit, type DocSnapshot, type HwrRecord, type InkObject, type Op, type Page, type PdfAsset,
} from '@inknote/core';

/**
 * 로컬 저장소 (IndexedDB) — 웹 브라우저와 Capacitor WebView(iOS/Android) 모두에서 동작.
 *
 *  meta  : 라이브러리 목록용 가벼운 레코드
 *  docs  : 문서 스냅샷 + 동기화 커서(lastSeq) + 미전송 op(outbox)
 *  blobs : PDF 원본 (SHA-256 키)
 *  kv    : clientId 등
 */
export interface DocMetaRecord {
  id: string;
  title: string;
  updatedAt: number;
  pageCount: number;
  /** 라이브러리 검색 색인: 페이지별 손글씨 인식 결과 + 텍스트 상자 글자 */
  text?: string[];
}

export interface DocRecord {
  id: string;
  snapshot: DocSnapshot;
  lastSeq: number;
  outbox: Op[];
}

const DB = 'inknote';
const VERSION = 1;

function req<T>(r: IDBRequest<T>): Promise<T> {
  return new Promise((res, rej) => {
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}

export class Repo {
  private constructor(
    private db: IDBDatabase,
    readonly clientId: string,
  ) {}

  static async open(): Promise<Repo> {
    const open = indexedDB.open(DB, VERSION);
    open.onupgradeneeded = () => {
      const db = open.result;
      for (const s of ['meta', 'docs', 'blobs', 'kv']) if (!db.objectStoreNames.contains(s)) db.createObjectStore(s);
    };
    const db = await req(open);
    let clientId = await req(db.transaction('kv').objectStore('kv').get('clientId')) as string | undefined;
    if (!clientId) {
      clientId = newId(12);
      await req(db.transaction('kv', 'readwrite').objectStore('kv').put(clientId, 'clientId'));
    }
    return new Repo(db, clientId);
  }

  private store(name: string, mode: IDBTransactionMode = 'readonly') {
    return this.db.transaction(name, mode).objectStore(name);
  }

  async list(): Promise<DocMetaRecord[]> {
    // 스티커 보관함은 노트 목록에서 숨김
    const all = ((await req(this.store('meta').getAll())) as DocMetaRecord[]).filter((d) => d.id !== 'stickers');
    return all.sort((a, b) => b.updatedAt - a.updatedAt);
  }

  async load(id: string): Promise<DocRecord | null> {
    return ((await req(this.store('docs').get(id))) as DocRecord | undefined) ?? null;
  }

  async save(doc: InkDocument, lastSeq: number, outbox: Op[]): Promise<void> {
    const tx = this.db.transaction(['docs', 'meta'], 'readwrite');
    const rec: DocRecord = { id: doc.id, snapshot: doc.toSnapshot(), lastSeq, outbox };
    const meta: DocMetaRecord = {
      id: doc.id, title: doc.meta.title, updatedAt: Date.now(), pageCount: doc.pages.length,
      text: documentPlainText({ pages: doc.pages, objects: (id) => doc.objects(id), hwr: (id) => doc.hwr(id) }),
    };
    tx.objectStore('docs').put(rec, doc.id);
    tx.objectStore('meta').put(meta, doc.id);
    await new Promise<void>((res, rej) => {
      tx.oncomplete = () => res();
      tx.onerror = () => rej(tx.error);
    });
  }

  /** 새 문서: 생성 op 전체를 outbox 에 넣어 첫 동기화 때 서버로 업로드 */
  async create(
    title: string,
    pages: Array<Pick<Page, 'width' | 'height' | 'bg'>>,
    assets: PdfAsset[] = [],
    objects: Array<Array<DistributiveOmit<InkObject, 'id' | 'pageId' | 'z'>>> = [],
    hwr: Array<Pick<HwrRecord, 'engine' | 'words'> | undefined> = [],
  ): Promise<InkDocument> {
    const doc = InkDocument.create(this.clientId, title, pages, assets, objects, hwr);
    await this.save(doc, 0, doc.toSnapshot().ops);
    return doc;
  }

  async remove(id: string): Promise<void> {
    const tx = this.db.transaction(['docs', 'meta'], 'readwrite');
    tx.objectStore('docs').delete(id);
    tx.objectStore('meta').delete(id);
    await new Promise<void>((res) => (tx.oncomplete = () => res()));
  }

  async putBlob(id: string, bytes: ArrayBuffer): Promise<void> {
    await req(this.store('blobs', 'readwrite').put(bytes, id));
  }

  async getBlob(id: string): Promise<ArrayBuffer | null> {
    return ((await req(this.store('blobs').get(id))) as ArrayBuffer | undefined) ?? null;
  }
}

// ── 동기화 서버 주소 (설정 화면에서 변경) ──
const SERVER_KEY = 'inknote.server';

export function getServerUrl(): string {
  try {
    const v = localStorage.getItem(SERVER_KEY);
    if (v !== null) return v;
  } catch {
    /* ignore */
  }
  // 웹 개발 기본값: 같은 호스트의 8787 포트. 네이티브 앱(capacitor://, https://localhost)은 직접 설정해야 함
  const { protocol, hostname } = location;
  if (protocol === 'http:' || (protocol === 'https:' && hostname !== 'localhost')) {
    return `${protocol === 'https:' ? 'wss' : 'ws'}://${hostname}:8787`;
  }
  return '';
}

export function setServerUrl(url: string): void {
  localStorage.setItem(SERVER_KEY, url.trim());
}

export function httpBase(wsUrl: string): string {
  return wsUrl.replace(/^ws/, 'http').replace(/\/+$/, '');
}
