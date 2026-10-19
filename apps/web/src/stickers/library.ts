import {
  InkDocument, affineTranslate, newId, selectionBBox, transformObject,
  type InkObject, type PdfAsset,
} from '@inknote/core';
import { getServerUrl, type Repo } from '../storage/repo';
import { DocSession } from '../sync/DocSession';
import type { Sticker, StickerItem } from './pack';

/** 내 스티커 보관함 문서 id — 일반 노트처럼 동기화되지만 라이브러리 목록에는 나오지 않는다 */
export const STICKER_DOC_ID = 'stickers';

/**
 * 내 스티커: 스티커 한 장 = 보관함 문서의 페이지 하나 (페이지 크기 = 스티커 크기).
 * 그래서 노트와 똑같이 기기 간 동기화되고, 이미지 스티커의 원본도 에셋으로 함께 올라간다.
 */
export class StickerLibrary {
  private listeners = new Set<() => void>();
  private unsub: () => void;

  private constructor(
    readonly doc: InkDocument,
    private session: DocSession,
  ) {
    this.unsub = doc.on(() => this.listeners.forEach((l) => l()));
  }

  static async open(repo: Repo, onAsset: (id: string) => void): Promise<StickerLibrary> {
    const rec = await repo.load(STICKER_DOC_ID);
    const doc = rec ? InkDocument.fromSnapshot(rec.snapshot, repo.clientId) : new InkDocument(STICKER_DOC_ID, repo.clientId);
    if (!rec) doc.setTitle('내 스티커');
    const session = new DocSession(doc, repo, getServerUrl(), rec?.lastSeq ?? 0, rec?.outbox ?? [], onAsset);
    return new StickerLibrary(doc, session);
  }

  onChange(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  list(): Sticker[] {
    return [...this.doc.pages].reverse().map((p) => ({
      id: p.id,
      name: '',
      w: p.width,
      h: p.height,
      objects: this.doc.objects(p.id).map(({ id: _i, pageId: _p, z: _z, group: _g, ...rest }) => rest as StickerItem),
    }));
  }

  /** 스티커가 쓰는 이미지 원본 */
  assetsOf(s: Sticker): PdfAsset[] {
    const ids = new Set(s.objects.flatMap((o) => (o.type === 'image' ? [o.assetId] : [])));
    return this.doc.assets().filter((a) => ids.has(a.id));
  }

  /** 선택한 객체들로 스티커 만들기 (assets: 이미지 원본 정보) */
  add(objs: InkObject[], assets: PdfAsset[] = []): void {
    if (!objs.length) return;
    const b = selectionBBox(objs);
    const pad = 2;
    const w = Math.ceil(b.maxX - b.minX + pad * 2), h = Math.ceil(b.maxY - b.minY + pad * 2);
    const m = affineTranslate(pad - b.minX, pad - b.minY);
    const last = this.doc.pages.at(-1)?.id ?? null;
    const [page] = this.doc.insertPages(last, [{ width: w, height: h, bg: { kind: 'blank' } }], '스티커 추가');
    const have = new Set(this.doc.assets().map((a) => a.id));
    this.doc.transact('스티커 추가', (tx) => {
      for (const a of assets) if (!have.has(a.id)) tx.put('asset', a.id, a);
      for (const o of [...objs].sort((x, y) => x.z - y.z)) {
        const c = { ...transformObject(o, m), id: newId(), pageId: page.id, z: this.doc.nextZ() };
        delete c.group;
        tx.put('obj', c.id, c);
      }
    });
  }

  /** 사진으로 스티커 만들기 (긴 변 120pt) */
  addImage(asset: PdfAsset, width: number, height: number): void {
    const k = 120 / Math.max(width, height);
    this.add([{ type: 'image', id: 'tmp', pageId: 'tmp', z: 0, assetId: asset.id, x: 0, y: 0, w: width * k, h: height * k, opacity: 1 }], [asset]);
  }

  remove(id: string): void {
    this.doc.deletePage(id);
  }

  async close(): Promise<void> {
    this.unsub();
    await this.session.close();
  }
}
