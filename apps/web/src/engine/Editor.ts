import {
  A4, TOOL_PRESETS, bboxIntersects, isHighlighter, newId, objectBBox, selectionBBox, transformObject, affineTranslate,
  type ChangeEvent, type ImageObj, type InkDocument, type InkObject, type InkTool, type Page, type TextLine, type TextObj,
} from '@inknote/core';
import {
  EraserGesture, InkGesture, LassoGesture, RulerGesture, ShapeGesture, TapeGesture, TextGesture, TransformGesture,
  PT_PER_CM, coalescedOf, drawEraserCursor, drawSelectionBox, selectionHit, tapeAt,
} from './gestures';
import type { ImageManager } from './images';
import type { PdfManager } from './pdf';
import { TEXT_FONT, TEXT_LINE, drawInkLayer, drawObject, drawObjects, drawPaper, drawUnderLayer, layoutText, pageObjects } from './render';
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
    textStyle: { color: '#1b1f3b', size: 16 },
    ruler: false, penOnly: false, zoom: 1, currentPageId: null, selection: null,
    canUndo: false, canRedo: false, docVersion: 0, clipboardCount: 0,
  };
  try {
    const saved = JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? 'null');
    if (saved) return { ...base, ...saved, inkStyles: { ...inkStyles, ...saved.inkStyles }, textStyle: saved.textStyle ?? base.textStyle, selection: null, ruler: false, clipboardCount: 0 };
  } catch {
    /* 저장소 접근 불가 시 기본값 */
  }
  return base;
}

/**
 * 캔버스 편집기.
 *
 * 렌더 레이어 (아래 → 위, 4층)
 *  1. bg   : 책상 배경 + 속지/PDF + 형광펜 (multiply 로 PDF 글자와 섞여 글씨를 가리지 않음)
 *  2. ink  : 확정된 펜 획·도형·테이프
 *  3. live : 지금 그리는 획만 (`desynchronized` 저지연 캔버스, 입력 이벤트 안에서 즉시 그림)
 *  4. ui   : 자, 올가미 경로, 선택 상자/핸들, 지우개 커서, 길이 표시 (입력 이벤트 수신)
 *
 *  - 그리는 중에는 live 레이어의 현재 획만 다시 그린다.
 *  - 펜을 떼면 새 획을 ink(형광펜은 bg) 레이어에 "덧그린다" — 문서 전체를 다시 그리지 않음.
 *  - bg/ink 전체 다시 그리기는 스크롤·줌·원격 변경·삭제처럼 기존 내용이 바뀔 때만.
 *
 * 좌표계: screen(CSS px) ⇄ world(페이지 세로 배치) ⇄ page(pt, 객체 저장 좌표)
 */
export class Editor implements EditorHost {
  readonly root: HTMLDivElement;
  private bgCanvas: HTMLCanvasElement;
  private inkCanvas: HTMLCanvasElement;
  private liveCanvas: HTMLCanvasElement;
  /** 최상단 ui 레이어 — 포인터 이벤트를 받는다 */
  readonly overlay: HTMLCanvasElement;
  private bgctx: CanvasRenderingContext2D;
  private ictx: CanvasRenderingContext2D;
  private lctx: CanvasRenderingContext2D;
  private uctx: CanvasRenderingContext2D;
  private lowLatency: boolean;
  /** 렌더링 통계 (성능 확인/테스트용) */
  readonly stats = { bgFull: 0, inkFull: 0, incremental: 0 };
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

