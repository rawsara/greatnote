import {
  PointFilter, TOOL_PRESETS, WidthEstimator, affineScaleAbout, affineTranslate, applyEndTaper, bboxOfFlat,
  bboxOfSegment, eraseStep, lassoSelect, newId, objectBBox, pointHitsTape, quantizePoints, selectionBBox,
  simplifyStroke, transformObject, IDENTITY,
  type Affine, type BBox, type InkObject, type InkTool, type ShapeObj, type StrokeObj, type TapeObj, type ToolPreset,
} from '@inknote/core';
import { drawObject } from './render';
import type { EditorHost, Gesture, PageRect, SnapLine } from './types';

const coalescedOf = (e: PointerEvent): PointerEvent[] => {
  const list = e.getCoalescedEvents?.();
  return list && list.length ? list : [e];
};
export { coalescedOf };

// ─────────────────────────── 펜 계열 ───────────────────────────

/**
 * 손글씨 입력 파이프라인 (입력 이벤트마다):
 *   PointerEvent(coalesced 포함, ~240Hz)
 *     → One Euro 필터 (화면 px, 손떨림 보정)
 *     → 0.5px 미만 이동 제거 (decimation)
 *     → WidthEstimator (필압 + 속도 → 굵기 비율)
 *     → 페이지 좌표 변환 (+ 자 스냅 / 직선 보정)
 *   predicted events 는 복제한 필터로 계산해 "꼬리"로만 그린다 (지연 체감 감소, 커밋 X)
 * 펜을 떼면: 끝 taper → RDP 단순화 → 양자화 → 문서에 커밋
 */
export class InkGesture implements Gesture {
  readonly pointerId: number;
  readonly pointerType: string;
  readonly blendMultiply: boolean;
  private preset: ToolPreset;
  private filter: PointFilter;
  private width: WidthEstimator;
  private hasPressure: boolean;
  private pts: number[] = [];
  private predicted: number[] = [];
  private lastSX = NaN;
  private lastSY = NaN;
  private snap: SnapLine | null;
  private color: string;
  private baseWidth: number;

  constructor(
    private ed: EditorHost,
    e: PointerEvent,
    private rect: PageRect,
    private tool: InkTool,
  ) {
    this.pointerId = e.pointerId;
    this.pointerType = e.pointerType;
    this.preset = TOOL_PRESETS[tool];
    this.blendMultiply = this.preset.blend === 'multiply';
    const style = ed.state.inkStyles[tool];
    this.color = style.color;
    this.baseWidth = style.width;
    this.hasPressure = e.pointerType === 'pen';
    this.filter = PointFilter.fromStabilization(this.preset.stabilization);
    this.width = new WidthEstimator(this.preset.profile, this.hasPressure);
    const [sx, sy] = ed.local(e);
    this.snap = ed.rulerSnapLine(rect, sx, sy);
    this.add(e);
  }

  private process(ev: PointerEvent, f: PointFilter, w: WidthEstimator): [number, number, number, number, number] {
    const [rx, ry] = this.ed.local(ev);
    const [sx, sy] = f.filter(rx, ry, ev.timeStamp);
    const ratio = w.next(sx, sy, ev.pressure > 0 ? ev.pressure : 0.5, ev.timeStamp);
    let [px, py] = this.ed.toPage(this.rect, sx, sy);
    if (this.snap) {
      const s = this.snap;
      const t = (px - s.ax) * s.dx + (py - s.ay) * s.dy;
      px = s.ax + s.dx * t;
      py = s.ay + s.dy * t;
    }
    return [px, py, ratio, sx, sy];
  }

  private add(ev: PointerEvent): void {
    const [px, py, w, sx, sy] = this.process(ev, this.filter, this.width);
    if (this.preset.straight) {
      if (this.pts.length >= 6) this.pts.length = 3;
      this.pts.push(px, py, 1);
      return;
    }
    if (this.pts.length && Math.hypot(sx - this.lastSX, sy - this.lastSY) < 0.5) return;
    this.lastSX = sx;
    this.lastSY = sy;
    this.pts.push(px, py, w);
  }

  move(_e: PointerEvent, coalesced: PointerEvent[], predicted: PointerEvent[]): void {
    for (const ev of coalesced) this.add(ev);
    this.predicted = [];
    if (predicted.length && !this.preset.straight) {
      const f = this.filter.clone();
      const w = Object.assign(Object.create(Object.getPrototypeOf(this.width)), this.width) as WidthEstimator;
      for (const ev of predicted.slice(0, 4)) {
        const [px, py, ww] = this.process(ev, f, w);
        this.predicted.push(px, py, ww);
      }
    }
  }

