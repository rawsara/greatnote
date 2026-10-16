import { distPointToSegmentSq } from './geometry';
import { hitObject, isHighlighter, objectBBox, objectPoints } from './hittest';
import { STRIDE, type InkObject, type StrokeObj } from './model';
import { resampleStroke, simplifyStroke } from './simplify';
import { bboxOfSegment, bboxIntersects } from './geometry';

export type EraserMode = 'stroke' | 'partial' | 'highlighter';

export interface EraseResult {
  /** 삭제할 객체 id */
  remove: string[];
  /** 새로 추가할 조각 (부분 지우개) */
  add: StrokeObj[];
}

/**
 * 지우개 한 스텝(이전 위치 → 현재 위치) 처리.
 * - stroke:      닿은 객체 전체 삭제
 * - highlighter: 형광펜 획만 전체 삭제 (필기는 보존)
 * - partial:     닿은 부분만 잘라내고 남은 구간을 새 획으로 분할
 */
export function eraseStep(
  candidates: Iterable<InkObject>,
  mode: EraserMode,
  ax: number, ay: number, bx: number, by: number,
  r: number,
  newId: () => string,
): EraseResult {
  const res: EraseResult = { remove: [], add: [] };
  const sweep = bboxOfSegment(ax, ay, bx, by, r);
  for (const o of candidates) {
    if (!bboxIntersects(objectBBox(o), sweep)) continue;
    if (mode === 'highlighter' && !isHighlighter(o)) continue;
    if (!hitObject(o, ax, ay, bx, by, r)) continue;
    if (mode !== 'partial' || o.type === 'tape') {
      res.remove.push(o.id);
      continue;
    }
    const base: StrokeObj =
      o.type === 'stroke'
        ? o
        : { type: 'stroke', id: o.id, pageId: o.pageId, z: o.z, tool: 'ballpoint', color: o.color, width: o.width, opacity: o.opacity, pts: objectPoints(o) };
    const pieces = splitStroke(base, ax, ay, bx, by, r);
    if (pieces === null) continue;
    res.remove.push(o.id);
    for (const pts of pieces) res.add.push({ ...base, id: newId(), pts });
  }
  return res;
}

/**
 * 부분 지우개: 획을 지우개 반경 이하 간격으로 재샘플링한 뒤,
 * 지우개 캡슐 안에 들어간 포인트를 제거하고 연속 구간들을 반환한다.
 * 닿지 않았으면 null.
 */
export function splitStroke(s: StrokeObj, ax: number, ay: number, bx: number, by: number, r: number): number[][] | null {
  const dense = resampleStroke(s.pts, Math.max(0.25, r * 0.35));
  const n = dense.length / STRIDE;
  const pieces: number[][] = [];
  let cur: number[] = [];
  let erased = false;
  for (let i = 0; i < n; i++) {
    const k = i * STRIDE;
    const lim = r + (dense[k + 2] * s.width) / 4;
    if (distPointToSegmentSq(dense[k], dense[k + 1], ax, ay, bx, by) <= lim * lim) {
      erased = true;
      if (cur.length >= 2 * STRIDE) pieces.push(cur);
      cur = [];
    } else {
      cur.push(dense[k], dense[k + 1], dense[k + 2]);
    }
  }
  if (!erased) return null;
  if (cur.length >= 2 * STRIDE) pieces.push(cur);
  // 재샘플링으로 늘어난 포인트를 다시 줄여 저장 용량 유지
  return pieces.map((p) => simplifyStroke(p, 0.08, s.width));
}
