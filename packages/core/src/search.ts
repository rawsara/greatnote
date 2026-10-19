/**
 * 노트 검색: 손글씨(인식 결과) · 텍스트 상자 · PDF 글자를 한 번에 찾는다.
 *
 * 손글씨 인식기는 단어를 잘못 끊는 일이 많아서(특히 한글), 공백을 무시한 "글자 흐름"에서
 * 검색어를 찾는다. 예: 인식이 "기말 고사" / "기말고사" / "기 말고사" 어느 쪽이든 "기말고사"로 찾힘.
 */
import { bboxUnion, emptyBBox, type BBox } from './geometry';
import { objectBBox } from './hittest';
import type { HwrWord, InkObject, Page, StrokeObj } from './model';
import type { TextItem } from './textsnap';

export const hwrKey = (pageId: string): string => `hwr-${pageId}`;

/** 인식 대상인 필기 획 (형광펜·밑줄 제외) */
export function isHandwriting(o: InkObject): o is StrokeObj {
  return o.type === 'stroke' && o.tool !== 'highlighter' && o.tool !== 'underline';
}

/**
 * 페이지 필기 획 집합의 서명. 획이 추가·삭제·이동되면 바뀐다 (색 변경은 무시).
 * 인식 결과를 언제 다시 만들지 판단하는 데 쓴다.
 */
export function inkSignature(objs: Iterable<InkObject>): string {
  const parts: string[] = [];
  for (const o of objs) {
    if (!isHandwriting(o)) continue;
    const b = objectBBox(o);
    parts.push(`${o.id}@${Math.round(b.minX)},${Math.round(b.minY)}`);
  }
  if (!parts.length) return '0';
  parts.sort();
  let h = 0x811c9dc5;
  for (const p of parts) for (let i = 0; i < p.length; i++) h = Math.imul(h ^ p.charCodeAt(i), 0x01000193);
  return `${parts.length}:${(h >>> 0).toString(36)}`;
}

/** 검색용 정규화: 호환 문자 통합(NFKC) + 소문자 */
export function normalizeChar(c: string): string {
  return c.normalize('NFKC').toLowerCase().replace(/\s+/g, '');
}

export function normalizeQuery(q: string): string {
  return q.normalize('NFKC').toLowerCase().replace(/\s+/g, '');
}

interface Tok {
  t: string;
  alt?: string[];
  x: number;
  y: number;
  w: number;
  h: number;
}

interface Hit {
  rects: BBox[];
  /** 토큰 범위 (스니펫용) */
  from: number;
  to: number;
}

/** 토큰 열(읽는 순서)에서 검색어 위치 찾기 — 공백 무시, 글자 위치는 토큰 폭에 비례해 추정 */
function matchTokens(toks: Tok[], q: string): Hit[] {
  if (!q) return [];
  const chars: string[] = [];
  const owner: number[] = [];
  const frac: Array<[number, number]> = [];
  toks.forEach((tk, ti) => {
    const arr = [...tk.t];
    arr.forEach((c, ci) => {
      for (const n of normalizeChar(c)) {
        chars.push(n);
        owner.push(ti);
        frac.push([ci / arr.length, (ci + 1) / arr.length]);
      }
    });
  });
  const qn = [...q].length;
  const hits: Hit[] = [];
  const covered = new Set<number>();
  // 문자열 인덱스(UTF-16) ↔ 글자 인덱스 변환을 피하기 위해 글자 배열에서 직접 검색
  for (let i = 0; i + qn <= chars.length; i++) {
    let ok = true;
    let k = i;
    for (const qc of q) {
      if (chars[k++] !== qc) {
        ok = false;
        break;
      }
    }
    if (!ok) continue;
    const per = new Map<number, [number, number]>();
    for (let j = i; j < i + qn; j++) {
      const r = per.get(owner[j]);
      per.set(owner[j], r ? [Math.min(r[0], frac[j][0]), Math.max(r[1], frac[j][1])] : [...frac[j]]);
    }
    const rects: BBox[] = [];
    for (const [ti, [a, b]] of per) {
      const tk = toks[ti];
      covered.add(ti);
      rects.push({ minX: tk.x + tk.w * a, minY: tk.y, maxX: tk.x + tk.w * b, maxY: tk.y + tk.h });
    }
    hits.push({ rects, from: owner[i], to: owner[i + qn - 1] });
    i += qn - 1;
  }
  // 다른 인식 후보에만 있는 경우 (예: 1순위 "기밀", 2순위 "기말")
  toks.forEach((tk, ti) => {
    if (covered.has(ti) || !tk.alt?.length) return;
    if (tk.alt.some((a) => normalizeQuery(a).includes(q))) {
      hits.push({ rects: [{ minX: tk.x, minY: tk.y, maxX: tk.x + tk.w, maxY: tk.y + tk.h }], from: ti, to: ti });
    }
  });
  return hits;
}