  private finalPoints(): number[] {
    let pts = this.pts.slice();
    if (this.preset.straight && pts.length >= 6) {
      // 밑줄: 8° 이내면 수평으로 스냅
      const ang = Math.atan2(pts[4] - pts[1], pts[3] - pts[0]);
      if (!this.snap && (Math.abs(ang) < 0.14 || Math.abs(Math.abs(ang) - Math.PI) < 0.14)) pts[4] = pts[1];
      return pts;
    }
    if (this.preset.variable && !this.hasPressure) applyEndTaper(pts, this.preset.profile.taper / this.ed.zoom);
    if (pts.length > 6) pts = simplifyStroke(pts, 0.08, this.baseWidth);
    return pts;
  }

  private toObject(pts: number[]): StrokeObj {
    return {
      type: 'stroke', id: 'live', pageId: this.rect.page.id, z: 0, tool: this.tool,
      color: this.color, width: this.baseWidth, opacity: this.preset.opacity, pts,
    };
  }

  up(): void {
    if (!this.pts.length) return;
    const obj = this.toObject(quantizePoints(this.finalPoints()));
    obj.id = newId();
    obj.z = this.ed.doc.nextZ();
    this.ed.doc.addObjects([obj], this.preset.label);
  }

  cancel(): void {
    this.pts = [];
  }

  drawOverlay(ctx: CanvasRenderingContext2D): void {
    if (!this.pts.length) return;
    this.ed.pageTransform(ctx, this.rect);
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, 0, this.rect.page.width, this.rect.page.height);
    ctx.clip();
    const pts = this.predicted.length ? this.pts.concat(this.predicted) : this.pts;
    drawObject(ctx, this.toObject(this.preset.straight ? this.finalPoints() : pts), { cache: false });
    ctx.restore();
  }
}

// ─────────────────────────── 지우개 ───────────────────────────

export class EraserGesture implements Gesture {
  readonly pointerId: number;
  readonly pointerType: string;
  private lx: number;
  private ly: number;
  private sx: number;
  private sy: number;

  constructor(private ed: EditorHost, e: PointerEvent, private rect: PageRect) {
    this.pointerId = e.pointerId;
    this.pointerType = e.pointerType;
    [this.sx, this.sy] = ed.local(e);
    [this.lx, this.ly] = ed.toPage(rect, this.sx, this.sy);
    ed.doc.beginGroup('지우기');
    this.step(this.lx, this.ly);
  }

  /** 이전 위치 → 현재 위치 캡슐로 판정해서 빠른 움직임에도 빈틈이 없다 */
  private step(x: number, y: number): void {
    const { doc, state } = this.ed;
    const r = state.eraserSize / 2 / this.ed.zoom;
    const cands = doc.query(this.rect.page.id, bboxOfSegment(this.lx, this.ly, x, y, r));
    if (cands.length) {
      const res = eraseStep(cands, state.eraserMode, this.lx, this.ly, x, y, r, () => newId());
      if (res.remove.length) {
        doc.transact('지우기', (tx) => {
          res.remove.forEach((id) => tx.del('obj', id));
          res.add.forEach((o) => tx.put('obj', o.id, o));
        });
      }
    }
    this.lx = x;
    this.ly = y;
  }

  move(_e: PointerEvent, coalesced: PointerEvent[]): void {
    for (const ev of coalesced) {
      [this.sx, this.sy] = this.ed.local(ev);
      const [x, y] = this.ed.toPage(this.rect, this.sx, this.sy);
      this.step(x, y);
    }
  }

  up(): void {
    this.ed.doc.endGroup();
  }

  cancel(): void {
    this.ed.doc.endGroup();
  }

  drawOverlay(ctx: CanvasRenderingContext2D): void {
    drawEraserCursor(ctx, this.sx, this.sy, this.ed.state.eraserSize / 2);
  }
}

export function drawEraserCursor(ctx: CanvasRenderingContext2D, x: number, y: number, r: number): void {
  ctx.save();
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.fillStyle = 'rgba(255,255,255,0.35)';
  ctx.fill();
  ctx.lineWidth = 1.5;
  ctx.strokeStyle = 'rgba(40,40,40,0.75)';
  ctx.stroke();
  ctx.restore();
}

