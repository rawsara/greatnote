import { STRIDE } from './model';

/**
 * Ramer–Douglas–Peucker 단순화 (x, y, w 3차원).
 * w 축은 wScale(=기준 굵기)을 곱해 거리 단위를 맞추므로 굵기 변화가 큰 지점은 보존된다.
 * 저장/동기화 용량을 줄이기 위해 펜을 뗄 때 아주 작은 epsilon 으로 적용한다.
 */
export function simplifyStroke(pts: number[], epsilon: number, wScale: number): number[] {
  const n = pts.length / STRIDE;
  if (n <= 2) return pts.slice();
  const keep = new Uint8Array(n);
  keep[0] = keep[n - 1] = 1;
  const eps2 = epsilon * epsilon;
  const stack: number[] = [0, n - 1];
  while (stack.length) {
    const b = stack.pop()!;
    const a = stack.pop()!;
    let maxD = -1;
    let idx = -1;
    const ax = pts[a * STRIDE], ay = pts[a * STRIDE + 1], aw = pts[a * STRIDE + 2] * wScale;
    const bx = pts[b * STRIDE], by = pts[b * STRIDE + 1], bw = pts[b * STRIDE + 2] * wScale;
    const vx = bx - ax, vy = by - ay, vw = bw - aw;
    const len2 = vx * vx + vy * vy + vw * vw;
    for (let i = a + 1; i < b; i++) {
      const k = i * STRIDE;
      const px = pts[k] - ax, py = pts[k + 1] - ay, pw = pts[k + 2] * wScale - aw;
      let t = len2 > 0 ? (px * vx + py * vy + pw * vw) / len2 : 0;
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      const dx = px - vx * t, dy = py - vy * t, dw = pw - vw * t;
      const d = dx * dx + dy * dy + dw * dw;
      if (d > maxD) {
        maxD = d;
        idx = i;
      }
    }
    if (maxD > eps2 && idx > 0) {
      keep[idx] = 1;
      stack.push(a, idx, idx, b);
    }
  }
  const out: number[] = [];
  for (let i = 0; i < n; i++) if (keep[i]) out.push(pts[i * STRIDE], pts[i * STRIDE + 1], pts[i * STRIDE + 2]);
  return out;
}

/** 저장 전 좌표 양자화 (x,y: 0.01pt, w: 0.001) — JSON 크기 절감 */
export function quantizePoints(pts: number[]): number[] {
  const out = new Array<number>(pts.length);
  for (let i = 0; i < pts.length; i += STRIDE) {
    out[i] = Math.round(pts[i] * 100) / 100;
    out[i + 1] = Math.round(pts[i + 1] * 100) / 100;
    out[i + 2] = Math.round(pts[i + 2] * 1000) / 1000;
  }
  return out;
}

/** 포인트 간 최대 간격이 step 이하가 되도록 선형 보간 삽입 (부분 지우개 정밀도용) */
export function resampleStroke(pts: number[], step: number): number[] {
  const n = pts.length / STRIDE;
  if (n < 2) return pts.slice();
  const out: number[] = [pts[0], pts[1], pts[2]];
  for (let i = 1; i < n; i++) {
    const a = (i - 1) * STRIDE, b = i * STRIDE;
    const d = Math.hypot(pts[b] - pts[a], pts[b + 1] - pts[a + 1]);
    const k = Math.ceil(d / step);
    for (let j = 1; j < k; j++) {
      const t = j / k;
      out.push(
        pts[a] + (pts[b] - pts[a]) * t,
        pts[a + 1] + (pts[b + 1] - pts[a + 1]) * t,
        pts[a + 2] + (pts[b + 2] - pts[a + 2]) * t,
      );
    }
    out.push(pts[b], pts[b + 1], pts[b + 2]);
  }
  return out;
}

/**
 * "그리고 멈추면 직선" — 획을 시작점→끝점 직선으로 바꾼다.
 * 수평/수직에서 ±snapDeg 이내면 정확히 수평/수직으로 맞추고, 굵기는 평균 비율을 쓴다.
 */
export function straightenStroke(pts: number[], snapDeg = 5): number[] {
  const n = pts.length / STRIDE;
  if (n < 2) return pts.slice();
  let w = 0;
  for (let i = 2; i < pts.length; i += STRIDE) w += pts[i];
  w = Math.round((w / n) * 1000) / 1000;
  const x0 = pts[0], y0 = pts[1];
  let x1 = pts[pts.length - 3], y1 = pts[pts.length - 2];
  const ang = (Math.atan2(y1 - y0, x1 - x0) * 180) / Math.PI;
  const len = Math.hypot(x1 - x0, y1 - y0);
  const snapped = Math.round(ang / 90) * 90;
  if (Math.abs(ang - snapped) <= snapDeg) {
    const r = (snapped * Math.PI) / 180;
    x1 = x0 + Math.round(Math.cos(r)) * len;
    y1 = y0 + Math.round(Math.sin(r)) * len;
  }
  return [x0, y0, w, x1, y1, w];
}
