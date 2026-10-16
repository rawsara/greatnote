import { STRIDE } from './model';

/**
 * Canvas2D / Path2D / SVG / PDF 에서 공통으로 쓰는 경로 출력 인터페이스.
 * CanvasRenderingContext2D 와 Path2D 는 이 시그니처를 그대로 만족한다.
 */
export interface PathSink {
  moveTo(x: number, y: number): void;
  lineTo(x: number, y: number): void;
  quadraticCurveTo(cx: number, cy: number, x: number, y: number): void;
  bezierCurveTo(c1x: number, c1y: number, c2x: number, c2y: number, x: number, y: number): void;
  closePath(): void;
}

/** SVG path 문자열 생성기 (PDF 내보내기, 서버 렌더링용) */
export class SvgPathBuilder implements PathSink {
  private parts: string[] = [];
  private static f(n: number): string {
    return (Math.round(n * 100) / 100).toString();
  }
  moveTo(x: number, y: number) {
    this.parts.push(`M${SvgPathBuilder.f(x)} ${SvgPathBuilder.f(y)}`);
  }
  lineTo(x: number, y: number) {
    this.parts.push(`L${SvgPathBuilder.f(x)} ${SvgPathBuilder.f(y)}`);
  }
  quadraticCurveTo(cx: number, cy: number, x: number, y: number) {
    const f = SvgPathBuilder.f;
    this.parts.push(`Q${f(cx)} ${f(cy)} ${f(x)} ${f(y)}`);
  }
  bezierCurveTo(c1x: number, c1y: number, c2x: number, c2y: number, x: number, y: number) {
    const f = SvgPathBuilder.f;
    this.parts.push(`C${f(c1x)} ${f(c1y)} ${f(c2x)} ${f(c2y)} ${f(x)} ${f(y)}`);
  }
  closePath() {
    this.parts.push('Z');
  }
  toString(): string {
    return this.parts.join('');
  }
}

/**
 * 세그먼트 i → i+1 의 3차 베지에 제어점.
 *
 * Catmull-Rom 계열 스플라인이지만, 접선 방향은 이웃 현(p[i+1]-p[i-1])을 따르고
 * 접선 길이는 "현재 세그먼트 길이/3" 으로 제한한다.
 * → 점 간격이 불균일해도 overshoot(곡선이 튀어나감)가 생기지 않는다.
 */
export function segmentControlPoints(pts: ArrayLike<number>, i: number, n: number, out: number[]): void {
  const s = STRIDE;
  const i0 = (i > 0 ? i - 1 : i) * s;
  const i1 = i * s;
  const i2 = (i + 1) * s;
  const i3 = (i + 2 < n ? i + 2 : i + 1) * s;
  const x1 = pts[i1], y1 = pts[i1 + 1], x2 = pts[i2], y2 = pts[i2 + 1];
  const segLen = Math.hypot(x2 - x1, y2 - y1);
  const k = segLen / 3;

  let tx = x2 - pts[i0], ty = y2 - pts[i0 + 1];
  let tl = Math.hypot(tx, ty);
  out[0] = tl > 1e-9 ? x1 + (tx / tl) * k : x1;
  out[1] = tl > 1e-9 ? y1 + (ty / tl) * k : y1;

  tx = pts[i3] - x1;
  ty = pts[i3 + 1] - y1;
  tl = Math.hypot(tx, ty);
  out[2] = tl > 1e-9 ? x2 - (tx / tl) * k : x2;
  out[3] = tl > 1e-9 ? y2 - (ty / tl) * k : y2;
}

/** 중심선을 베지에 곡선으로 그린다 (일정 굵기 도구: 볼펜/마카/형광펜/밑줄) */
export function traceCenterline(sink: PathSink, pts: ArrayLike<number>): void {
  const n = pts.length / STRIDE;
  if (n === 0) return;
  sink.moveTo(pts[0], pts[1]);
  if (n === 1) {
    // round cap 으로 점이 찍히도록 아주 짧은 선분
    sink.lineTo(pts[0] + 0.01, pts[1]);
    return;
  }
  if (n === 2) {
    sink.lineTo(pts[STRIDE], pts[STRIDE + 1]);
    return;
  }
  const cp = [0, 0, 0, 0];
  for (let i = 0; i < n - 1; i++) {
    segmentControlPoints(pts, i, n, cp);
    const k = (i + 1) * STRIDE;
    sink.bezierCurveTo(cp[0], cp[1], cp[2], cp[3], pts[k], pts[k + 1]);
  }
}

const bez = (a: number, b: number, c: number, d: number, t: number) => {
  const mt = 1 - t;
  return mt * mt * mt * a + 3 * mt * mt * t * b + 3 * mt * t * t * c + t * t * t * d;
};
const bezD = (a: number, b: number, c: number, d: number, t: number) => {
  const mt = 1 - t;
  return 3 * mt * mt * (b - a) + 6 * mt * t * (c - b) + 3 * t * t * (d - c);
};