// ─────────────────────────── 올가미 ───────────────────────────

export class LassoGesture implements Gesture {
  readonly pointerId: number;
  readonly pointerType: string;
  private pts: number[] = [];

  constructor(private ed: EditorHost, e: PointerEvent, private rect: PageRect) {
    this.pointerId = e.pointerId;
    this.pointerType = e.pointerType;
    this.add(e);
  }

  private add(ev: PointerEvent) {
    const [sx, sy] = this.ed.local(ev);
    const [x, y] = this.ed.toPage(this.rect, sx, sy);
    const n = this.pts.length;
    if (n && Math.hypot(x - this.pts[n - 2], y - this.pts[n - 1]) * this.ed.zoom < 2) return;
    this.pts.push(x, y);
  }

  move(_e: PointerEvent, coalesced: PointerEvent[]): void {
    coalesced.forEach((ev) => this.add(ev));
  }

  up(): void {
    const ids =
      this.pts.length >= 6
        ? lassoSelect(this.ed.doc.query(this.rect.page.id, bboxOfFlat(this.pts, 2)), this.pts)
        : [];
    this.ed.setSelection(ids.length ? { pageId: this.rect.page.id, ids } : null);
  }

  cancel(): void {}

  drawOverlay(ctx: CanvasRenderingContext2D): void {
    if (this.pts.length < 4) return;
    const z = this.ed.zoom;
    this.ed.pageTransform(ctx, this.rect);
    ctx.save();
    ctx.beginPath();
    ctx.moveTo(this.pts[0], this.pts[1]);
    for (let i = 2; i < this.pts.length; i += 2) ctx.lineTo(this.pts[i], this.pts[i + 1]);
    ctx.closePath();
    ctx.fillStyle = 'rgba(59,130,246,0.08)';
    ctx.fill();
    ctx.setLineDash([6 / z, 5 / z]);
    ctx.lineWidth = 1.5 / z;
    ctx.strokeStyle = '#2563eb';
    ctx.stroke();
    ctx.restore();
  }
}

// ─────────────────────── 선택 영역 이동 / 크기 조절 ───────────────────────

export const HANDLE_PX = 22;

/** 선택 bbox 의 화면 좌표 사각형과 핸들 히트 판정 */
export function selectionHit(ed: EditorHost, rect: PageRect, b: BBox, sx: number, sy: number): 'move' | 0 | 1 | 2 | 3 | null {
  const [x0, y0] = ed.pageToScreen(rect, b.minX, b.minY);
  const [x1, y1] = ed.pageToScreen(rect, b.maxX, b.maxY);
  const corners = [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];
  for (let i = 0; i < 4; i++) if (Math.hypot(sx - corners[i][0], sy - corners[i][1]) <= HANDLE_PX) return i as 0 | 1 | 2 | 3;
  if (sx >= x0 && sx <= x1 && sy >= y0 && sy <= y1) return 'move';
  return null;
}

export function drawSelectionBox(ctx: CanvasRenderingContext2D, ed: EditorHost, rect: PageRect, b: BBox, m: Affine = IDENTITY): void {
  const p = (x: number, y: number) => ed.pageToScreen(rect, m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]);
  const [x0, y0] = p(b.minX, b.minY);
  const [x1, y1] = p(b.maxX, b.maxY);
  ctx.save();
  ctx.setLineDash([5, 4]);
  ctx.lineWidth = 1.5;
  ctx.strokeStyle = '#2563eb';
  ctx.strokeRect(x0, y0, x1 - x0, y1 - y0);
  ctx.setLineDash([]);
  for (const [x, y] of [[x0, y0], [x1, y0], [x1, y1], [x0, y1]]) {
    ctx.beginPath();
    ctx.arc(x, y, 7, 0, Math.PI * 2);
    ctx.fillStyle = '#ffffff';
    ctx.fill();
    ctx.lineWidth = 2;
    ctx.stroke();
  }
  ctx.restore();
}

export class TransformGesture implements Gesture {
  readonly pointerId: number;
  readonly pointerType: string;
  private objs: InkObject[];
  private box: BBox;
  private m: Affine = IDENTITY;
  private startX: number;
  private startY: number;