  private bgDirty = true;
  private inkDirty = true;
  private liveClean = false;
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
    readonly images?: ImageManager,
  ) {
    this.root = document.createElement('div');
    this.root.className = 'editor-root';
    const layer = (name: string) => {
      const c = document.createElement('canvas');
      c.className = `editor-layer layer-${name}`;
      this.root.append(c);
      return c;
    };
    this.bgCanvas = layer('bg');
    this.inkCanvas = layer('ink');
    this.liveCanvas = layer('live');
    this.overlay = layer('ui');
    container.append(this.root);

    this.bgctx = this.bgCanvas.getContext('2d', { alpha: false })!;
    this.ictx = this.inkCanvas.getContext('2d')!;
    this.lctx = this.liveCanvas.getContext('2d', { desynchronized: true })!;
    this.uctx = this.overlay.getContext('2d')!;
    this.lowLatency = !!this.lctx.getContextAttributes?.().desynchronized;

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
    this.cleanup.push(pdf.onUpdate(() => {
      this.bgDirty = true;
      this.schedule();
    }));
    if (images) this.cleanup.push(images.onUpdate(() => this.invalidate(true)));
    // 다크 모드 전환 시 책상 색 다시 그리기
    const mo = new MutationObserver(() => this.invalidate(true));
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const onScheme = () => this.invalidate(true);
    mq.addEventListener('change', onScheme);
    this.cleanup.push(() => {
      mo.disconnect();
      mq.removeEventListener('change', onScheme);
    });
    const ro = new ResizeObserver(() => this.resize());
    ro.observe(container);
    this.cleanup.push(() => ro.disconnect());
    this.relayout();
    this.syncState({ canUndo: doc.canUndo(), canRedo: doc.canRedo() });
  }

  destroy(): void {
    this.commitTextEdit();
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
    if (patch.tool && patch.tool !== this.state.tool) this.commitTextEdit();
    if (patch.ruler && !this.state.ruler) this.centerRuler();
    // 밑줄 도구 선택 시 보이는 PDF 페이지의 글자 줄을 미리 추출
    if (patch.tool === 'underline') {
      const view = this.viewRect();
      for (const r of this.rects) if (r.y < view.maxY && r.y + r.page.height > view.minY) this.textLines(r.page);
    }
    this.syncState(patch);
    try {
      const { inkStyles, eraserMode, eraserSize, shapeKind, shapeStyle, tapeStyle, textStyle, tool, penOnly } = this.state;
      localStorage.setItem(SETTINGS_KEY, JSON.stringify({ inkStyles, eraserMode, eraserSize, shapeKind, shapeStyle, tapeStyle, textStyle, tool, penOnly }));
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
    for (const c of [this.bgCanvas, this.inkCanvas, this.liveCanvas, this.overlay]) {
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
    this.positionTextEditor();
    this.invalidate(true);
  }

  // ───────────────────────── 렌더링 ─────────────────────────

  invalidate(base = false): void {
    if (base) this.bgDirty = this.inkDirty = true;
    this.schedule();
  }

  /** 타이머 등 입력 이벤트 밖에서 live/ui 갱신 */
  requestDraw(): void {
    this.schedule();
  }

  private schedule(): void {
    if (!this.raf) this.raf = requestAnimationFrame(this.frame);
  }

  private frame = (): void => {
    this.raf = 0;
    if (this.bgDirty) this.renderBg();
    if (this.inkDirty) this.renderInk();
    if (!this.liveClean) this.renderLive();
    this.liveClean = false;
    this.renderUI();
    // 펜을 뗀 획은 ink 레이어에 그려진 다음 프레임까지 live 에 남겨 깜빡임 방지
    if (this.lingering) {
      this.lingering = null;
      this.schedule();
    }
  };

  private viewRect() {
    const vx0 = -this.panX / this.zoom, vy0 = -this.panY / this.zoom;
    return { minX: vx0, minY: vy0, maxX: vx0 + this.cw / this.zoom, maxY: vy0 + this.ch / this.zoom };
  }

  /** 화면에 보이는 페이지마다 (페이지 좌표 변환 + 클립 + 보이는 영역) 콜백 */
  private forVisiblePages(ctx: CanvasRenderingContext2D, fn: (rect: PageRect, local: { minX: number; minY: number; maxX: number; maxY: number }) => void): void {
    const view = this.viewRect();
    for (const rect of this.rects) {
      const { page } = rect;
      if (!bboxIntersects({ minX: rect.x, minY: rect.y, maxX: rect.x + page.width, maxY: rect.y + page.height }, view)) continue;
      this.pageTransform(ctx, rect);
      ctx.save();
      ctx.beginPath();
      ctx.rect(0, 0, page.width, page.height);
      ctx.clip();
      fn(rect, { minX: view.minX - rect.x, minY: view.minY - rect.y, maxX: view.maxX - rect.x, maxY: view.maxY - rect.y });
      ctx.restore();
    }
  }

  private cssVar(name: string, fallback: string): string {
    return getComputedStyle(this.root).getPropertyValue(name).trim() || fallback;
  }

  /** 1층: 책상 + 속지/PDF + 형광펜 */
  private renderBg(): void {
    this.bgDirty = false;
    this.stats.bgFull++;
    const ctx = this.bgctx;
    const { dpr, zoom } = this;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = this.cssVar('--desk', '#ece9e3');
    ctx.fillRect(0, 0, this.bgCanvas.width, this.bgCanvas.height);
    const view = this.viewRect();
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = this.cssVar('--page-shadow', 'rgba(0,0,0,0.10)');
    for (const rect of this.rects) {
      const { page } = rect;
      if (!bboxIntersects({ minX: rect.x, minY: rect.y, maxX: rect.x + page.width, maxY: rect.y + page.height }, view)) continue;
      const [sx, sy] = this.pageToScreen(rect, 0, 0);
      ctx.fillRect(sx + 1, sy + 2, page.width * zoom + 2, page.height * zoom + 2);
    }
    this.forVisiblePages(ctx, (rect, local) => {
      this.drawBackground(ctx, rect.page, zoom * dpr);
      drawUnderLayer(ctx, pageObjects(this.doc, rect.page, local), this.hidden);
    });
  }

  /** 2층: 펜 획·도형·테이프 */
  private renderInk(): void {
    this.inkDirty = false;
    this.stats.inkFull++;
    const ctx = this.ictx;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this.inkCanvas.width, this.inkCanvas.height);
    this.forVisiblePages(ctx, (rect, local) => drawInkLayer(ctx, pageObjects(this.doc, rect.page, local), this.hidden));
  }

  /**
   * 새로 생긴 객체만 덧그리기. 기존 내용의 순서를 깨지 않는 경우에만 사용한다:
   *  - 로컬에서 방금 만든 객체(가장 큰 z)만 있는 변경
   *  - 형광펜은 bg 레이어에 multiply (형광펜끼리는 순서 무관)
   *  - 펜 획이 기존 테이프와 겹치면 테이프가 위에 있어야 하므로 전체 다시 그리기
   */
  private tryIncremental(e: ChangeEvent): boolean {
    if (e.origin !== 'local' || e.structural || !e.fresh.size || this.bgDirty || this.inkDirty || this.hidden.size) return false;
    if (e.ops.some((op) => op.k !== 'obj' || !op.v || !e.fresh.has(op.id))) return false;
    const objs = e.ops.map((op) => op.v as InkObject);
    const hasTape = objs.some((o) => o.type === 'tape');
    for (const o of objs) {
      if (!this.rectOf(o.pageId)) return false;
      if (o.type === 'tape' || isHighlighter(o)) continue;
      if (hasTape) return false;
      if (this.doc.query(o.pageId, objectBBox(o)).some((t) => t.type === 'tape')) return false;
    }
    for (const o of objs) {
      const rect = this.rectOf(o.pageId)!;
      const ctx = isHighlighter(o) ? this.bgctx : this.ictx;
      this.pageTransform(ctx, rect);
      ctx.save();
      ctx.beginPath();
      ctx.rect(0, 0, rect.page.width, rect.page.height);
      ctx.clip();
      drawObject(ctx, o);
      ctx.restore();
    }
    this.stats.incremental++;
    return true;
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

  /** 3층: 그리는 중인 획 */
  private renderLive(): void {
    const ctx = this.lctx;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this.liveCanvas.width, this.liveCanvas.height);
    const mode = this.gesture?.blendMultiply || this.lingering?.blendMultiply ? 'multiply' : 'normal';
    if (this.liveCanvas.style.mixBlendMode !== mode) this.liveCanvas.style.mixBlendMode = mode;
    for (const g of [this.lingering, this.gesture]) {
      if (!g?.drawLive) continue;
      ctx.save();
      g.drawLive(ctx);
      ctx.restore();
    }
  }

  /** 4층: 자, 선택 상자, 올가미, 커서, 길이 표시 */
  private renderUI(): void {
    const ctx = this.uctx;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this.overlay.width, this.overlay.height);
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    if (this.state.ruler) this.drawRuler(ctx);
    const sel = this.state.selection;
    if (sel && !(this.gesture instanceof TransformGesture)) {
      const rect = this.rectOf(sel.pageId);
      const objs = sel.ids.map((id) => this.doc.object(id)).filter((o): o is InkObject => !!o);
      if (rect && objs.length) drawSelectionBox(ctx, this, rect, selectionBBox(objs));
    }
    if (this.gesture?.drawUI) {
      ctx.save();
      this.gesture.drawUI(ctx);
      ctx.restore();
      ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    }
    if (this.hover && !this.gesture && this.state.tool === 'eraser') {
      drawEraserCursor(ctx, this.hover.x, this.hover.y, this.state.eraserSize / 2);
    }
  }

  /** 입력 이벤트 안에서 live 레이어 즉시 갱신 (저지연 캔버스 지원 시), ui 는 다음 프레임 */
  private drawNow(): void {
    if (this.lowLatency && !this.bgDirty && !this.inkDirty) {
      this.renderLive();
      this.liveClean = true;
    }
    this.schedule();
  }

  textLines(page: Page): TextLine[] | null {
    return page.bg.kind === 'pdf' ? this.pdf.textLines(page.bg.assetId, page.bg.pageIndex) : null;
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
    // 눈금: 실제 크기 1mm 단위, 1cm 마다 숫자 (현재 줌 기준)
    const mm = (PT_PER_CM / 10) * this.zoom;
    if (mm > 2) {
      const n = Math.floor(L / mm);
      const x0 = -L / 2 + 10;
      ctx.beginPath();
      for (let i = 0; i <= n && x0 + i * mm <= L / 2 - 10; i++) {
        const x = x0 + i * mm;
        const h = i % 10 === 0 ? 14 : i % 5 === 0 ? 9 : 5;
        ctx.moveTo(x, -T / 2);
        ctx.lineTo(x, -T / 2 + h);
        ctx.moveTo(x, T / 2);
        ctx.lineTo(x, T / 2 - h);
      }
      ctx.stroke();
      ctx.fillStyle = '#555';
      ctx.font = '10px system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'top';
      const every = mm * 10 < 22 ? 5 : 1; // 너무 촘촘하면 5cm 마다
      for (let c = 0; x0 + c * mm * 10 <= L / 2 - 10; c += every) ctx.fillText(c === 0 ? '0 cm' : String(c), x0 + c * mm * 10, -T / 2 + 15);
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
    if (!ids.length && !this.hidden.size) return;
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
    const colorable = objs.filter((o) => o.type !== 'image');
    if (colorable.length) this.doc.updateObjects(colorable.map((o) => ({ ...o, color }) as InkObject), '색상 변경');
  }

  copySelection(): void {
    this.clipboard = this.selectedObjects();
    this.syncState({ clipboardCount: this.clipboard.length });
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
    // 스티커 등 묶음은 새 묶음 id 로 (원본 묶음과 섞이지 않게)
    const groups = new Map<string, string>();
    const regroup = (g?: string) => (g ? (groups.get(g) ?? (groups.set(g, newId()), groups.get(g)!)) : undefined);
    const copies = this.clipboard.map((o) => {
      const c = { ...transformObject(o, m), id: newId(), pageId, z: this.doc.nextZ() };
      const g = regroup(o.group);
      if (g) c.group = g;
      return c;
    });
    this.doc.addObjects(copies, '붙여넣기');
    this.clipboard = copies;
    this.setSelection({ pageId, ids: copies.map((c) => c.id) });
  }

  // ───────────────────────── 텍스트 편집 ─────────────────────────

  private textEdit: { obj: TextObj; isNew: boolean; el: HTMLTextAreaElement } | null = null;

  editTextAt(rect: PageRect, x: number, y: number): void {
    const near = this.doc
      .query(rect.page.id, { minX: x - 2, minY: y - 2, maxX: x + 2, maxY: y + 2 })
      .filter((o): o is TextObj => o.type === 'text')
      // 페이지 텍스트는 용지 전체를 덮으므로, 쓰여 있는 줄(+이어 쓸 한 줄) 위를 탭했을 때만 편집
      .filter((o) => !o.flow || y <= o.y + (layoutText(o).length + 1) * o.fontSize * TEXT_LINE)
      .sort((a, b) => Number(!!a.flow) - Number(!!b.flow) || b.z - a.z); // 일반 상자 우선, 그다음 페이지 텍스트
    if (near[0]) return this.startTextEdit(near[0], false);
    const st = this.state.textStyle;
    const w = Math.max(80, Math.min(280, rect.page.width - x - 16));
    this.startTextEdit(
      { type: 'text', id: newId(), pageId: rect.page.id, z: 0, x, y: y - (st.size * TEXT_LINE) / 2, w, h: st.size * TEXT_LINE, text: '', fontSize: st.size, bold: false, color: st.color },
      true,
    );
  }

  private startTextEdit(obj: TextObj, isNew: boolean): void {
    this.commitTextEdit();
    const el = document.createElement('textarea');
    el.className = 'text-editor';
    el.value = obj.text;
    el.spellcheck = false;
    el.addEventListener('input', () => this.positionTextEditor());
    el.addEventListener('blur', () => this.commitTextEdit());
    el.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Escape') this.commitTextEdit();
    });
    this.root.append(el);
    this.textEdit = { obj, isNew, el };
    if (!isNew) this.setHidden([obj.id]);
    this.positionTextEditor();
    el.focus();
    el.setSelectionRange(el.value.length, el.value.length);
  }

  private positionTextEditor(): void {
    const t = this.textEdit;
    if (!t) return;
    const rect = this.rectOf(t.obj.pageId);
    if (!rect) return;
    const [sx, sy] = this.pageToScreen(rect, t.obj.x, t.obj.y);
    const z = this.zoom;
    Object.assign(t.el.style, {
      left: `${sx}px`,
      top: `${sy}px`,
      width: `${t.obj.w * z}px`,
      font: `${t.obj.bold ? '700 ' : ''}${t.obj.fontSize * z}px/${TEXT_LINE} ${TEXT_FONT}`,
      color: t.obj.color,
    });
    t.el.style.height = '0px';
    t.el.style.height = `${Math.max(t.obj.h * z, t.el.scrollHeight)}px`;
  }

  commitTextEdit(): void {
    const t = this.textEdit;
    if (!t) return;
    this.textEdit = null;
    const text = t.el.value.replace(/\s+$/, '');
    t.el.remove();
    this.setHidden([]);
    const next: TextObj = { ...t.obj, text };
    if (!next.flow) next.h = Math.max(next.fontSize * TEXT_LINE, layoutText(next).length * next.fontSize * TEXT_LINE);
    if (t.isNew) {
      if (text.trim()) this.doc.addObjects([{ ...next, z: this.doc.nextZ() }], '텍스트');
    } else if (!text.trim() && !t.obj.flow) this.doc.removeObjects([t.obj.id], '텍스트 삭제');
    else if (text !== t.obj.text) this.doc.updateObjects([next], '텍스트 수정');
  }

  /** 이미지 삽입: 현재 페이지 가운데에, 페이지 폭의 60% 안으로 맞춰서 */
  insertImage(assetId: string, naturalW: number, naturalH: number): void {
    const pageId = this.state.currentPageId;
    const rect = pageId ? this.rectOf(pageId) : this.rects[0];
    if (!rect) return;
    const { page } = rect;
    const k = Math.min(1, (page.width * 0.6) / naturalW, (page.height * 0.6) / naturalH);
    const w = naturalW * k, h = naturalH * k;
    const view = this.viewRect();
    const cy = Math.max(h / 2, Math.min(page.height - h / 2, (view.minY + view.maxY) / 2 - rect.y));
    const img: ImageObj = { type: 'image', id: newId(), pageId: page.id, z: this.doc.nextZ(), assetId, x: (page.width - w) / 2, y: cy - h / 2, w, h, opacity: 1 };
    this.doc.addObjects([img], '이미지');
    this.update({ tool: 'lasso' });
    this.setSelection({ pageId: page.id, ids: [img.id] });
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
    if (!this.tryIncremental(e)) this.invalidate(true);
    else this.schedule();
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
      case 'text':
        return new TextGesture(this, e, rect);
      default:
        return new InkGesture(this, e, rect, tool);
    }
  }

  private onDown = (e: PointerEvent): void => {
    const [x, y] = this.local(e);
    // 텍스트 편집 중 캔버스를 누르면 편집을 끝낸다 (그 탭은 소비)
    if (this.textEdit && e.pointerType !== 'touch') {
      this.commitTextEdit();
      return;
    }
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
    if (maxTouches === 3) return this.redo(); // 세 손가락 탭 = 다시 실행
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
      const map: Record<string, ToolId> = { p: 'pen', b: 'ballpoint', n: 'pencil', m: 'marker', h: 'highlighter', u: 'underline', e: 'eraser', l: 'lasso', s: 'shape', t: 'tape', x: 'text' };
      const tool = map[e.key.toLowerCase()];
      if (tool) this.update({ tool });
    }
  };
}
