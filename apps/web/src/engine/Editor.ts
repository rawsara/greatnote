import {
  A4, TOOL_PRESETS, bboxIntersects, newId, selectionBBox, transformObject, affineTranslate,
  type ChangeEvent, type InkDocument, type InkObject, type InkTool, type Page,
} from '@inknote/core';
import {
  EraserGesture, InkGesture, LassoGesture, RulerGesture, ShapeGesture, TapeGesture, TransformGesture,
  coalescedOf, drawEraserCursor, drawSelectionBox, selectionHit, tapeAt,
} from './gestures';
import type { PdfManager } from './pdf';
import { drawObjects, drawPaper, pageObjects } from './render';
import type { EditorHost, EditorUIState, Gesture, PageRect, RulerState, Selection, SnapLine, ToolId } from './types';

const GAP = 28;
const MIN_ZOOM = 0.25;
const MAX_ZOOM = 8;
const SETTINGS_KEY = 'inknote.tools.v1';
const INK_TOOLS: InkTool[] = ['pen', 'pencil', 'ballpoint', 'marker', 'highlighter', 'underline'];

function defaultState(): EditorUIState {
  const inkStyles = Object.fromEntries(
    INK_TOOLS.map((t) => [t, { color: TOOL_PRESETS[t].defaultColor, width: TOOL_PRESETS[t].defaultWidth }]),
  ) as EditorUIState['inkStyles'];
  const base: EditorUIState = {
    tool: 'pen', inkStyles, eraserMode: 'stroke', eraserSize: 24, shapeKind: 'rect',
    shapeStyle: { color: '#1b1f3b', width: 1.8 }, tapeStyle: { color: '#f59e0b', width: 16 },
    ruler: false, penOnly: false, zoom: 1, currentPageId: null, selection: null,
    canUndo: false, canRedo: false, docVersion: 0,
  };
  try {
    const saved = JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? 'null');
    if (saved) return { ...base, ...saved, inkStyles: { ...inkStyles, ...saved.inkStyles }, selection: null, ruler: false };
  } catch {
    /* 저장소 접근 불가 시 기본값 */
  }
  return base;
}

/**
 * 캔버스 편집기.
 *
 * 렌더 레이어
 *  - base    : 페이지(속지/PDF) + 확정된 벡터 객체. 문서 변경·스크롤·줌 때만 다시 그림
 *  - overlay : 그리는 중인 획, 올가미, 선택 핸들, 자, 지우개 커서.
 *              `desynchronized` 컨텍스트(저지연 캔버스)로 입력 이벤트 안에서 즉시 그린다.
 *
 * 좌표계: screen(CSS px) ⇄ world(페이지 세로 배치) ⇄ page(pt, 객체 저장 좌표)
 */
export class Editor implements EditorHost {
  readonly root: HTMLDivElement;
  private base: HTMLCanvasElement;
  readonly overlay: HTMLCanvasElement;
  private bctx: CanvasRenderingContext2D;
  private octx: CanvasRenderingContext2D;
  private lowLatency: boolean;
  private dpr = 1;
  private cw = 0;
  private ch = 0;
  private originX = 0;
  private originY = 0;

  zoom = 1;
  private panX = 0;
  private panY = 0;
  rects: PageRect[] = [];
  private contentW = 0;
  private contentH = 0;
  private fitted = false;

  private baseDirty = true;
  private raf = 0;
  private gesture: Gesture | null = null;
  private lingering: Gesture | null = null;
  private touches = new Map<number, { x: number; y: number; x0: number; y0: number }>();
  private navInfo = { start: 0, maxTouches: 0, moved: false };
  private mousePan: { id: number; x: number; y: number } | null = null;
  private hover: { x: number; y: number } | null = null;
  private spaceDown = false;

  readonly hidden = new Set<string>();
  readonly ruler: RulerState = { cx: 300, cy: 300, angle: 0, length: 560, thickness: 64 };
  private clipboard: InkObject[] = [];
  private pageVersions = new Map<string, number>();
  state: EditorUIState = defaultState();
  private listeners = new Set<() => void>();
  private cleanup: Array<() => void> = [];

