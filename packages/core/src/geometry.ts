export interface BBox {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

export const emptyBBox = (): BBox => ({ minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity });

export function bboxIsEmpty(b: BBox): boolean {
  return b.minX > b.maxX || b.minY > b.maxY;
}

export function bboxAddPoint(b: BBox, x: number, y: number, pad = 0): void {
  if (x - pad < b.minX) b.minX = x - pad;
  if (y - pad < b.minY) b.minY = y - pad;
  if (x + pad > b.maxX) b.maxX = x + pad;
  if (y + pad > b.maxY) b.maxY = y + pad;
}

export function bboxUnion(a: BBox, b: BBox): BBox {
  return {
    minX: Math.min(a.minX, b.minX),
    minY: Math.min(a.minY, b.minY),
    maxX: Math.max(a.maxX, b.maxX),
    maxY: Math.max(a.maxY, b.maxY),
  };
}

export function bboxIntersects(a: BBox, b: BBox): boolean {
  return a.minX <= b.maxX && a.maxX >= b.minX && a.minY <= b.maxY && a.maxY >= b.minY;
}

export function bboxContains(b: BBox, x: number, y: number): boolean {
  return x >= b.minX && x <= b.maxX && y >= b.minY && y <= b.maxY;
}

export function bboxExpand(b: BBox, d: number): BBox {
  return { minX: b.minX - d, minY: b.minY - d, maxX: b.maxX + d, maxY: b.maxY + d };
}

export function bboxOfSegment(ax: number, ay: number, bx: number, by: number, pad = 0): BBox {
  return {
    minX: Math.min(ax, bx) - pad,
    minY: Math.min(ay, by) - pad,
    maxX: Math.max(ax, bx) + pad,
    maxY: Math.max(ay, by) + pad,
  };
}

/** flat 배열(stride 단위)의 bbox */
export function bboxOfFlat(pts: ArrayLike<number>, stride: number, pad = 0): BBox {
  const b = emptyBBox();
  for (let i = 0; i < pts.length; i += stride) bboxAddPoint(b, pts[i], pts[i + 1], pad);
  return b;
}

export function distSq(ax: number, ay: number, bx: number, by: number): number {
  const dx = ax - bx;
  const dy = ay - by;
  return dx * dx + dy * dy;
}

export function distPointToSegmentSq(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const vx = bx - ax;
  const vy = by - ay;
  const len2 = vx * vx + vy * vy;
  let t = len2 > 0 ? ((px - ax) * vx + (py - ay) * vy) / len2 : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  return distSq(px, py, ax + vx * t, ay + vy * t);
}

function orient(ax: number, ay: number, bx: number, by: number, cx: number, cy: number): number {
  return (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
}

export function segmentsIntersect(
  ax: number, ay: number, bx: number, by: number,
  cx: number, cy: number, dx: number, dy: number,
): boolean {
  const d1 = orient(cx, cy, dx, dy, ax, ay);
  const d2 = orient(cx, cy, dx, dy, bx, by);
  const d3 = orient(ax, ay, bx, by, cx, cy);
  const d4 = orient(ax, ay, bx, by, dx, dy);
  return ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0));
}

/** 두 선분 사이 최소거리² — 지우개가 빠르게 움직여도 사이의 획을 놓치지 않기 위해 사용 */
export function distSegmentToSegmentSq(
  ax: number, ay: number, bx: number, by: number,
  cx: number, cy: number, dx: number, dy: number,
): number {
  if (segmentsIntersect(ax, ay, bx, by, cx, cy, dx, dy)) return 0;
  return Math.min(
    distPointToSegmentSq(ax, ay, cx, cy, dx, dy),
    distPointToSegmentSq(bx, by, cx, cy, dx, dy),
    distPointToSegmentSq(cx, cy, ax, ay, bx, by),
    distPointToSegmentSq(dx, dy, ax, ay, bx, by),
  );
}

/** even-odd 규칙 point-in-polygon. poly = [x0,y0,x1,y1,...] */
export function pointInPolygon(x: number, y: number, poly: ArrayLike<number>): boolean {
  let inside = false;
  const n = poly.length;
  for (let i = 0, j = n - 2; i < n; j = i, i += 2) {
    const xi = poly[i];
    const yi = poly[i + 1];
    const xj = poly[j];
    const yj = poly[j + 1];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** 2D affine [a, b, c, d, e, f]: x' = a*x + c*y + e, y' = b*x + d*y + f (Canvas/PDF 규약) */
export type Affine = [number, number, number, number, number, number];

export const IDENTITY: Affine = [1, 0, 0, 1, 0, 0];

export function affineApply(m: Affine, x: number, y: number): [number, number] {
  return [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
}

export function affineTranslate(dx: number, dy: number): Affine {
  return [1, 0, 0, 1, dx, dy];
}

/** (ox, oy) 를 고정점으로 하는 스케일 */
export function affineScaleAbout(ox: number, oy: number, sx: number, sy: number): Affine {
  return [sx, 0, 0, sy, ox - ox * sx, oy - oy * sy];
}

/** m2 ∘ m1 (m1 먼저 적용) */
export function affineMultiply(m2: Affine, m1: Affine): Affine {
  return [
    m2[0] * m1[0] + m2[2] * m1[1],
    m2[1] * m1[0] + m2[3] * m1[1],
    m2[0] * m1[2] + m2[2] * m1[3],
    m2[1] * m1[2] + m2[3] * m1[3],
    m2[0] * m1[4] + m2[2] * m1[5] + m2[4],
    m2[1] * m1[4] + m2[3] * m1[5] + m2[5],
  ];
}

export const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v);
export const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;