function snippet(toks: Tok[], from: number, to: number): string {
  const a = Math.max(0, from - 4), b = Math.min(toks.length, to + 5);
  const s = toks.slice(a, b).map((t) => t.t).join(' ').replace(/\s+/g, ' ').trim();
  return (a > 0 ? '… ' : '') + s + (b < toks.length ? ' …' : '');
}

export type SearchKind = 'ink' | 'text' | 'pdf';

export interface SearchHit {
  pageId: string;
  pageIndex: number;
  kind: SearchKind;
  /** 페이지 좌표의 강조 영역 */
  rects: BBox[];
  /** 전체 강조 영역 (스크롤 대상) */
  bbox: BBox;
  snippet: string;
  /** 텍스트 상자 결과일 때 */
  objId?: string;
  /** 텍스트 상자 안의 위치 (글자 인덱스) */
  start?: number;
  length?: number;
}

export interface SearchSource {
  pages: Page[];
  objects(pageId: string): InkObject[];
  hwr(pageId: string): { words: HwrWord[] } | undefined;
}

export interface SearchOptions {
  /** PDF 배경 페이지의 텍스트 (없으면 PDF 글자는 건너뜀) */
  pdfItems?: (page: Page) => TextItem[] | null | undefined;
  kinds?: SearchKind[];
  limit?: number;
}

/** PDF 텍스트 조각 → 토큰 (pdf.js 는 조각 단위 폭만 주므로 단어로 나눠 글자 수 비례 배분) */
function pdfTokens(items: TextItem[]): Tok[] {
  const out: Tok[] = [];
  const sorted = [...items].sort((a, b) => a.baseline - b.baseline || a.x - b.x);
  for (const it of sorted) {
    const n = it.str.length;
    if (!n || it.width <= 0) continue;
    const re = /\S+/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(it.str))) {
      out.push({
        t: m[0],
        x: it.x + (it.width * m.index) / n,
        y: it.baseline - it.height,
        w: (it.width * m[0].length) / n,
        h: it.height * 1.2,
      });
    }
  }
  return out;
}

export function searchDocument(src: SearchSource, query: string, opts: SearchOptions = {}): SearchHit[] {
  const q = normalizeQuery(query);
  if (!q) return [];
  const kinds = new Set(opts.kinds ?? ['ink', 'text', 'pdf']);
  const limit = opts.limit ?? 500;
  const out: SearchHit[] = [];
  const push = (h: Omit<SearchHit, 'bbox'>) => {
    let b = emptyBBox();
    for (const r of h.rects) b = bboxUnion(b, r);
    out.push({ ...h, bbox: b });
  };

  src.pages.forEach((page, pageIndex) => {
    if (out.length >= limit) return;
    const start = out.length;
    if (kinds.has('ink')) {
      const words = src.hwr(page.id)?.words ?? [];
      const toks = words.filter((w) => w.t.trim() || w.alt?.length);
      for (const h of matchTokens(toks, q)) {
        push({ pageId: page.id, pageIndex, kind: 'ink', rects: h.rects, snippet: snippet(toks, h.from, h.to) });
      }
    }
    if (kinds.has('text')) {
      for (const o of src.objects(page.id)) {
        if (o.type !== 'text' || !o.text) continue;
        // 텍스트 상자: 원문 글자 인덱스를 함께 반환 (화면에서 줄 배치에 맞춰 강조)
        const chars = [...o.text];
        const norm: string[] = [];
        const map: number[] = [];
        chars.forEach((c, i) => {
          for (const n of normalizeChar(c)) {
            norm.push(n);
            map.push(i);
          }
        });
        const qa = [...q];
        for (let i = 0; i + qa.length <= norm.length; i++) {
          if (!qa.every((c, j) => norm[i + j] === c)) continue;
          const s = map[i], e = map[i + qa.length - 1] + 1;
          const a = Math.max(0, s - 18), b = Math.min(chars.length, e + 18);
          push({
            pageId: page.id, pageIndex, kind: 'text', objId: o.id, start: s, length: e - s,
            rects: [{ minX: o.x, minY: o.y, maxX: o.x + o.w, maxY: o.y + o.h }],
            snippet: (a > 0 ? '… ' : '') + chars.slice(a, b).join('').replace(/\s+/g, ' ') + (b < chars.length ? ' …' : ''),
          });
          i += qa.length - 1;
        }
      }
    }
    if (kinds.has('pdf') && page.bg.kind === 'pdf' && opts.pdfItems) {
      const items = opts.pdfItems(page);
      if (items?.length) {
        const toks = pdfTokens(items);
        for (const h of matchTokens(toks, q)) push({ pageId: page.id, pageIndex, kind: 'pdf', rects: h.rects, snippet: snippet(toks, h.from, h.to) });
      }
    }
    // 페이지 안에서는 위→아래, 왼쪽→오른쪽
    out.push(...out.splice(start).sort((a, b) => a.bbox.minY - b.bbox.minY || a.bbox.minX - b.bbox.minX));
  });
  return out.slice(0, limit);
}