  constructor(
    container: HTMLElement,
    readonly doc: InkDocument,
    readonly pdf: PdfManager,
  ) {
    this.root = document.createElement('div');
    this.root.className = 'editor-root';
    this.base = document.createElement('canvas');
    this.overlay = document.createElement('canvas');
    this.base.className = 'editor-layer';
    this.overlay.className = 'editor-layer';
    this.root.append(this.base, this.overlay);
    container.append(this.root);

    this.bctx = this.base.getContext('2d', { alpha: false })!;
    this.octx = this.overlay.getContext('2d', { desynchronized: true })!;
    this.lowLatency = !!this.octx.getContextAttributes?.().desynchronized;

    const on = <K extends keyof HTMLElementEventMap>(el: EventTarget, type: K | string, fn: (e: never) => void, opts?: AddEventListenerOptions) => {
      el.addEventListener(type, fn as EventListener, opts);
      this.cleanup.push(() => el.removeEventListener(type, fn as EventListener, opts));
    };
    on(this.overlay, 'pointerdown', this.onDown);
    on(this.overlay, 'pointermove', this.onMove);
    on(this.overlay, 'pointerup', this.onUp);
    on(this.overlay, 'pointercancel', this.onCancel);
    on(this.overlay, 'pointerleave', () => {
      this.hover = null;
      this.schedule();
    });
    on(this.overlay, 'wheel', this.onWheel, { passive: false });
    on(this.overlay, 'contextmenu', (e: Event) => e.preventDefault());
    // iOS Safari: 롱프레스 확대경/선택 방지
    on(this.overlay, 'touchstart', (e: Event) => e.preventDefault(), { passive: false });
    on(window, 'keydown', this.onKey);
    on(window, 'keyup', (e: KeyboardEvent) => e.code === 'Space' && (this.spaceDown = false));

    this.cleanup.push(doc.on(this.onDocChange));
    this.cleanup.push(pdf.onUpdate(() => this.invalidate(true)));
    const ro = new ResizeObserver(() => this.resize());
    ro.observe(container);
    this.cleanup.push(() => ro.disconnect());
    this.relayout();
    this.syncState({ canUndo: doc.canUndo(), canRedo: doc.canRedo() });
  }

  destroy(): void {
    cancelAnimationFrame(this.raf);
    this.cleanup.forEach((f) => f());
    this.root.remove();
  }