const CAP_STEPS = 8;

/**
 * 가변 굵기 획의 외곽선 폴리곤 생성 (필압/속도 반영 도구: 만년필, 연필).
 *
 * 1) 중심선 베지에를 세그먼트 길이에 비례해 샘플링
 * 2) 각 샘플에서 접선의 법선 방향으로 ±halfWidth 오프셋 → 좌/우 경계
 * 3) 양 끝에 반원 캡을 붙여 하나의 닫힌 폴리곤 구성
 *
 * 반환: [x0, y0, x1, y1, ...]  (traceOutline 으로 부드럽게 채움)
 */
export function buildOutline(pts: ArrayLike<number>, baseWidth: number, minHalf = 0.12): number[] {
  const n = pts.length / STRIDE;
  if (n === 0) return [];
  if (n === 1) {
    const r = Math.max(minHalf, (pts[2] * baseWidth) / 2);
    const out: number[] = [];
    for (let k = 0; k < 16; k++) {
      const a = (k / 16) * Math.PI * 2;
      out.push(pts[0] + Math.cos(a) * r, pts[1] + Math.sin(a) * r);
    }
    return out;
  }

  const left: number[] = [];
  const right: number[] = [];
  const cp = [0, 0, 0, 0];
  let nx = 0, ny = 0, hw = 0, cx = 0, cy = 0, tx = 1, ty = 0;
  const first = { tx: 1, ty: 0, set: false };

  const emit = (x: number, y: number, dx: number, dy: number, h: number) => {
    const l = Math.hypot(dx, dy);
    if (l > 1e-9) {
      tx = dx / l;
      ty = dy / l;
    }
    if (!first.set) {
      first.tx = tx;
      first.ty = ty;
      first.set = true;
    }
    nx = -ty;
    ny = tx;
    hw = Math.max(minHalf, h);
    cx = x;
    cy = y;
    left.push(x + nx * hw, y + ny * hw);
    right.push(x - nx * hw, y - ny * hw);
  };

  for (let i = 0; i < n - 1; i++) {
    const a = i * STRIDE;
    const b = a + STRIDE;
    const x1 = pts[a], y1 = pts[a + 1], w1 = pts[a + 2];
    const x2 = pts[b], y2 = pts[b + 1], w2 = pts[b + 2];
    segmentControlPoints(pts, i, n, cp);
    const len = Math.hypot(x2 - x1, y2 - y1);
    const steps = Math.min(24, Math.max(1, Math.ceil(len / 0.8)));
    const last = i === n - 2;
    for (let j = 0; j <= (last ? steps : steps - 1); j++) {
      const t = j / steps;
      emit(
        bez(x1, cp[0], cp[2], x2, t),
        bez(y1, cp[1], cp[3], y2, t),
        bezD(x1, cp[0], cp[2], x2, t),
        bezD(y1, cp[1], cp[3], y2, t),
        ((w1 + (w2 - w1) * t) * baseWidth) / 2,
      );
    }
  }

  const poly: number[] = [];
  for (let i = 0; i < left.length; i++) poly.push(left[i]);
  // 끝 캡: left → (앞쪽) → right
  for (let k = 1; k < CAP_STEPS; k++) {
    const th = (k / CAP_STEPS) * Math.PI;
    const c = Math.cos(th), s = Math.sin(th);
    poly.push(cx + (nx * c + tx * s) * hw, cy + (ny * c + ty * s) * hw);
  }
  for (let i = right.length - 2; i >= 0; i -= 2) poly.push(right[i], right[i + 1]);
  // 시작 캡: right → (뒤쪽) → left
  const stx = first.tx, sty = first.ty;
  const snx = -sty, sny = stx;
  const sx = pts[0], sy = pts[1];
  const shw = Math.max(minHalf, (pts[2] * baseWidth) / 2);
  for (let k = 1; k < CAP_STEPS; k++) {
    const th = (k / CAP_STEPS) * Math.PI;
    const c = Math.cos(th), s = Math.sin(th);
    poly.push(sx + (-snx * c - stx * s) * shw, sy + (-sny * c - sty * s) * shw);
  }
  return poly;
}

/** 폴리곤을 중점 기준 2차 베지에로 부드럽게 채운다 */
export function traceOutline(sink: PathSink, poly: ArrayLike<number>): void {
  const m = poly.length / 2;
  if (m < 3) return;
  const lx = poly[(m - 1) * 2], ly = poly[(m - 1) * 2 + 1];
  sink.moveTo((lx + poly[0]) / 2, (ly + poly[1]) / 2);
  for (let i = 0; i < m; i++) {
    const ax = poly[i * 2], ay = poly[i * 2 + 1];
    const j = ((i + 1) % m) * 2;
    sink.quadraticCurveTo(ax, ay, (ax + poly[j]) / 2, (ay + poly[j + 1]) / 2);
  }
  sink.closePath();
}
