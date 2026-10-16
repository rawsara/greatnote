import { newId, type ChangeEvent, type ClientMsg, type InkDocument, type Op, type PdfAsset, type ServerMsg } from '@inknote/core';
import { httpBase, type Repo } from '../storage/repo';

export type SyncStatus = 'local' | 'offline' | 'connecting' | 'syncing' | 'synced';

/**
 * 열린 문서 하나의 "로컬 저장 + 서버 동기화" 세션 (오프라인 우선).
 *
 * 1) 모든 로컬 변경 op 는 outbox 에 쌓이고 IndexedDB 에 디바운스 저장된다.
 * 2) 접속되면 hello(since=lastSeq) 로 놓친 변경을 받고, outbox 를 push 한다.
 * 3) ack 받은 op 만 outbox 에서 제거 → 전송 중 끊겨도 재접속 시 재전송(LWW 라 멱등).
 * 4) PDF 에셋은 content-addressed blob 으로 별도 업/다운로드.
 */
export class DocSession {
  status: SyncStatus = 'local';
  private ws: WebSocket | null = null;
  private inflight = new Map<string, Op[]>();
  private saveTimer = 0;
  private retry = 0;
  private retryTimer = 0;
  private closed = false;
  private unsub: () => void;
  private statusListeners = new Set<(s: SyncStatus) => void>();
  private uploading = new Set<string>();

  constructor(
    readonly doc: InkDocument,
    private repo: Repo,
    private serverUrl: string,
    private lastSeq: number,
    private outbox: Op[],
    private onAssetArrived: (id: string) => void,
  ) {
    this.unsub = doc.on(this.onChange);
    if (serverUrl) this.connect();
    // 오프라인에서 추가된 PDF 를 업로드
    for (const a of doc.assets()) void this.ensureUploaded(a);
  }

  onStatus(fn: (s: SyncStatus) => void): () => void {
    this.statusListeners.add(fn);
    fn(this.status);
    return () => this.statusListeners.delete(fn);
  }

  private setStatus(s: SyncStatus) {
    if (s === this.status) return;
    this.status = s;
    this.statusListeners.forEach((l) => l(s));
  }

  private onChange = (e: ChangeEvent): void => {
    if (e.origin === 'local' || e.origin === 'undo') {
      this.outbox.push(...e.ops);
      for (const op of e.ops) if (op.k === 'asset' && op.v) void this.ensureUploaded(op.v as PdfAsset);
      this.flush();
    }
    if (e.origin !== 'load') this.scheduleSave();
  };

  private scheduleSave(): void {
    clearTimeout(this.saveTimer);
    this.saveTimer = window.setTimeout(() => void this.saveNow(), 600);
  }

  async saveNow(): Promise<void> {
    clearTimeout(this.saveTimer);
    await this.repo.save(this.doc, this.lastSeq, this.outbox);
  }

  // ───────────── 네트워크 ─────────────

  private connect(): void {
    if (this.closed) return;
    this.setStatus('connecting');
    let ws: WebSocket;
    try {
      ws = new WebSocket(`${this.serverUrl.replace(/\/+$/, '')}/sync`);
    } catch {
      return this.scheduleReconnect();
    }
    this.ws = ws;
    ws.onopen = () => {
      this.retry = 0;
      this.send({ type: 'hello', docId: this.doc.id, clientId: this.doc.clientId, since: this.lastSeq });
      this.flush();
    };
    ws.onmessage = (ev) => this.onMessage(JSON.parse(ev.data as string) as ServerMsg);
    ws.onclose = () => {
      this.ws = null;
      this.inflight.clear(); // 미확인 op 는 outbox 에 남아 있으므로 재접속 후 재전송
      this.scheduleReconnect();
    };
    ws.onerror = () => ws.close();
  }

  private scheduleReconnect(): void {
    if (this.closed) return;
    this.setStatus('offline');
    const delay = Math.min(30000, 1000 * 2 ** this.retry++) * (0.75 + Math.random() * 0.5);
    this.retryTimer = window.setTimeout(() => this.connect(), delay);
  }

  private send(m: ClientMsg): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(m));
  }

  private flush(): void {
    if (this.ws?.readyState !== WebSocket.OPEN) return;
    const sending = new Set<Op>();
    for (const ops of this.inflight.values()) ops.forEach((o) => sending.add(o));
    const ops = this.outbox.filter((o) => !sending.has(o));
    if (!ops.length) {
      if (!this.inflight.size) this.setStatus('synced');
      return;
    }
    this.setStatus('syncing');
    // 너무 큰 메시지를 피하기 위해 나눠 보냄
    for (let i = 0; i < ops.length; i += 500) {
      const batch = newId(10);
      const chunk = ops.slice(i, i + 500);
      this.inflight.set(batch, chunk);
      this.send({ type: 'push', docId: this.doc.id, batch, ops: chunk });
    }
  }

  private onMessage(m: ServerMsg): void {
    if (m.type === 'ops' && m.docId === this.doc.id) {
      if (m.ops.length) {
        this.doc.apply(m.ops, 'remote');
        for (const op of m.ops) if (op.k === 'asset' && op.v) void this.ensureDownloaded((op.v as PdfAsset).id);
      }
      this.lastSeq = Math.max(this.lastSeq, m.seq);
      this.scheduleSave();
      if (!this.inflight.size && !this.outbox.length) this.setStatus('synced');
    } else if (m.type === 'ack' && m.docId === this.doc.id) {
      const acked = this.inflight.get(m.batch);
      this.inflight.delete(m.batch);
      if (acked) {
        const set = new Set(acked);
        this.outbox = this.outbox.filter((o) => !set.has(o));
      }
      // 같은 소켓은 순서 보장 → ack 이전의 다른 기기 변경은 이미 수신됨
      if (!this.inflight.size) this.lastSeq = Math.max(this.lastSeq, m.seq);
      this.scheduleSave();
      this.flush();
    } else if (m.type === 'error') {
      console.warn('sync error', m.message);
    }
  }

  private async ensureUploaded(a: PdfAsset): Promise<void> {
    if (!this.serverUrl || this.uploading.has(a.id)) return;
    this.uploading.add(a.id);
    try {
      const url = `${httpBase(this.serverUrl)}/api/blobs/${a.id}`;
      const head = await fetch(url, { method: 'HEAD' });
      if (head.ok) return;
      const bytes = await this.repo.getBlob(a.id);
      if (bytes) await fetch(url, { method: 'PUT', body: bytes });
    } catch (e) {
      console.warn('PDF 업로드 실패 (다음 접속 때 재시도)', e);
      this.uploading.delete(a.id);
    }
  }

  private async ensureDownloaded(id: string): Promise<void> {
    if (!this.serverUrl || (await this.repo.getBlob(id))) return;
    try {
      const res = await fetch(`${httpBase(this.serverUrl)}/api/blobs/${id}`);
      if (!res.ok) return;
      await this.repo.putBlob(id, await res.arrayBuffer());
      this.onAssetArrived(id);
    } catch (e) {
      console.warn('PDF 다운로드 실패', e);
    }
  }

  async close(): Promise<void> {
    this.closed = true;
    clearTimeout(this.retryTimer);
    this.unsub();
    this.ws?.close();
    await this.saveNow();
  }
}