/** 문서 전체 검색용 평문 (라이브러리 검색 색인) — 페이지마다 한 줄 */
export function documentPlainText(src: SearchSource): string[] {
  return src.pages.map((p) => {
    const parts: string[] = [];
    for (const w of src.hwr(p.id)?.words ?? []) parts.push(w.t, ...(w.alt ?? []));
    for (const o of src.objects(p.id)) if (o.type === 'text') parts.push(o.text);
    return parts.join(' ').replace(/\s+/g, ' ').trim();
  });
}

/** 평문 색인에서 검색 (공백 무시) — 걸린 페이지 번호들 */
export function searchPlainText(pages: string[], query: string): number[] {
  const q = normalizeQuery(query);
  if (!q) return [];
  const out: number[] = [];
  pages.forEach((t, i) => {
    if (normalizeQuery(t).includes(q)) out.push(i);
  });
  return out;
}

// ───────────────────────── 인식기 입력 준비 ─────────────────────────

export interface InkLine {
  /** 이 줄에 속한 획 id (그린 순서) */
  ids: string[];
  bbox: BBox;
}

/**
 * 필기 획을 "줄" 단위로 묶는다 (획 단위 인식기 — Android ML Kit Digital Ink 등 — 입력용).
 * 세로로 충분히 겹치는 획끼리 같은 줄, 같은 줄 안에서도 가로 간격이 아주 크면 따로 나눈다.
 */
export function groupStrokesIntoLines(strokes: StrokeObj[]): InkLine[] {
  const items = strokes.map((s) => ({ s, b: objectBBox(s) })).filter((it) => it.b.maxX >= it.b.minX);
  if (!items.length) return [];
  const heights = items.map((it) => it.b.maxY - it.b.minY).sort((a, b) => a - b);
  const typical = Math.max(6, heights[Math.floor(heights.length / 2)]);
  // 줄 높이보다 훨씬 큰 획(밑줄 긋기, 큰 그림)은 자기 혼자 한 줄
  const lines: Array<{ items: typeof items; minY: number; maxY: number }> = [];
  const byCenter = [...items].sort((a, b) => (a.b.minY + a.b.maxY) / 2 - (b.b.minY + b.b.maxY) / 2);
  for (const it of byCenter) {
    const h = it.b.maxY - it.b.minY;
    let best: (typeof lines)[number] | null = null;
    let bestOverlap = 0;
    if (h < typical * 4) {
      for (const l of lines) {
        const ov = Math.min(l.maxY, it.b.maxY) - Math.max(l.minY, it.b.minY);
        const ratio = ov / Math.max(1, Math.min(h, l.maxY - l.minY));
        if (ratio > 0.4 && ratio > bestOverlap) {
          best = l;
          bestOverlap = ratio;
        }
      }
    }
    if (best) {
      best.items.push(it);
      // 줄 범위는 너무 커지지 않도록 중앙값 기준으로만 확장
      best.minY = Math.min(best.minY, it.b.minY + h * 0.15);
      best.maxY = Math.max(best.maxY, it.b.maxY - h * 0.15);
    } else lines.push({ items: [it], minY: it.b.minY, maxY: it.b.maxY });
  }
  const out: InkLine[] = [];
  for (const l of lines) {
    const row = [...l.items].sort((a, b) => a.b.minX - b.b.minX);
    let cur: typeof items = [];
    let right = -Infinity;
    const flush = () => {
      if (!cur.length) return;
      let b = emptyBBox();
      for (const it of cur) b = bboxUnion(b, it.b);
      // 인식기에는 그린 순서(z)대로
      out.push({ ids: [...cur].sort((x, y) => x.s.z - y.s.z).map((it) => it.s.id), bbox: b });
      cur = [];
    };
    for (const it of row) {
      if (cur.length && it.b.minX - right > typical * 3) flush();
      cur.push(it);
      right = Math.max(right, it.b.maxX);
    }
    flush();
  }
  return out.sort((a, b) => a.bbox.minY - b.bbox.minY || a.bbox.minX - b.bbox.minX);
}

/**
 * 한 줄 인식 결과(문자열)를 단어로 나누고, 줄 bbox 안에서 글자 수 비례로 위치를 배분.
 * 인식기가 단어 위치를 주지 않을 때 사용.
 */
export function wordsFromLine(text: string, b: BBox, alt?: string[]): HwrWord[] {
  const t = text.trim();
  if (!t) return [];
  const total = [...t].length;
  const w = b.maxX - b.minX;
  const out: HwrWord[] = [];
  const re = /\S+/gu;
  let m: RegExpExecArray | null;
  while ((m = re.exec(t))) {
    const before = [...t.slice(0, m.index)].length;
    const len = [...m[0]].length;
    out.push({ t: m[0], x: b.minX + (w * before) / total, y: b.minY, w: (w * len) / total, h: b.maxY - b.minY });
  }
  if (alt?.length && out.length) out[0].alt = alt.filter((a) => a !== text);
  return out;
}
