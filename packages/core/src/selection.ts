import {
  affineApply, bboxIntersects, bboxOfFlat, bboxUnion, emptyBBox, pointInPolygon, type Affine, type BBox,
} from './geometry';
import { objectBBox, objectPoints } from './hittest';
import { STRIDE, type InkObject } from './model';

/**
 * 올가미 선택: 객체 포인트 중 ratio 이상이 올가미 폴리곤 안에 있으면 선택.
 * (GoodNotes 처럼 "대부분 감싼" 획만 잡히고, 살짝 걸친 획은 제외)
 */
export function lassoSelect(objects: Iterable<InkObject>, lasso: number[], ratio = 0.5): string[] {
  if (lasso.length < 6) return [];
  const lb = bboxOfFlat(lasso, 2);
  const out: string[] = [];
  for (const o of objects) {
    if (!bboxIntersects(objectBBox(o), lb)) continue;
    const pts = objectPoints(o);
    const n = pts.length / STRIDE;
    let inside = 0;
    for (let i = 0; i < n; i++) if (pointInPolygon(pts[i * STRIDE], pts[i * STRIDE + 1], lasso)) inside++;
    if (n > 0 && inside / n >= ratio) out.push(o.id);
  }
  return out;
}

export function selectionBBox(objects: Iterable<InkObject>): BBox {
  let b = emptyBBox();
  for (const o of objects) b = bboxUnion(b, objectBBox(o));
  return b;
}

/**
 * 객체에 affine 변환(이동/스케일)을 적용한 새 객체를 반환 (id 유지).
 * 굵기는 면적 스케일의 제곱근으로 조정해 확대/축소 시 비율이 자연스럽다.
 */
export function transformObject<T extends InkObject>(o: T, m: Affine): T {
  const ws = Math.sqrt(Math.abs(m[0] * m[3] - m[1] * m[2])) || 1;
  switch (o.type) {
    case 'stroke': {
      const pts = new Array<number>(o.pts.length);
      for (let i = 0; i < o.pts.length; i += STRIDE) {
        const [x, y] = affineApply(m, o.pts[i], o.pts[i + 1]);
        pts[i] = Math.round(x * 100) / 100;
        pts[i + 1] = Math.round(y * 100) / 100;
        pts[i + 2] = o.pts[i + 2];
      }
      return { ...o, pts, width: o.width * ws };
    }
    case 'shape':
    case 'tape': {
      const [x1, y1] = affineApply(m, o.x1, o.y1);
      const [x2, y2] = affineApply(m, o.x2, o.y2);
      return o.type === 'shape'
        ? { ...o, x1, y1, x2, y2, width: o.width * ws }
        : { ...o, x1, y1, x2, y2, thickness: o.thickness * ws };
    }
  }
}
