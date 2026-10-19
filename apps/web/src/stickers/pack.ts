import { polygonShape, type DistributiveOmit, type InkObject } from '@inknote/core';

/** 스티커 한 장: (0,0)~(w,h) 상자 안의 벡터 객체들 */
export type StickerItem = DistributiveOmit<InkObject, 'id' | 'pageId' | 'z' | 'group'>;

export interface Sticker {
  id: string;
  name: string;
  w: number;
  h: number;
  objects: StickerItem[];
}

// ── 그리기 도우미 (모두 벡터: 확대해도 선명, PDF 로 내보내도 벡터) ──
const poly = (pts: number[], fill: string, color = '#000000', width = 0) => polygonShape(pts, { fill, color, width });
const circle = (cx: number, cy: number, r: number, fill: string, color = '#000000', width = 0): StickerItem =>
  ({ type: 'shape', shape: 'ellipse', x1: cx - r, y1: cy - r, x2: cx + r, y2: cy + r, fill, color, width, opacity: 1 });
const line = (pts: number[], color: string, width: number): StickerItem => {
  const p: number[] = [];
  for (let i = 0; i < pts.length; i += 2) p.push(pts[i], pts[i + 1], 1);
  return { type: 'stroke', tool: 'marker', color, width, opacity: 1, pts: p };
};
const text = (x: number, y: number, w: number, s: string, fontSize: number, color: string): StickerItem =>
  ({ type: 'text', x, y, w, h: fontSize * 1.3, text: s, fontSize, bold: true, color, align: 'center' });

/** 매개변수 곡선을 다각형으로 */
function sample(n: number, f: (t: number) => [number, number]): number[] {
  const out: number[] = [];
  for (let i = 0; i < n; i++) out.push(...f((i / n) * Math.PI * 2));
  return out.map((v) => Math.round(v * 100) / 100);
}

function star(cx: number, cy: number, r: number, inner = 0.45, points = 5): number[] {
  const out: number[] = [];
  for (let i = 0; i < points * 2; i++) {
    const a = -Math.PI / 2 + (i * Math.PI) / points;
    const rr = i % 2 ? r * inner : r;
    out.push(cx + Math.cos(a) * rr, cy + Math.sin(a) * rr);
  }
  return out.map((v) => Math.round(v * 100) / 100);
}

const heart = (cx: number, cy: number, s: number) =>
  sample(72, (t) => [cx + s * 16 * Math.sin(t) ** 3, cy - s * (13 * Math.cos(t) - 5 * Math.cos(2 * t) - 2 * Math.cos(3 * t) - Math.cos(4 * t))]);

/** 둥근 모서리 사각형 */
function roundRect(x: number, y: number, w: number, h: number, r: number): number[] {
  const out: number[] = [];
  const corner = (cx: number, cy: number, a0: number) => {
    for (let i = 0; i <= 6; i++) {
      const a = a0 + (i / 6) * (Math.PI / 2);
      out.push(cx + Math.cos(a) * r, cy + Math.sin(a) * r);
    }
  };
  corner(x + w - r, y + r, -Math.PI / 2);
  corner(x + w - r, y + h - r, 0);
  corner(x + r, y + h - r, Math.PI / 2);
  corner(x + r, y + r, Math.PI);
  return out.map((v) => Math.round(v * 100) / 100);
}

const label = (id: string, name: string, s: string, fill: string, w = 92): Sticker => ({
  id, name, w, h: 36,
  objects: [poly(roundRect(0, 0, w, 36, 10), fill), text(0, 6, w, s, 18, '#ffffff')],
});

/** 기본 스티커 팩 */
export const BUILTIN_STICKERS: Sticker[] = [
  { id: 'b-star', name: '별', w: 80, h: 80, objects: [poly(star(40, 42, 38), '#fbbf24', '#d97706', 2)] },
  { id: 'b-heart', name: '하트', w: 80, h: 72, objects: [poly(heart(40, 34, 2.3), '#f43f5e', '#be123c', 1.5)] },
  {
    id: 'b-check', name: '체크', w: 72, h: 72,
    objects: [circle(36, 36, 34, '#22c55e'), line([19, 37, 31, 50, 54, 24], '#ffffff', 7)],
  },
  {
    id: 'b-cross', name: '엑스', w: 72, h: 72,
    objects: [circle(36, 36, 34, '#ef4444'), line([23, 23, 49, 49], '#ffffff', 7), line([49, 23, 23, 49], '#ffffff', 7)],
  },
  {
    id: 'b-smile', name: '웃음', w: 80, h: 80,
    objects: [
      circle(40, 40, 37, '#fde047', '#ca8a04', 2), circle(28, 32, 4.5, '#3f2d0c'), circle(52, 32, 4.5, '#3f2d0c'),
      line([23, 48, 30, 56, 40, 59, 50, 56, 57, 48], '#3f2d0c', 4),
    ],
  },
  {
    id: 'b-warn', name: '주의', w: 84, h: 76,
    objects: [poly(roundTriangle(), '#f97316'), line([42, 26, 42, 50], '#ffffff', 7), circle(42, 61, 4, '#ffffff')],
  },
  {
    id: 'b-bubble', name: '말풍선', w: 110, h: 80,
    objects: [poly([...roundRect(2, 2, 106, 58, 16).slice(0, 28), 40, 60, 24, 78, 28, 60, ...roundRect(2, 2, 106, 58, 16).slice(28)], '#ffffff', '#334155', 2)],
  },
  { id: 'b-arrow', name: '화살표', w: 100, h: 56, objects: [poly([0, 18, 60, 18, 60, 0, 100, 28, 60, 56, 60, 38, 0, 38], '#3b82f6')] },
  { id: 'b-bolt', name: '번개', w: 56, h: 90, objects: [poly([34, 0, 4, 52, 26, 52, 18, 90, 52, 34, 30, 34, 42, 0], '#facc15', '#a16207', 1.5)] },
  {
    id: 'b-cloud', name: '구름', w: 110, h: 64,
    objects: [circle(32, 38, 24, '#bae6fd'), circle(58, 28, 28, '#bae6fd'), circle(84, 40, 22, '#bae6fd'), poly(roundRect(14, 36, 86, 26, 12), '#bae6fd')],
  },
  {
    id: 'b-flower', name: '꽃', w: 84, h: 84,
    objects: [poly(sample(90, (t) => { const r = 26 + 14 * Math.cos(5 * t); return [42 + r * Math.cos(t), 42 + r * Math.sin(t)]; }), '#f9a8d4', '#db2777', 1.5), circle(42, 42, 11, '#fde047')],
  },
  {
    id: 'b-pin', name: '압정', w: 48, h: 76,
    objects: [line([24, 40, 24, 74], '#64748b', 3), circle(24, 22, 20, '#ef4444'), circle(17, 15, 5, '#fca5a5')],
  },
  label('b-important', '중요', '중요', '#ef4444', 76),
  label('b-todo', '할 일', '할 일', '#2563eb', 84),
  label('b-exam', '시험 범위', '시험 범위', '#7c3aed', 118),
  label('b-done', '완료', '완료 ✓', '#16a34a', 92),
  ...[1, 2, 3].map((n): Sticker => ({ id: `b-num${n}`, name: `${n}번`, w: 44, h: 44, objects: [circle(22, 22, 21, '#0ea5e9'), text(0, 9, 44, String(n), 22, '#ffffff')] })),
];

function roundTriangle(): number[] {
  return [42, 2, 82, 72, 2, 72];
}
