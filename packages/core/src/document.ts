import { cmpStamp, LwwStore, type EntityKind, type Op, type Stamp } from './crdt';
import { keyBetween, keysBetween } from './fractional';
import type { BBox } from './geometry';
import { objectBBox } from './hittest';
import { newId } from './ids';
import type { DocMeta, InkObject, Page, PageBackground, PdfAsset } from './model';
import { SpatialGrid } from './spatial';

export type Origin = 'local' | 'undo' | 'remote' | 'load';

export interface ChangeEvent {
  origin: Origin;
  ops: Op[];
  /** 내용이 바뀐 페이지 id (렌더 무효화 범위) */
  pages: Set<string>;
  /** 페이지 목록/메타/에셋 변경 여부 */
  structural: boolean;
}

export interface DocSnapshot {
  id: string;
  ops: Op[];
}

interface Tx {
  put(k: EntityKind, id: string, v: unknown): void;
  del(k: EntityKind, id: string): void;
}

/** undo 한 단계: 각 엔티티의 이전 값과 우리가 마지막으로 쓴 stamp */
interface UndoEntry {
  label: string;
  prev: Map<string, { k: EntityKind; v: unknown | null }>;
  wrote: Map<string, Stamp>;
}

/**
 * InkDocument — 노트 한 권의 상태.
 *
 * 상태의 "진실"은 LwwStore(op 집합)이고, pages/objects/spatial grid 는 거기서 파생된 인덱스다.
 * 모든 변경은 transact() → Op[] 로 표현되어, 로컬 반영·undo 기록·동기화 전송이 하나의 경로를 탄다.
 */
export class InkDocument {
  readonly store = new LwwStore();
  private clock = 0;
  private pageList: Page[] | null = null;
  private objIndex = new Map<string, Map<string, InkObject>>();
  private sortedCache = new Map<string, InkObject[]>();
  private grids = new Map<string, SpatialGrid>();
  private undoStack: UndoEntry[] = [];
  private redoStack: UndoEntry[] = [];
  private group: UndoEntry | null = null;
  private listeners = new Set<(e: ChangeEvent) => void>();

  constructor(
    readonly id: string,
    public clientId: string,
  ) {}

  // ───────────────────────── 조회 ─────────────────────────

  get meta(): DocMeta {
    return (this.store.get('meta')?.v as DocMeta | null) ?? { title: '제목 없음', createdAt: 0 };
  }

  get pages(): Page[] {
    if (!this.pageList) {
      const out: Page[] = [];
      for (const e of this.store.entries.values()) if (e.k === 'page' && e.v) out.push(e.v as Page);
      out.sort((a, b) => (a.order < b.order ? -1 : a.order > b.order ? 1 : a.id < b.id ? -1 : 1));
      this.pageList = out;
    }
    return this.pageList;
  }

  page(id: string): Page | undefined {
    const e = this.store.get(id);
    return e?.k === 'page' && e.v ? (e.v as Page) : undefined;
  }

  object(id: string): InkObject | undefined {
    const e = this.store.get(id);
    return e?.k === 'obj' && e.v ? (e.v as InkObject) : undefined;
  }

  /** z-order 정렬된 페이지 객체 */
  objects(pageId: string): InkObject[] {
    let arr = this.sortedCache.get(pageId);
    if (!arr) {
      arr = [...(this.objIndex.get(pageId)?.values() ?? [])];
      arr.sort((a, b) => a.z - b.z || (a.id < b.id ? -1 : 1));
      this.sortedCache.set(pageId, arr);
    }
    return arr;
  }

  /** bbox 와 겹치는 객체 (공간 인덱스) */
  query(pageId: string, b: BBox): InkObject[] {
    const grid = this.grids.get(pageId);
    const map = this.objIndex.get(pageId);
    if (!grid || !map) return [];
    const out: InkObject[] = [];
    for (const id of grid.query(b)) out.push(map.get(id)!);
    return out;
  }

  assets(): PdfAsset[] {
    const out: PdfAsset[] = [];
    for (const e of this.store.entries.values()) if (e.k === 'asset' && e.v) out.push(e.v as PdfAsset);
    return out;
  }

  /** 새 객체의 z 값 (Lamport 시계를 공유하므로 기기 간 인과 순서 보존) */
  nextZ(): number {
    return ++this.clock;
  }

  // ───────────────────────── 변경 ─────────────────────────

