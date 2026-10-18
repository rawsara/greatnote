import { describe, expect, it } from 'vitest';
import {
  A4, InkDocument, TOOL_PRESETS, WidthEstimator, buildTextLines, estimatePressure, newId, segmentControlPoints,
  snapUnderline, straightenStroke, type StrokeObj, type TextItem,
} from '../src';

const bez = (a: number, b: number, c: number, d: number, t: number) =>
  (1 - t) ** 3 * a + 3 * (1 - t) ** 2 * t * b + 3 * (1 - t) * t * t * c + t ** 3 * d;

describe('centripetal Catmull-Rom → Bézier', () => {
  it('matches uniform Catmull-Rom (1/6 rule) for evenly spaced points', () => {
    const pts = [0, 0, 1, 10, 0, 1, 20, 0, 1, 30, 0, 1];
    const cp = [0, 0, 0, 0];
    segmentControlPoints(pts, 1, 4, cp);
    expect(cp[0]).toBeCloseTo(10 + (20 - 0) / 6);
    expect(cp[2]).toBeCloseTo(20 - (30 - 10) / 6);
  });

  it('does not overshoot when spacing is very uneven', () => {
    // 아주 가까운 점 다음에 먼 점 — uniform Catmull-Rom 은 여기서 크게 튀어나간다
    const pts = [0, 0, 1, 1, 0, 1, 1.5, 0.2, 1, 60, 30, 1];
    const cp = [0, 0, 0, 0];
    segmentControlPoints(pts, 1, 4, cp);
    let minX = Infinity;
    for (let t = 0; t <= 1; t += 0.05) minX = Math.min(minX, bez(1, cp[0], cp[2], 1.5, t));
    expect(minX).toBeGreaterThan(0.95);
  });
});

describe('width model', () => {
  it('estimates pressure from speed when the device has none', () => {
    expect(estimatePressure(0, 2)).toBeGreaterThan(estimatePressure(4, 2));
  });

  it('tapers the start of strokes even with real pressure', () => {
    const w = new WidthEstimator(TOOL_PRESETS.pen.profile, true);
    const first = w.next(0, 0, 0.8, 0);
    let last = first;
    for (let i = 1; i < 40; i++) last = w.next(i * 2, 0, 0.8, i * 8);
    expect(first).toBeLessThan(last * 0.6);
  });
});

describe('PDF text line snapping', () => {
  const items: TextItem[] = [
    { x: 60, baseline: 100, width: 200, height: 12, str: 'Hello world from PDF' },
    { x: 60, baseline: 130, width: 120, height: 12, str: 'second line' },
  ];
  const lines = buildTextLines(items);

  it('groups text into lines and words', () => {
    expect(lines).toHaveLength(2);
    expect(lines[0].words).toHaveLength(4);
  });

  it('snaps a sloppy underline to the baseline and word boundaries', () => {
    // "world from" 를 대충 긋기 (단어 경계보다 짧게/길게, 약간 아래)
    const s = snapUnderline(122, 205, 104.5, lines)!;
    const w = lines[0].words;
    expect(s.x0).toBeCloseTo(w[1][0]);
    expect(s.x1).toBeCloseTo(w[2][1]);
    expect(s.y).toBeGreaterThan(100);
    expect(s.y).toBeLessThan(103);
  });

  it('ignores underlines far from any text', () => {
    expect(snapUnderline(60, 200, 300, lines)).toBeNull();
  });
});

describe('hold-to-straighten', () => {
  it('replaces a wobbly stroke with a straight, axis-snapped line', () => {
    const pts: number[] = [];
    for (let i = 0; i <= 50; i++) pts.push(i * 4, 100 + Math.sin(i) * 3 + i * 0.05, 0.8);
    const s = straightenStroke(pts);
    expect(s).toHaveLength(6);
    expect(s[4]).toBeCloseTo(s[1]); // 수평 스냅
    expect(s[3]).toBeCloseTo(200, 0);
  });
});

describe('change events', () => {
  it('marks newly created objects as fresh (for incremental redraw)', () => {
    const d = InkDocument.create('a', 'n', [{ ...A4, bg: { kind: 'blank' } }]);
    const pageId = d.pages[0].id;
    const s: StrokeObj = { type: 'stroke', id: newId(), pageId, z: 1, tool: 'pen', color: '#000000', width: 2, opacity: 1, pts: [0, 0, 1] };
    const fresh: string[][] = [];
    d.on((e) => fresh.push([...e.fresh]));
    d.addObjects([s]);
    d.updateObjects([{ ...s, color: '#ff0000' }]);
    expect(fresh).toEqual([[s.id], []]);
  });
});
