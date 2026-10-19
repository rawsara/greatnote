import { describe, expect, it } from 'vitest';
import {
  A4, GN_TO_PT, InkDocument, convertGoodnotes, groupStrokesIntoLines, inkSignature, newId, objectBBox, polygonShape,
  searchDocument, transformObject, wordsFromLine, eraseStep, type HwrWord, type InkObject, type ShapeObj, type StrokeObj,
} from '../src';
import { sampleFiles } from './fixtures/goodnotes';

const src = (d: InkDocument) => ({ pages: d.pages, objects: (id: string) => d.objects(id), hwr: (id: string) => d.hwr(id) });

function docWithWords(words: HwrWord[]) {
  const d = InkDocument.create('a', 'n', [{ ...A4, bg: { kind: 'blank' } }]);
  d.setHwr({ pageId: d.pages[0].id, sig: '0', engine: 'test', words, at: 0 });
  return d;
}

describe('handwriting search', () => {
  it('matches across word breaks the recognizer got wrong', () => {
    const d = docWithWords([
      { t: '기', x: 0, y: 0, w: 10, h: 10 },
      { t: '말고사', x: 12, y: 0, w: 30, h: 10 },
      { t: '공부', x: 50, y: 0, w: 20, h: 10 },
    ]);
    const hits = searchDocument(src(d), '기말 고사');
    expect(hits).toHaveLength(1);
    expect(hits[0].kind).toBe('ink');
    expect(hits[0].rects).toHaveLength(2);
    expect(hits[0].bbox.maxX).toBeCloseTo(42);
  });

  it('highlights only the matched part of a word, case-insensitively', () => {
    const d = docWithWords([{ t: 'ResNet', x: 0, y: 0, w: 60, h: 10 }]);
    const [h] = searchDocument(src(d), 'net');
    expect(h.bbox.minX).toBeCloseTo(30);
    expect(h.bbox.maxX).toBeCloseTo(60);
  });

  it('uses alternative candidates', () => {
    const d = docWithWords([{ t: '기밀', alt: ['기말'], x: 0, y: 0, w: 20, h: 10 }]);
    expect(searchDocument(src(d), '기말')).toHaveLength(1);
  });

  it('finds text boxes with character offsets', () => {
    const d = InkDocument.create('a', 'n', [{ ...A4, bg: { kind: 'blank' } }], [], [[
      { type: 'text', x: 10, y: 10, w: 200, h: 40, text: '오늘의 할 일: 보고서', fontSize: 12, bold: false, color: '#000000' },
    ]]);
    const [h] = searchDocument(src(d), '보고서');
    expect(h).toMatchObject({ kind: 'text', start: 9, length: 3 });
  });

  it('finds PDF text', () => {
    const d = InkDocument.create('a', 'n', [{ ...A4, bg: { kind: 'pdf', assetId: 'x', pageIndex: 0 } }]);
    const hits = searchDocument(src(d), 'world', {
      pdfItems: () => [{ x: 100, baseline: 50, width: 110, height: 10, str: 'hello world' }],
    });
    expect(hits).toHaveLength(1);
    expect(hits[0].bbox.minX).toBeCloseTo(160);
  });

  it('stores recognition results without creating undo steps, and syncs them', () => {
    const d = InkDocument.create('a', 'n', [{ ...A4, bg: { kind: 'blank' } }]);
    const sent: string[] = [];
    d.on((e) => e.origin === 'local' && sent.push(...e.ops.map((o) => o.k)));
    d.setHwr({ pageId: d.pages[0].id, sig: '0', engine: 'test', words: [{ t: 'x', x: 0, y: 0, w: 1, h: 1 }], at: 0 });
    expect(d.canUndo()).toBe(false);
    expect(sent).toEqual(['hwr']);
    const other = InkDocument.fromSnapshot(d.toSnapshot(), 'b');
    expect(other.hwr(d.pages[0].id)?.words[0].t).toBe('x');
  });

  it('changes the ink signature when strokes change, not when unrelated objects do', () => {
    const pageId = 'p';
    const s: StrokeObj = { type: 'stroke', id: 's1', pageId, z: 1, tool: 'pen', color: '#000000', width: 2, opacity: 1, pts: [0, 0, 1, 10, 10, 1] };
    const hl: StrokeObj = { ...s, id: 'h', tool: 'highlighter' };
    const a = inkSignature([s]);
    expect(inkSignature([s, hl])).toBe(a);
    expect(inkSignature([s, { ...s, id: 's2' }])).not.toBe(a);
    expect(inkSignature([{ ...s, pts: [100, 100, 1, 110, 110, 1] }])).not.toBe(a);
  });
});

describe('recognizer input', () => {
  const st = (id: string, x: number, y: number, w = 10, h = 12, z = 1): StrokeObj =>
    ({ type: 'stroke', id, pageId: 'p', z, tool: 'pen', color: '#000000', width: 1.5, opacity: 1, pts: [x, y, 1, x + w, y + h, 1] });

  it('groups strokes into lines and splits far-apart phrases', () => {
    const lines = groupStrokesIntoLines([
      st('a', 0, 0), st('b', 14, 2), st('c', 28, -1),
      st('d', 0, 40), st('e', 16, 41),
      st('f', 300, 0), // 같은 높이지만 멀리 떨어짐
    ]);
    expect(lines.map((l) => l.ids)).toEqual([['a', 'b', 'c'], ['f'], ['d', 'e']]);
  });

  it('spreads a recognized line over its words', () => {
    const w = wordsFromLine('ab cdef', { minX: 0, minY: 0, maxX: 70, maxY: 10 });
    expect(w.map((x) => x.t)).toEqual(['ab', 'cdef']);
    expect(w[1].x).toBeCloseTo(30);
  });
});

describe('GoodNotes handwriting data', () => {
  it('imports GoodNotes recognition results so notes are searchable right away', () => {
    const r = convertGoodnotes(sampleFiles());
    const words = r.pages[0].hwr!;
    expect(words.map((w) => w.t)).toEqual(['기말', '고시']);
    expect(words[1].alt).toEqual(['고사']);
    expect(words[0].x).toBeCloseTo(100 * GN_TO_PT);
    const d = InkDocument.create('a', r.title, r.pages, [], r.pages.map((p) => p.objects), r.pages.map((p) => ({ engine: 'goodnotes', words: p.hwr! })));
    expect(searchDocument(src(d), '기말')).toHaveLength(1);
    expect(searchDocument(src(d), '고사')).toHaveLength(1);
    // 가져온 획 서명이 저장되어 있어 바로 다시 인식하지 않는다
    expect(d.hwr(d.pages[0].id)!.sig).toBe(inkSignature(d.objects(d.pages[0].id)));
  });
});

describe('filled polygon shapes (stickers)', () => {
  const base = polygonShape([0, 0, 20, 0, 10, 20], { color: '#000000', width: 0, fill: '#ffcc00' });
  const tri = { ...base, id: newId(), pageId: 'p', z: 1 } as ShapeObj;

  it('computes the bbox from the vertices', () => {
    expect(objectBBox(tri)).toMatchObject({ minX: -1, maxX: 21, maxY: 21 });
  });

  it('moves vertices when transformed', () => {
    const t = transformObject(tri, [2, 0, 0, 2, 5, 5]);
    expect(t.pts).toEqual([5, 5, 45, 5, 25, 45]);
    expect(t.x2).toBe(45);
  });

  it('is erased whole when the eraser rubs its inside', () => {
    const r = eraseStep([tri as InkObject], 'partial', 10, 8, 10.5, 8, 1, newId);
    expect(r).toEqual({ remove: [tri.id], add: [] });
  });
});
