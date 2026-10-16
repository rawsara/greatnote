import { describe, expect, it } from 'vitest';
import {
  A4, InkDocument, PointFilter, STRIDE, SvgPathBuilder, WidthEstimator, TOOL_PRESETS,
  buildOutline, eraseStep, keyBetween, keysBetween, lassoSelect, simplifyStroke, splitStroke,
  transformObject, affineScaleAbout, traceCenterline, type Op, type StrokeObj, newId,
} from '../src';

const stroke = (pts: number[], extra: Partial<StrokeObj> = {}): StrokeObj => ({
  type: 'stroke', id: newId(), pageId: 'p1', z: 1, tool: 'pen', color: '#000000', width: 2, opacity: 1, pts, ...extra,
});

/** (x0,y) → (x1,y) 수평선, step 간격 */
const hline = (x0: number, x1: number, y: number, step = 2) => {
  const pts: number[] = [];
  for (let x = x0; x <= x1; x += step) pts.push(x, y, 1);
  return pts;
};

describe('fractional index', () => {
  it('always generates a key strictly between', () => {
    let a = null as string | null;
    let b = null as string | null;
    const keys: string[] = [];
    // 같은 위치에 반복 삽입해도 항상 사이 키가 존재
    for (let i = 0; i < 200; i++) {
      const k = keyBetween(a, b);
      if (a) expect(k > a).toBe(true);
      if (b) expect(k < b).toBe(true);
      keys.push(k);
      b = k;
    }
    a = keys[5];
    b = keys[4];
    expect(keyBetween(a, b) > a && keyBetween(a, b) < b).toBe(true);
  });
  it('keysBetween yields sorted unique keys', () => {
    const ks = keysBetween(null, null, 50);
    expect([...ks].sort()).toEqual(ks);
    expect(new Set(ks).size).toBe(50);
  });
});

describe('input filter & width', () => {
  it('reduces jitter while tracking a straight line', () => {
    const f = PointFilter.fromStabilization(0.5);
    let maxDev = 0;
    for (let i = 0; i < 200; i++) {
      const jitter = (i % 2 ? 1 : -1) * 1.5;
      const [, y] = f.filter(i * 2, 100 + jitter, i * 8);
      if (i > 10) maxDev = Math.max(maxDev, Math.abs(y - 100));
    }
    expect(maxDev).toBeLessThan(1.5);
  });

  it('pressure makes strokes thicker, speed makes them thinner', () => {
    const run = (pressure: number, speed: number) => {
      const w = new WidthEstimator(TOOL_PRESETS.pen.profile, true);
      let last = 0;
      for (let i = 0; i < 40; i++) last = w.next(i * speed, 0, pressure, i * 8);
      return last;
    };
    expect(run(0.9, 2)).toBeGreaterThan(run(0.2, 2));
    expect(run(0.6, 40)).toBeLessThan(run(0.6, 1));
  });
});

describe('bezier outline', () => {
  it('builds a closed outline enclosing the centerline width', () => {
    const pts = hline(0, 100, 50, 10);
    const poly = buildOutline(pts, 4);
    let minY = Infinity, maxY = -Infinity;
    for (let i = 1; i < poly.length; i += 2) {
      minY = Math.min(minY, poly[i]);
      maxY = Math.max(maxY, poly[i]);
    }
    expect(maxY - minY).toBeCloseTo(4, 1);
  });
  it('emits cubic bezier segments for centerline', () => {
    const b = new SvgPathBuilder();
    traceCenterline(b, [0, 0, 1, 10, 10, 1, 20, 0, 1, 30, 10, 1]);
    expect(b.toString().match(/C/g)?.length).toBe(3);
  });
});

describe('simplify', () => {
  it('drops collinear points but keeps corners', () => {
    const pts = [...hline(0, 100, 0, 1), ...hline(0, 100, 0, 1).map((v, i) => (i % 3 === 0 ? 100 : i % 3 === 1 ? v : 1))];
    const s = simplifyStroke(pts, 0.1, 2);
    expect(s.length / STRIDE).toBeLessThan(6);
  });
});

describe('erasers', () => {
  const ids = () => newId();
  it('stroke eraser removes the whole stroke', () => {
    const s = stroke(hline(0, 100, 50));
    const r = eraseStep([s], 'stroke', 50, 40, 50, 60, 3, ids);
    expect(r.remove).toEqual([s.id]);
    expect(r.add).toEqual([]);
  });
  it('partial eraser splits stroke into two pieces', () => {
    const s = stroke(hline(0, 100, 50));
    const pieces = splitStroke(s, 50, 40, 50, 60, 5)!;
    expect(pieces).toHaveLength(2);
    const lastOfLeft = pieces[0][pieces[0].length - 3];
    const firstOfRight = pieces[1][0];
    expect(lastOfLeft).toBeLessThan(46);
    expect(firstOfRight).toBeGreaterThan(54);
  });
  it('partial eraser leaves untouched strokes alone', () => {
    expect(splitStroke(stroke(hline(0, 100, 50)), 50, 0, 50, 10, 3)).toBeNull();
  });
  it('highlighter eraser only removes highlighter strokes', () => {
    const ink = stroke(hline(0, 100, 50));
    const hl = stroke(hline(0, 100, 50), { tool: 'highlighter', width: 14 });
    const r = eraseStep([ink, hl], 'highlighter', 50, 40, 50, 60, 3, ids);
    expect(r.remove).toEqual([hl.id]);
  });
});