  constructor(
    private ed: EditorHost,
    e: PointerEvent,
    private rect: PageRect,
    ids: string[],
    private mode: 'move' | 0 | 1 | 2 | 3,
  ) {
    this.pointerId = e.pointerId;
    this.pointerType = e.pointerType;
    this.objs = ids.map((id) => ed.doc.object(id)).filter((o): o is InkObject => !!o);
    this.box = selectionBBox(this.objs);
    [this.startX, this.startY] = ed.toPage(rect, ...ed.local(e));
    ed.setHidden(ids); // 베이스 레이어에서 숨기고 overlay 에서 변환 미리보기
  }

  move(e: PointerEvent): void {
    const [x, y] = this.ed.toPage(this.rect, ...this.ed.local(e));
    if (this.mode === 'move') {
      this.m = affineTranslate(x - this.startX, y - this.startY);
      return;
    }
    const b = this.box;
    const cx = [b.minX, b.maxX, b.maxX, b.minX], cy = [b.minY, b.minY, b.maxY, b.maxY];
    const c = this.mode;
    const ax = cx[(c + 2) % 4], ay = cy[(c + 2) % 4]; // 반대쪽 꼭짓점 고정
    const vx = cx[c] - ax, vy = cy[c] - ay;
    const s = Math.max(0.05, ((x - ax) * vx + (y - ay) * vy) / (vx * vx + vy * vy || 1));
    this.m = affineScaleAbout(ax, ay, s, s);
  }

  up(): void {
    const m = this.m;
    const changed = m.some((v, i) => Math.abs(v - IDENTITY[i]) > 1e-6);
    if (changed) this.ed.doc.updateObjects(this.objs.map((o) => transformObject(o, m)), this.mode === 'move' ? '이동' : '크기 조절');
    this.ed.setHidden([]);
  }

  cancel(): void {
    this.ed.setHidden([]);
  }

  drawOverlay(ctx: CanvasRenderingContext2D): void {
    this.ed.pageTransform(ctx, this.rect);
    ctx.save();
    ctx.transform(...this.m);
    for (const o of this.objs) drawObject(ctx, o);
    ctx.restore();
    ctx.setTransform(devicePixelRatio, 0, 0, devicePixelRatio, 0, 0);
    drawSelectionBox(ctx, this.ed, this.rect, this.box, this.m);
  }
}

// ─────────────────────────── 도형 ───────────────────────────

export class ShapeGesture implements Gesture {
  readonly pointerId: number;
  readonly pointerType: string;
  private x1: number;
  private y1: number;
  private x2: number;
  private y2: number;

  constructor(private ed: EditorHost, e: PointerEvent, private rect: PageRect) {
    this.pointerId = e.pointerId;
    this.pointerType = e.pointerType;
    [this.x1, this.y1] = ed.toPage(rect, ...ed.local(e));
    this.x2 = this.x1;
    this.y2 = this.y1;
  }

  move(e: PointerEvent): void {
    let [x, y] = this.ed.toPage(this.rect, ...this.ed.local(e));
    const kind = this.ed.state.shapeKind;
    const dx = x - this.x1, dy = y - this.y1;
    if (kind === 'line' || kind === 'arrow') {
      // 15° 단위 각도 스냅 (shift 또는 근접 시)
      const ang = Math.atan2(dy, dx);
      const snapped = Math.round(ang / (Math.PI / 12)) * (Math.PI / 12);
      if (e.shiftKey || Math.abs(ang - snapped) < 0.05) {
        const len = Math.hypot(dx, dy);
        x = this.x1 + Math.cos(snapped) * len;
        y = this.y1 + Math.sin(snapped) * len;
      }
    } else if (e.shiftKey) {
      const s = Math.max(Math.abs(dx), Math.abs(dy));
      x = this.x1 + Math.sign(dx || 1) * s;
      y = this.y1 + Math.sign(dy || 1) * s;
    }
    this.x2 = x;
    this.y2 = y;
  }

  private obj(): ShapeObj {
    const st = this.ed.state.shapeStyle;
    return {
      type: 'shape', id: 'live', pageId: this.rect.page.id, z: 0, shape: this.ed.state.shapeKind,
      color: st.color, width: st.width, opacity: 1, x1: this.x1, y1: this.y1, x2: this.x2, y2: this.y2,
    };
  }

  up(): void {
    if (Math.hypot(this.x2 - this.x1, this.y2 - this.y1) * this.ed.zoom < 4) return;
    const o = { ...this.obj(), id: newId(), z: this.ed.doc.nextZ() };
    this.ed.doc.addObjects([o], '도형');
  }

  cancel(): void {}