  // ───────────────────────── 상태 (React 연동) ─────────────────────────

  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };

  getState = (): EditorUIState => this.state;

  private syncState(patch: Partial<EditorUIState>): void {
    let changed = false;
    for (const k in patch) if ((patch as Record<string, unknown>)[k] !== (this.state as unknown as Record<string, unknown>)[k]) changed = true;
    if (!changed) return;
    this.state = { ...this.state, ...patch };
    this.listeners.forEach((l) => l());
  }

  update(patch: Partial<EditorUIState>): void {
    if (patch.tool && patch.tool !== 'lasso' && this.state.selection) patch.selection = null;
    if (patch.ruler && !this.state.ruler) this.centerRuler();
    this.syncState(patch);
    try {
      const { inkStyles, eraserMode, eraserSize, shapeKind, shapeStyle, tapeStyle, tool, penOnly } = this.state;
      localStorage.setItem(SETTINGS_KEY, JSON.stringify({ inkStyles, eraserMode, eraserSize, shapeKind, shapeStyle, tapeStyle, tool, penOnly }));
    } catch {
      /* ignore */
    }
    this.schedule();
  }

  setInkStyle(tool: InkTool, patch: Partial<{ color: string; width: number }>): void {
    this.update({ inkStyles: { ...this.state.inkStyles, [tool]: { ...this.state.inkStyles[tool], ...patch } } });
  }

  pageVersion(id: string): number {
    return this.pageVersions.get(id) ?? 0;
  }

  // ───────────────────────── 레이아웃 / 좌표 ─────────────────────────

  private resize(): void {
    const r = this.root.getBoundingClientRect();
    this.originX = r.left;
    this.originY = r.top;
    this.cw = r.width;
    this.ch = r.height;
    this.dpr = Math.min(window.devicePixelRatio || 1, 3);
    for (const c of [this.base, this.overlay]) {
      c.width = Math.round(this.cw * this.dpr);
      c.height = Math.round(this.ch * this.dpr);
    }
    if (!this.fitted && this.cw > 0 && this.rects.length) {
      this.fitWidth();
      this.fitted = true;
    }
    this.clampPan();
    this.invalidate(true);
  }

  private relayout(): void {
    const pages = this.doc.pages;
    const maxW = pages.reduce<number>((m, p) => Math.max(m, p.width), A4.width);
    let y = GAP;
    this.rects = pages.map((page) => {
      const r = { page, x: GAP + (maxW - page.width) / 2, y };
      y += page.height + GAP;
      return r;
    });
    this.contentW = maxW + GAP * 2;
    this.contentH = y;
    if (!this.fitted && this.cw > 0 && this.rects.length) {
      this.fitWidth();
      this.fitted = true;
    }
    this.clampPan();
  }

  fitWidth(): void {
    const maxW = this.contentW - GAP * 2;
    this.zoom = Math.max(MIN_ZOOM, Math.min((this.cw - 24) / (maxW + GAP), 1.6));
    this.panX = 0;
    this.panY = 0;
    this.clampPan();
    this.afterViewportChange();
  }

  private clampPan(): void {
    const w = this.contentW * this.zoom, h = this.contentH * this.zoom;
    this.panX = w <= this.cw ? (this.cw - w) / 2 : Math.min(0, Math.max(this.cw - w, this.panX));
    this.panY = h <= this.ch ? 0 : Math.min(0, Math.max(this.ch - h, this.panY));
  }

  local(e: PointerEvent | WheelEvent): [number, number] {
    return [e.clientX - this.originX, e.clientY - this.originY];
  }

  toPage(rect: PageRect, sx: number, sy: number): [number, number] {
    return [(sx - this.panX) / this.zoom - rect.x, (sy - this.panY) / this.zoom - rect.y];
  }

  pageToScreen(rect: PageRect, x: number, y: number): [number, number] {
    return [this.panX + (rect.x + x) * this.zoom, this.panY + (rect.y + y) * this.zoom];
  }

  pageTransform(ctx: CanvasRenderingContext2D, rect: PageRect): void {
    const k = this.dpr * this.zoom;
    ctx.setTransform(k, 0, 0, k, this.dpr * (this.panX + rect.x * this.zoom), this.dpr * (this.panY + rect.y * this.zoom));
  }

  private rectAt(sx: number, sy: number): PageRect | null {
    const wx = (sx - this.panX) / this.zoom, wy = (sy - this.panY) / this.zoom;
    for (const r of this.rects) if (wx >= r.x && wx <= r.x + r.page.width && wy >= r.y && wy <= r.y + r.page.height) return r;
    return null;
  }

  private rectOf(pageId: string): PageRect | undefined {
    return this.rects.find((r) => r.page.id === pageId);
  }

  zoomAt(sx: number, sy: number, z: number): void {
    z = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, z));
    const wx = (sx - this.panX) / this.zoom, wy = (sy - this.panY) / this.zoom;
    this.zoom = z;
    this.panX = sx - wx * z;
    this.panY = sy - wy * z;
    this.clampPan();
    this.afterViewportChange();
  }

  zoomBy(f: number): void {
    this.zoomAt(this.cw / 2, this.ch / 2, this.zoom * f);
  }

  private panBy(dx: number, dy: number): void {
    this.panX += dx;
    this.panY += dy;
    this.clampPan();
    this.afterViewportChange();
  }

  scrollToPage(id: string): void {
    const r = this.rectOf(id);
    if (!r) return;
    this.panY = -(r.y - GAP / 2) * this.zoom;
    this.clampPan();
    this.afterViewportChange();
  }

  private afterViewportChange(): void {
    const cy = (this.ch / 2 - this.panY) / this.zoom;
    let cur = this.rects[0]?.page.id ?? null;
    for (const r of this.rects) if (r.y - GAP <= cy) cur = r.page.id;
    this.syncState({ zoom: Math.round(this.zoom * 100) / 100, currentPageId: cur });
    this.invalidate(true);
  }

  // ───────────────────────── 렌더링 ─────────────────────────

  invalidate(base = false): void {
    if (base) this.baseDirty = true;
    this.schedule();
  }

  private schedule(): void {
    if (!this.raf) this.raf = requestAnimationFrame(this.frame);
  }

  private frame = (): void => {
    this.raf = 0;
    if (this.baseDirty) {
      this.baseDirty = false;
      this.renderBase();
    }
    this.renderOverlay();
    // 펜을 뗀 획은 base 에 그려진 다음 프레임까지 overlay 에 남겨 깜빡임 방지
    if (this.lingering) {
      this.lingering = null;
      this.schedule();
    }
  };

  private renderBase(): void {
    const ctx = this.bctx;
    const { dpr, zoom } = this;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = '#ece9e3';
    ctx.fillRect(0, 0, this.base.width, this.base.height);
    const vx0 = -this.panX / zoom, vy0 = -this.panY / zoom;
    const view = { minX: vx0, minY: vy0, maxX: vx0 + this.cw / zoom, maxY: vy0 + this.ch / zoom };

    for (const rect of this.rects) {
      const { page } = rect;
      const pb = { minX: rect.x, minY: rect.y, maxX: rect.x + page.width, maxY: rect.y + page.height };
      if (!bboxIntersects(pb, view)) continue;
      // 그림자
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      const [sx, sy] = this.pageToScreen(rect, 0, 0);
      ctx.fillStyle = 'rgba(0,0,0,0.10)';
      ctx.fillRect(sx + 1, sy + 2, page.width * zoom + 2, page.height * zoom + 2);

      this.pageTransform(ctx, rect);
      ctx.save();
      ctx.beginPath();
      ctx.rect(0, 0, page.width, page.height);
      ctx.clip();
      this.drawBackground(ctx, page, zoom * dpr);
      const local = { minX: view.minX - rect.x, minY: view.minY - rect.y, maxX: view.maxX - rect.x, maxY: view.maxY - rect.y };
      drawObjects(ctx, pageObjects(this.doc, page, local), this.hidden);
      ctx.restore();
    }
  }

  drawBackground(ctx: CanvasRenderingContext2D, page: Page, pixelScale: number): void {
    if (page.bg.kind === 'pdf') {
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, page.width, page.height);
      const bm = this.pdf.getBitmap(page.bg.assetId, page.bg.pageIndex, pixelScale, page.width, page.height);
      if (bm) {
        ctx.imageSmoothingQuality = 'high';
        ctx.drawImage(bm.canvas, 0, 0, page.width, page.height);
      }
    } else {
      drawPaper(ctx, page, page.bg.kind, pixelScale / this.dpr);
    }
  }

  /** 사이드바 썸네일 렌더 */
  renderThumbnail(canvas: HTMLCanvasElement, pageId: string): void {
    const page = this.doc.page(pageId);
    const ctx = canvas.getContext('2d');
    if (!page || !ctx) return;
    const s = canvas.width / page.width;
    canvas.height = Math.round(page.height * s);
    ctx.setTransform(s, 0, 0, s, 0, 0);
    this.drawBackground(ctx, page, s);
    drawObjects(ctx, this.doc.objects(pageId));
  }

  private renderOverlay(): void {
    const ctx = this.octx;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this.overlay.width, this.overlay.height);
    const multiply = !!(this.gesture?.blendMultiply || this.lingering?.blendMultiply);
    const mode = multiply ? 'multiply' : 'normal';
    if (this.overlay.style.mixBlendMode !== mode) this.overlay.style.mixBlendMode = mode;

    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    if (this.state.ruler) this.drawRuler(ctx);

    const sel = this.state.selection;
    if (sel && !(this.gesture instanceof TransformGesture)) {
      const rect = this.rectOf(sel.pageId);
      const objs = sel.ids.map((id) => this.doc.object(id)).filter((o): o is InkObject => !!o);
      if (rect && objs.length) drawSelectionBox(ctx, this, rect, selectionBBox(objs));
    }
    for (const g of [this.lingering, this.gesture]) {
      if (!g) continue;
      ctx.save();
      g.drawOverlay(ctx);
      ctx.restore();
      ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    }
    if (this.hover && !this.gesture && this.state.tool === 'eraser') {
      drawEraserCursor(ctx, this.hover.x, this.hover.y, this.state.eraserSize / 2);
    }
  }

  /** 입력 이벤트 안에서 overlay 즉시 갱신 (저지연 캔버스 지원 시) */
  private drawNow(): void {
    if (this.lowLatency && !this.baseDirty) {
      this.renderOverlay();
    } else this.schedule();
  }

  // ───────────────────────── 자(ruler) ─────────────────────────

  private centerRuler(): void {
    this.ruler.cx = (this.cw / 2 - this.panX) / this.zoom;
    this.ruler.cy = (this.ch / 2 - this.panY) / this.zoom;
    this.ruler.angle = 0;
  }

  rulerMoved(): void {
    this.schedule();
  }

  private rulerScreen(): { cx: number; cy: number; ux: number; uy: number; L: number; T: number } {
    const r = this.ruler;
    return {
      cx: this.panX + r.cx * this.zoom,
      cy: this.panY + r.cy * this.zoom,
      ux: Math.cos(r.angle),
      uy: Math.sin(r.angle),
      L: Math.min(r.length, Math.max(this.cw, this.ch) * 1.2),
      T: r.thickness,
    };
  }

  private rulerHit(sx: number, sy: number): 'move' | 'rotate' | null {
    const { cx, cy, ux, uy, L, T } = this.rulerScreen();
    const dx = sx - cx, dy = sy - cy;
    const along = dx * ux + dy * uy, across = -dx * uy + dy * ux;
    const kx = cx + ux * (L / 2 - 30), ky = cy + uy * (L / 2 - 30);
    if (Math.hypot(sx - kx, sy - ky) < 22) return 'rotate';
    if (Math.abs(along) <= L / 2 && Math.abs(across) <= T / 2) return 'move';
    return null;
  }

  rulerSnapLine(rect: PageRect, sx: number, sy: number): SnapLine | null {
    if (!this.state.ruler) return null;
    const { cx, cy, ux, uy, L, T } = this.rulerScreen();
    const dx = sx - cx, dy = sy - cy;
    const along = dx * ux + dy * uy, across = -dx * uy + dy * ux;
    if (Math.abs(along) > L / 2 + 40) return null;
    const off = Math.abs(across) - T / 2;
    if (off < -2 || off > 28) return null;
    const side = Math.sign(across) || 1;
    const nx = -uy * side, ny = ux * side;
    // 자 가장자리 직선(화면) → 페이지 좌표
    const ex = cx + nx * (T / 2), ey = cy + ny * (T / 2);
    const [ax, ay] = this.toPage(rect, ex, ey);
    return { ax, ay, dx: ux, dy: uy };
  }

  private drawRuler(ctx: CanvasRenderingContext2D): void {
    const { cx, cy, L, T } = this.rulerScreen();
    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(this.ruler.angle);
    ctx.fillStyle = 'rgba(245,245,240,0.82)';
    ctx.strokeStyle = 'rgba(60,60,60,0.55)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.roundRect(-L / 2, -T / 2, L, T, 8);
    ctx.fill();
    ctx.stroke();
    // 눈금: 1mm 단위(현재 줌 기준)
    const mm = (72 / 25.4) * this.zoom;
    if (mm > 2.5) {
      ctx.beginPath();
      const n = Math.floor(L / 2 / mm);
      for (let i = -n; i <= n; i++) {
        const x = i * mm;
        const h = i % 10 === 0 ? 14 : i % 5 === 0 ? 9 : 5;
        ctx.moveTo(x, -T / 2);
        ctx.lineTo(x, -T / 2 + h);
        ctx.moveTo(x, T / 2);
        ctx.lineTo(x, T / 2 - h);
      }
      ctx.stroke();
    }
    ctx.fillStyle = '#333';
    ctx.font = '600 13px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const deg = ((Math.round((-this.ruler.angle * 180) / Math.PI) % 360) + 360) % 360;
    ctx.fillText(`${deg}°`, 0, 0);
    // 회전 손잡이
    ctx.beginPath();
    ctx.arc(L / 2 - 30, 0, 13, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(37,99,235,0.15)';
    ctx.fill();
    ctx.strokeStyle = '#2563eb';
    ctx.stroke();
    ctx.fillStyle = '#2563eb';
    ctx.fillText('↻', L / 2 - 30, 1);
    ctx.restore();
  }

  // ───────────────────────── 선택 ─────────────────────────

  setSelection(sel: Selection | null): void {
    this.syncState({ selection: sel });
    this.schedule();
  }

  setHidden(ids: string[]): void {
    this.hidden.clear();
    ids.forEach((id) => this.hidden.add(id));
    this.invalidate(true);
  }

  private selectedObjects(): InkObject[] {
    const sel = this.state.selection;
    return sel ? sel.ids.map((id) => this.doc.object(id)).filter((o): o is InkObject => !!o) : [];
  }

  deleteSelection(): void {
    const sel = this.state.selection;
    if (!sel) return;
    this.doc.removeObjects(sel.ids, '선택 삭제');
    this.setSelection(null);
  }

  recolorSelection(color: string): void {
    const objs = this.selectedObjects();
    if (objs.length) this.doc.updateObjects(objs.map((o) => ({ ...o, color })), '색상 변경');
  }

  copySelection(): void {
    this.clipboard = this.selectedObjects();
  }

  duplicateSelection(): void {
    this.copySelection();
    this.paste(16);
  }

  /** 클립보드 객체를 현재 페이지에 붙여넣기 (새 id, 새 z) */
  paste(offset = 16): void {
    if (!this.clipboard.length) return;
    const sel = this.state.selection;
    const pageId = sel?.pageId ?? this.state.currentPageId;
    if (!pageId) return;
    const m = affineTranslate(offset, offset);
    const copies = this.clipboard.map((o) => ({ ...transformObject(o, m), id: newId(), pageId, z: this.doc.nextZ() }));
    this.doc.addObjects(copies, '붙여넣기');
    this.clipboard = copies;
    this.setSelection({ pageId, ids: copies.map((c) => c.id) });
  }

  setAllTapes(revealed: boolean): void {
    const pid = this.state.currentPageId;
    if (!pid) return;
    const tapes = this.doc.objects(pid).filter((o) => o.type === 'tape' && o.revealed !== revealed);
    if (tapes.length) this.doc.updateObjects(tapes.map((t) => ({ ...t, revealed } as InkObject)), '테이프');
  }

  undo(): void {
    this.setSelection(null);
    this.doc.undo();
  }

  redo(): void {
    this.setSelection(null);
    this.doc.redo();
  }

  // ───────────────────────── 입력 ─────────────────────────

  private onDocChange = (e: ChangeEvent): void => {
    if (e.structural) this.relayout();
    for (const pid of e.pages) this.pageVersions.set(pid, this.pageVersion(pid) + 1);
    const sel = this.state.selection;
    let selection = sel;
    if (sel) {
      const ids = sel.ids.filter((id) => this.doc.object(id));
      selection = ids.length ? (ids.length === sel.ids.length ? sel : { ...sel, ids }) : null;
    }
    this.syncState({
      canUndo: this.doc.canUndo(),
      canRedo: this.doc.canRedo(),
      selection,
      docVersion: this.state.docVersion + 1,
    });
    this.invalidate(true);
  };

  private createGesture(e: PointerEvent, sx: number, sy: number): Gesture | null {
    const tool: ToolId = this.state.tool;
    if (this.state.ruler) {
      const hit = this.rulerHit(sx, sy);
      if (hit) {
        const sc = () => {
          const r = this.rulerScreen();
          return [r.cx, r.cy] as [number, number];
        };
        return new RulerGesture(this, e, hit, sc);
      }
    }
    if (tool === 'lasso' && this.state.selection) {
      const rect = this.rectOf(this.state.selection.pageId);
      const objs = this.selectedObjects();
      if (rect && objs.length) {
        const hit = selectionHit(this, rect, selectionBBox(objs), sx, sy);
        if (hit !== null) return new TransformGesture(this, e, rect, this.state.selection.ids, hit);
      }
      this.setSelection(null);
    }
    const rect = this.rectAt(sx, sy);
    if (!rect) return null;
    switch (tool) {
      case 'eraser':
        return new EraserGesture(this, e, rect);
      case 'lasso':
        return new LassoGesture(this, e, rect);
      case 'shape':
        return new ShapeGesture(this, e, rect);
      case 'tape':
        return new TapeGesture(this, e, rect);
      default:
        return new InkGesture(this, e, rect, tool);
    }
  }

  private onDown = (e: PointerEvent): void => {
    const [x, y] = this.local(e);
    if (e.pointerType === 'pen' && !this.state.penOnly) this.update({ penOnly: true });

    if (e.pointerType === 'touch') {
      // 팜 리젝션: 펜으로 쓰는 중에는 손바닥 터치 무시
      if (this.gesture?.pointerType === 'pen') return;
      this.capture(e.pointerId);
      this.touches.set(e.pointerId, { x, y, x0: x, y0: y });
      if (this.touches.size === 1) this.navInfo = { start: e.timeStamp, maxTouches: 1, moved: false };
      this.navInfo.maxTouches = Math.max(this.navInfo.maxTouches, this.touches.size);
      if (this.touches.size >= 2) {
        // 손가락 필기 중 두 번째 손가락 → 필기 취소 후 핀치 줌
        if (this.gesture?.pointerType === 'touch') {
          this.gesture.cancel();
          this.gesture = null;
          this.schedule();
        }
        return;
      }
      if (this.state.penOnly) return; // 펜 사용 중: 손가락은 스크롤 전용
      // 손가락 필기 모드 → 아래에서 제스처 시작
    }

    if (e.pointerType === 'mouse' && (e.button === 1 || e.button === 2 || this.spaceDown)) {
      this.mousePan = { id: e.pointerId, x, y };
      this.capture(e.pointerId);
      return;
    }
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    if (this.gesture) return;
    this.gesture = this.createGesture(e, x, y);
    if (this.gesture) {
      this.capture(e.pointerId);
      this.drawNow();
    }
  };

  private capture(id: number): void {
    try {
      this.overlay.setPointerCapture(id);
    } catch {
      /* 합성 이벤트 등 활성 포인터가 아닌 경우 */
    }
  }

  private onMove = (e: PointerEvent): void => {
    const g = this.gesture;
    if (g && g.pointerId === e.pointerId) {
      const t = this.touches.get(e.pointerId);
      if (t) [t.x, t.y] = this.local(e);
      g.move(e, coalescedOf(e), e.getPredictedEvents?.() ?? []);
      this.drawNow();
      return;
    }
    if (this.touches.has(e.pointerId)) return this.touchMove(e);
    const [x, y] = this.local(e);
    if (this.mousePan?.id === e.pointerId) {
      this.panBy(x - this.mousePan.x, y - this.mousePan.y);
      this.mousePan.x = x;
      this.mousePan.y = y;
      return;
    }
    if (!g && e.pointerType !== 'touch' && this.state.tool === 'eraser') {
      this.hover = { x, y };
      this.schedule();
    }
  };

  private onUp = (e: PointerEvent): void => {
    const g = this.gesture;
    if (g && g.pointerId === e.pointerId) {
      this.touches.delete(e.pointerId);
      this.gesture = null;
      g.up(e);
      this.lingering = g;
      this.schedule();
      return;
    }
    if (this.touches.has(e.pointerId)) {
      this.touches.delete(e.pointerId);
      if (this.touches.size === 0) this.touchEnd(e);
      return;
    }
    if (this.mousePan?.id === e.pointerId) this.mousePan = null;
  };

  private onCancel = (e: PointerEvent): void => {
    this.touches.delete(e.pointerId);
    if (this.gesture?.pointerId === e.pointerId) {
      this.gesture.cancel();
      this.gesture = null;
      this.schedule();
    }
  };

  /** 손가락: 1개 = 스크롤, 2개 = 핀치 줌 + 이동 */
  private touchMove(e: PointerEvent): void {
    const t = this.touches.get(e.pointerId)!;
    const before = this.touchFrame();
    [t.x, t.y] = this.local(e);
    if (Math.hypot(t.x - t.x0, t.y - t.y0) > 8) this.navInfo.moved = true;
    const after = this.touchFrame();
    if (!before || !after) return;
    if (before.d > 0 && after.d > 0) {
      const z = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, this.zoom * (after.d / before.d)));
      const wx = (before.mx - this.panX) / this.zoom, wy = (before.my - this.panY) / this.zoom;
      this.zoom = z;
      this.panX = after.mx - wx * z;
      this.panY = after.my - wy * z;
      this.clampPan();
      this.afterViewportChange();
    } else this.panBy(after.mx - before.mx, after.my - before.my);
  }

  private touchFrame(): { mx: number; my: number; d: number } | null {
    const pts = [...this.touches.values()];
    if (!pts.length) return null;
    if (pts.length === 1) return { mx: pts[0].x, my: pts[0].y, d: 0 };
    const [a, b] = pts;
    return { mx: (a.x + b.x) / 2, my: (a.y + b.y) / 2, d: Math.hypot(a.x - b.x, a.y - b.y) };
  }

  private touchEnd(e: PointerEvent): void {
    const { start, maxTouches, moved } = this.navInfo;
    if (moved || e.timeStamp - start > 350) return;
    if (maxTouches === 2) return this.undo(); // 두 손가락 탭 = 실행 취소
    if (maxTouches === 1) {
      // 한 손가락 탭: 테이프 가림/보임 토글
      const [sx, sy] = this.local(e);
      const rect = this.rectAt(sx, sy);
      if (!rect) return;
      const [px, py] = this.toPage(rect, sx, sy);
      const tape = tapeAt(this, rect.page.id, px, py);
      if (tape) this.doc.updateObjects([{ ...tape, revealed: !tape.revealed }], '테이프');
    }
  }

  private onWheel = (e: WheelEvent): void => {
    e.preventDefault();
    const [x, y] = this.local(e);
    if (e.ctrlKey || e.metaKey) this.zoomAt(x, y, this.zoom * Math.exp(-e.deltaY * 0.0045));
    else this.panBy(-e.deltaX, -e.deltaY);
  };

  private onKey = (e: KeyboardEvent): void => {
    const target = e.target as HTMLElement | null;
    if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) return;
    const mod = e.ctrlKey || e.metaKey;
    if (e.code === 'Space') {
      this.spaceDown = true;
      e.preventDefault();
      return;
    }
    if (mod && e.key.toLowerCase() === 'z') {
      e.preventDefault();
      if (e.shiftKey) this.redo();
      else this.undo();
    } else if (mod && e.key.toLowerCase() === 'y') {
      e.preventDefault();
      this.redo();
    } else if (mod && e.key.toLowerCase() === 'c') this.copySelection();
    else if (mod && e.key.toLowerCase() === 'v') this.paste();
    else if (mod && e.key.toLowerCase() === 'd') {
      e.preventDefault();
      this.duplicateSelection();
    } else if ((e.key === 'Delete' || e.key === 'Backspace') && this.state.selection) this.deleteSelection();
    else if (e.key === 'Escape') this.setSelection(null);
    else if (!mod) {
      const map: Record<string, ToolId> = { p: 'pen', b: 'ballpoint', n: 'pencil', m: 'marker', h: 'highlighter', u: 'underline', e: 'eraser', l: 'lasso', s: 'shape', t: 'tape' };
      const tool = map[e.key.toLowerCase()];
      if (tool) this.update({ tool });
    }
  };
}