describe('lasso & transform', () => {
  it('selects strokes mostly inside the lasso', () => {
    const inside = stroke(hline(10, 40, 20));
    const half = stroke(hline(30, 120, 20)); // 대부분 밖
    const lasso = [0, 0, 60, 0, 60, 60, 0, 60];
    expect(lassoSelect([inside, half], lasso)).toEqual([inside.id]);
  });
  it('scales points and width', () => {
    const s = stroke([0, 0, 1, 10, 0, 1]);
    const t = transformObject(s, affineScaleAbout(0, 0, 2, 2));
    expect(t.pts).toEqual([0, 0, 1, 20, 0, 1]);
    expect(t.width).toBeCloseTo(4);
    expect(t.id).toBe(s.id);
  });
});

describe('InkDocument CRDT', () => {
  const blank = { ...A4, bg: { kind: 'blank' as const } };

  it('converges regardless of op delivery order', () => {
    const base = InkDocument.create('a', 'note', [blank]);
    const pageId = base.pages[0].id;
    const A = InkDocument.fromSnapshot(base.toSnapshot(), 'a');
    const B = InkDocument.fromSnapshot(base.toSnapshot(), 'b');
    const fromA: Op[] = [];
    const fromB: Op[] = [];
    A.on((e) => e.origin !== 'remote' && fromA.push(...e.ops));
    B.on((e) => e.origin !== 'remote' && fromB.push(...e.ops));

    const s1 = stroke(hline(0, 50, 10), { pageId });
    A.addObjects([s1]);
    B.addObjects([stroke(hline(0, 50, 30), { pageId })]);
    // 동시 편집: A 는 이동, B 는 삭제
    B.apply(fromA.splice(0), 'remote');
    A.updateObjects([transformObject(s1, [1, 0, 0, 1, 5, 5])]);
    B.removeObjects([s1.id]);

    const opsA = fromA.splice(0);
    const opsB = fromB.splice(0);
    A.apply([...opsB].reverse(), 'remote');
    B.apply(opsA, 'remote');
    B.apply(opsA, 'remote'); // 중복 수신도 멱등

    const dump = (d: InkDocument) => d.objects(pageId).map((o) => o.id).sort();
    expect(dump(A)).toEqual(dump(B));
    expect(JSON.stringify(A.toSnapshot().ops.sort((x, y) => (x.id < y.id ? -1 : 1)))).toEqual(
      JSON.stringify(B.toSnapshot().ops.sort((x, y) => (x.id < y.id ? -1 : 1))),
    );
  });

  it('undo/redo restores objects and grouped erases undo in one step', () => {
    const d = InkDocument.create('a', 'note', [blank]);
    const pageId = d.pages[0].id;
    const s1 = stroke(hline(0, 50, 10), { pageId });
    const s2 = stroke(hline(0, 50, 30), { pageId });
    d.addObjects([s1]);
    d.addObjects([s2]);
    d.beginGroup('지우기');
    d.removeObjects([s1.id]);
    d.removeObjects([s2.id]);
    d.endGroup();
    expect(d.objects(pageId)).toHaveLength(0);
    d.undo();
    expect(d.objects(pageId)).toHaveLength(2);
    d.redo();
    expect(d.objects(pageId)).toHaveLength(0);
  });

  it('undo does not clobber a newer remote edit', () => {
    const d = InkDocument.create('a', 'note', [blank]);
    const pageId = d.pages[0].id;
    const s1 = stroke(hline(0, 50, 10), { pageId });
    d.addObjects([s1]);
    const moved = transformObject(s1, [1, 0, 0, 1, 10, 0]);
    d.apply([{ k: 'obj', id: s1.id, s: { c: 999, n: 'z' }, v: moved }]);
    d.undo();
    expect(d.object(s1.id)).toEqual(moved);
  });

  it('page operations keep order', () => {
    const d = InkDocument.create('a', 'note', [blank, blank]);
    const [p1, p2] = d.pages;
    const [p3] = d.insertPages(p1.id, [blank]);
    expect(d.pages.map((p) => p.id)).toEqual([p1.id, p3.id, p2.id]);
    d.movePage(p2.id, -1);
    expect(d.pages.map((p) => p.id)).toEqual([p1.id, p2.id, p3.id]);
    d.deletePage(p1.id);
    expect(d.pages).toHaveLength(2);
    d.undo();
    expect(d.pages).toHaveLength(3);
  });

  it('spatial query finds only nearby objects', () => {
    const d = InkDocument.create('a', 'note', [blank]);
    const pageId = d.pages[0].id;
    const near = stroke(hline(0, 50, 10), { pageId });
    const far = stroke(hline(400, 450, 700), { pageId });
    d.addObjects([near, far]);
    expect(d.query(pageId, { minX: 0, minY: 0, maxX: 60, maxY: 20 }).map((o) => o.id)).toEqual([near.id]);
  });
});