  on(fn: (e: ChangeEvent) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private stamp(): Stamp {
    return { c: ++this.clock, n: this.clientId };
  }

  /** 로컬 변경 트랜잭션. 하나의 undo 단계가 되고, 생성된 op 는 동기화 대상이 된다 */
  transact(label: string, fn: (tx: Tx) => void): Op[] {
    const ops: Op[] = [];
    fn({
      put: (k, id, v) => ops.push({ k, id, s: this.stamp(), v }),
      del: (k, id) => ops.push({ k, id, s: this.stamp(), v: null }),
    });
    if (!ops.length) return ops;

    const entry: UndoEntry = this.group ?? { label, prev: new Map(), wrote: new Map() };
    for (const op of ops) {
      if (!entry.prev.has(op.id)) {
        const cur = this.store.get(op.id);
        entry.prev.set(op.id, { k: op.k, v: cur?.v ?? null });
      }
      entry.wrote.set(op.id, op.s);
    }
    if (!this.group) this.undoStack.push(entry);
    if (this.undoStack.length > 200) this.undoStack.shift();
    this.redoStack = [];
    this.applyInternal(ops, 'local');
    return ops;
  }

  /** 지우개 드래그처럼 여러 트랜잭션을 하나의 undo 단계로 묶는다 */
  beginGroup(label: string): void {
    if (this.group) return;
    this.group = { label, prev: new Map(), wrote: new Map() };
  }

  endGroup(): void {
    const g = this.group;
    this.group = null;
    if (g && g.prev.size) this.undoStack.push(g);
  }

  canUndo(): boolean {
    return this.undoStack.length > 0;
  }

  canRedo(): boolean {
    return this.redoStack.length > 0;
  }

  undo(): void {
    const e = this.undoStack.pop();
    if (e) this.redoStack.push(this.revert(e));
  }

  redo(): void {
    const e = this.redoStack.pop();
    if (e) this.undoStack.push(this.revert(e));
  }

  /**
   * undo/redo 는 "되돌리는 새 op" 를 만든다 → 그대로 동기화되어 다른 기기에도 반영.
   * 그 사이 다른 기기가 같은 객체를 수정했다면(우리 stamp 가 아님) 그 변경을 존중해 건너뛴다.
   */
  private revert(e: UndoEntry): UndoEntry {
    const inverse: UndoEntry = { label: e.label, prev: new Map(), wrote: new Map() };
    const ops: Op[] = [];
    for (const [id, prev] of e.prev) {
      const cur = this.store.get(id);
      const mine = e.wrote.get(id);
      if (cur && mine && cmpStamp(cur.s, mine) !== 0) continue;
      const op: Op = { k: prev.k, id, s: this.stamp(), v: prev.v };
      inverse.prev.set(id, { k: prev.k, v: cur?.v ?? null });
      inverse.wrote.set(id, op.s);
      ops.push(op);
    }
    this.applyInternal(ops, 'undo');
    return inverse;
  }

  /** 원격(서버/다른 기기) op 적용 */
  apply(ops: Op[], origin: Origin = 'remote'): void {
    this.applyInternal(ops, origin);
  }

  private applyInternal(ops: Op[], origin: Origin): void {
    const applied: Op[] = [];
    const pages = new Set<string>();
    let structural = false;
    for (const op of ops) {
      if (op.s.c > this.clock) this.clock = op.s.c;
      const before = this.store.get(op.id);
      if (!this.store.apply(op)) continue;
      applied.push(op);
      if (op.k === 'obj') {
        const old = before?.v as InkObject | null | undefined;
        if (old) this.unindex(old);
        const nw = op.v as InkObject | null;
        if (nw) this.index(nw);
        if (old) pages.add(old.pageId);
        if (nw) pages.add(nw.pageId);
      } else {
        structural = true;
        if (op.k === 'page') {
          this.pageList = null;
          pages.add(op.id);
        }
      }
    }
    if (!applied.length) return;
    const ev: ChangeEvent = { origin, ops: applied, pages, structural };
    for (const l of this.listeners) l(ev);
  }

  private index(o: InkObject): void {
    let m = this.objIndex.get(o.pageId);
    if (!m) this.objIndex.set(o.pageId, (m = new Map()));
    m.set(o.id, o);
    let g = this.grids.get(o.pageId);
    if (!g) this.grids.set(o.pageId, (g = new SpatialGrid()));
    g.insert(o.id, objectBBox(o));
    this.sortedCache.delete(o.pageId);
  }

  private unindex(o: InkObject): void {
    this.objIndex.get(o.pageId)?.delete(o.id);
    this.grids.get(o.pageId)?.remove(o.id);
    this.sortedCache.delete(o.pageId);
  }

  // ───────────────────────── 편의 명령 ─────────────────────────

  setTitle(title: string): void {
    this.transact('제목 변경', (tx) => tx.put('meta', 'meta', { ...this.meta, title }));
  }

  addObjects(objs: InkObject[], label = '그리기'): void {
    this.transact(label, (tx) => objs.forEach((o) => tx.put('obj', o.id, o)));
  }

  updateObjects(objs: InkObject[], label = '수정'): void {
    this.transact(label, (tx) => objs.forEach((o) => tx.put('obj', o.id, o)));
  }

  removeObjects(ids: string[], label = '삭제'): void {
    this.transact(label, (tx) => ids.forEach((id) => tx.del('obj', id)));
  }

  /** afterId 뒤에 페이지 삽입 (null 이면 맨 앞) */
  insertPages(afterId: string | null, specs: Array<Pick<Page, 'width' | 'height' | 'bg'>>, label = '페이지 추가'): Page[] {
    const list = this.pages;
    const idx = afterId === null ? -1 : list.findIndex((p) => p.id === afterId);
    const lo = idx >= 0 ? list[idx].order : null;
    const hi = idx + 1 < list.length ? list[idx + 1].order : null;
    const keys = keysBetween(lo, hi, specs.length);
    const pages = specs.map((s, i) => ({ id: newId(), order: keys[i], ...s }));
    this.transact(label, (tx) => pages.forEach((p) => tx.put('page', p.id, p)));
    return pages;
  }

  deletePage(id: string): void {
    this.transact('페이지 삭제', (tx) => {
      tx.del('page', id);
      for (const o of this.objects(id)) tx.del('obj', o.id);
    });
  }

  /** 페이지를 한 칸 위(-1)/아래(+1)로 이동 */
  movePage(id: string, dir: -1 | 1): void {
    const list = this.pages;
    const i = list.findIndex((p) => p.id === id);
    const j = i + dir;
    if (i < 0 || j < 0 || j >= list.length) return;
    const order =
      dir < 0
        ? keyBetween(list[j - 1]?.order ?? null, list[j].order)
        : keyBetween(list[j].order, list[j + 1]?.order ?? null);
    this.transact('페이지 이동', (tx) => tx.put('page', id, { ...list[i], order }));
  }

  duplicatePage(id: string): void {
    const src = this.page(id);
    if (!src) return;
    const list = this.pages;
    const i = list.findIndex((p) => p.id === id);
    const order = keyBetween(src.order, list[i + 1]?.order ?? null);
    const copy: Page = { ...src, id: newId(), order };
    this.transact('페이지 복제', (tx) => {
      tx.put('page', copy.id, copy);
      for (const o of this.objects(id)) {
        const c = { ...o, id: newId(), pageId: copy.id };
        tx.put('obj', c.id, c);
      }
    });
  }

  setPageBackground(id: string, bg: PageBackground): void {
    const p = this.page(id);
    if (p) this.transact('배경 변경', (tx) => tx.put('page', id, { ...p, bg }));
  }

  addAsset(a: PdfAsset): void {
    this.transact('PDF 추가', (tx) => tx.put('asset', a.id, a));
  }

  // ───────────────────────── 직렬화 ─────────────────────────

  toSnapshot(): DocSnapshot {
    return { id: this.id, ops: this.store.toOps() };
  }

  static fromSnapshot(s: DocSnapshot, clientId: string): InkDocument {
    const d = new InkDocument(s.id, clientId);
    d.apply(s.ops, 'load');
    return d;
  }

  static create(
    clientId: string,
    title: string,
    pages: Array<Pick<Page, 'width' | 'height' | 'bg'>>,
    assets: PdfAsset[] = [],
  ): InkDocument {
    const d = new InkDocument(newId(), clientId);
    const keys = keysBetween(null, null, pages.length);
    d.apply(
      [
        { k: 'meta', id: 'meta', s: { c: 1, n: clientId }, v: { title, createdAt: Date.now() } satisfies DocMeta },
        ...pages.map((p, i): Op => {
          const id = newId();
          return { k: 'page', id, s: { c: 1, n: clientId }, v: { id, order: keys[i], ...p } };
        }),
        ...assets.map((a): Op => ({ k: 'asset', id: a.id, s: { c: 1, n: clientId }, v: a })),
      ],
      'local',
    );
    return d;
  }
}
