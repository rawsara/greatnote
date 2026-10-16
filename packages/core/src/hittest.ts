import {
  bboxAddPoint, bboxOfFlat, distPointToSegmentSq, distSegmentToSegmentSq, emptyBBox, type BBox,
} from './geometry';
import { STRIDE, type InkObject, type StrokeObj } from './model';
import { shapeToPolyline, tapePolygon } from './shapes';

const bboxCache = new WeakMap<InkObject, BBox>();

/** 객체의 bbox (렌더 영역 포함). 객체는 불변으로 다루므로 WeakMap 캐시가 안전하다 */
export function objectBBox(o: InkObject): BBox {
  let b = bboxCache.get(o);
  if (b) return b;
  switch (o.type) {
    case 'stroke': {
      let maxW = 0;
      for (let i = 2; i < o.pts.length; i += STRIDE) if (o.pts[i] > maxW) maxW = o.pts[i];
      b = bboxOfFlat(o.pts, STRIDE, (maxW * o.width) / 2 + 1);
      break;
    }
    case 'shape': {
      b = emptyBBox();
      const pad = o.width / 2 + (o.shape === 'arrow' ? 10 + o.width * 3 : 1);
      bboxAddPoint(b, o.x1, o.y1, pad);
      bboxAddPoint(b, o.x2, o.y2, pad);
      break;
    }
    case 'tape':
      b = bboxOfFlat(tapePolygon(o), 2, 1);
      break;
  }
  bboxCache.set(o, b);
  return b;
}

const polyCache = new WeakMap<InkObject, number[]>();

/** 판정용 중심선 포인트 (stride 3) */
export function objectPoints(o: InkObject): number[] {
  if (o.type === 'stroke') return o.pts;
  let p = polyCache.get(o);
  if (!p) {
    p = o.type === 'shape' ? shapeToPolyline(o) : [o.x1, o.y1, 1, (o.x1 + o.x2) / 2, (o.y1 + o.y2) / 2, 1, o.x2, o.y2, 1];
    polyCache.set(o, p);
  }
  return p;
}

/** 지우개가 지나간 선분 (ax,ay)-(bx,by), 반경 r 에 객체가 닿는지 */
export function hitObject(o: InkObject, ax: number, ay: number, bx: number, by: number, r: number): boolean {
  if (o.type === 'tape') {
    const lim = r + o.thickness / 2;
    return distSegmentToSegmentSq(ax, ay, bx, by, o.x1, o.y1, o.x2, o.y2) <= lim * lim;
  }
  const pts = objectPoints(o);
  const width = o.width;
  const n = pts.length / STRIDE;
  if (n === 1) {
    const lim = r + (pts[2] * width) / 2;
    return distPointToSegmentSq(pts[0], pts[1], ax, ay, bx, by) <= lim * lim;
  }
  for (let i = 0; i < n - 1; i++) {
    const k = i * STRIDE;
    const lim = r + (Math.max(pts[k + 2], pts[k + 5]) * width) / 2;
    if (distSegmentToSegmentSq(ax, ay, bx, by, pts[k], pts[k + 1], pts[k + 3], pts[k + 4]) <= lim * lim) return true;
  }
  return false;
}

/** 탭 위치에 있는 테이프 찾기용 */
export function pointHitsTape(o: InkObject, x: number, y: number, slop = 2): boolean {
  if (o.type !== 'tape') return false;
  const lim = o.thickness / 2 + slop;
  return distPointToSegmentSq(x, y, o.x1, o.y1, o.x2, o.y2) <= lim * lim;
}

export function isHighlighter(o: InkObject): o is StrokeObj {
  return o.type === 'stroke' && o.tool === 'highlighter';
}