  drawOverlay(ctx: CanvasRenderingContext2D): void {
    this.ed.pageTransform(ctx, this.rect);
    drawObject(ctx, this.obj(), { cache: false });
  }
}

// ─────────────────────────── 암기 테이프 ───────────────────────────

/** 페이지 좌표 (x,y) 에 있는 최상단 테이프 */
export function tapeAt(ed: EditorHost, pageId: string, x: number, y: number): TapeObj | null {
  const slop = 6 / ed.zoom;
  const hits = ed.doc
    .query(pageId, { minX: x - slop, minY: y - slop, maxX: x + slop, maxY: y + slop })
    .filter((o): o is TapeObj => pointHitsTape(o, x, y, slop))
    .sort((a, b) => b.z - a.z);
  return hits[0] ?? null;
}

export class TapeGesture implements Gesture {
  readonly pointerId: number;
  readonly pointerType: string;
  private x1: number;
  private y1: number;
  private x2: number;
  private y2: number;
  private moved = false;

  constructor(private ed: EditorHost, e: PointerEvent, private rect: PageRect) {
    this.pointerId = e.pointerId;
    this.pointerType = e.pointerType;
    [this.x1, this.y1] = ed.toPage(rect, ...ed.local(e));
    this.x2 = this.x1;
    this.y2 = this.y1;
  }

  move(e: PointerEvent): void {
    [this.x2, this.y2] = this.ed.toPage(this.rect, ...this.ed.local(e));
    if (Math.hypot(this.x2 - this.x1, this.y2 - this.y1) * this.ed.zoom > 6) this.moved = true;
    const ang = Math.atan2(this.y2 - this.y1, this.x2 - this.x1);
    if (Math.abs(ang) < 0.17 || Math.abs(Math.abs(ang) - Math.PI) < 0.17) this.y2 = this.y1;
  }

  private obj(): TapeObj {
    const st = this.ed.state.tapeStyle;
    return {
      type: 'tape', id: 'live', pageId: this.rect.page.id, z: 0, color: st.color, thickness: st.width,
      x1: this.x1, y1: this.y1, x2: this.x2, y2: this.y2, revealed: false,
    };
  }

  up(): void {
    if (!this.moved) {
      // 탭 → 테이프 가림/보임 토글
      const t = tapeAt(this.ed, this.rect.page.id, this.x1, this.y1);
      if (t) this.ed.doc.updateObjects([{ ...t, revealed: !t.revealed }], '테이프');
      return;
    }
    this.ed.doc.addObjects([{ ...this.obj(), id: newId(), z: this.ed.doc.nextZ() }], '테이프');
  }

  cancel(): void {}

  drawOverlay(ctx: CanvasRenderingContext2D): void {
    if (!this.moved) return;
    this.ed.pageTransform(ctx, this.rect);
    drawObject(ctx, this.obj(), { cache: false, tapeAlpha: 0.85 });
  }
}

// ─────────────────────────── 자 ───────────────────────────

export class RulerGesture implements Gesture {
  readonly pointerId: number;
  readonly pointerType: string;
  private lx: number;
  private ly: number;
  private startAngle: number;
  private startPointer: number;

  constructor(private ed: EditorHost, e: PointerEvent, private mode: 'move' | 'rotate', private screenCenter: () => [number, number]) {
    this.pointerId = e.pointerId;
    this.pointerType = e.pointerType;
    [this.lx, this.ly] = ed.local(e);
    const [cx, cy] = screenCenter();
    this.startAngle = ed.ruler.angle;
    this.startPointer = Math.atan2(this.ly - cy, this.lx - cx);
  }

  move(e: PointerEvent): void {
    const [x, y] = this.ed.local(e);
    const r = this.ed.ruler;
    if (this.mode === 'move') {
      r.cx += (x - this.lx) / this.ed.zoom;
      r.cy += (y - this.ly) / this.ed.zoom;
    } else {
      const [cx, cy] = this.screenCenter();
      let a = this.startAngle + Math.atan2(y - cy, x - cx) - this.startPointer;
      const step = Math.PI / 12; // 15° 스냅
      const snapped = Math.round(a / step) * step;
      if (Math.abs(a - snapped) < 0.035) a = snapped;
      r.angle = a;
    }
    this.lx = x;
    this.ly = y;
    this.ed.rulerMoved();
  }

  up(): void {}
  cancel(): void {}
  drawOverlay(): void {}
}

export type { StrokeObj };
