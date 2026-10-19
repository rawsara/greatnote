import type { HwrWord, ImageObj, InkObject, PageBackground, ShapeObj, StrokeObj, TextObj } from '../model';
import { simplifyStroke } from '../simplify';
import { appleLz4, isAppleLz4 } from './lz4';
import { Msg, readRecords } from './proto';
import { rtfToText } from './rtf';
import { readTpl, type TplValue } from './tpl';

/**
 * 굿노트(.goodnotes) → InkNote 변환.
 *
 * .goodnotes 는 ZIP 이며 (압축 해제는 호출 측에서) 주요 파일은:
 *   index.notes.pb        페이지 목록 (notes/<uuid>)
 *   index.events.pb       문서 이벤트: 용지(크기·템플릿 PDF), 페이지(용지·순서 키), 첨부 등록 — 없을 수도 있음
 *   notes/<uuid>          페이지 내용: (헤더, 요소) 레코드 쌍의 연속
 *   attachments/<uuid>    템플릿 PDF, 이미지
 *
 * 요소 종류 (레코드의 최상위 필드 번호):
 *   7  획/형광펜/도형/스티커 조각   (좌표는 LZ4 압축된 tpl, 색은 RGBA float)
 *   8  텍스트 상자 (위치·크기 + RTF)
 *   12 페이지 텍스트 (좌상단에서 시작해 용지 폭으로 흐르는 문서 타이핑)
 *   1  이미지 (위치·크기 + 첨부 id)  — 단, 1 이 메시지일 때만 (헤더의 1 은 문자열 id)
 */

/** 굿노트 좌표 단위(96dpi 픽셀로 추정) → pt */
export const GN_TO_PT = 0.75;
/** 용지 정보가 없을 때 기본: A4 (굿노트 단위) */
export const GN_A4 = { width: 793.7, height: 1122.5 };
/** 페이지 텍스트 여백 (굿노트 단위, 실제 화면과 비교해 맞춘 값) */
const PAGE_TEXT_INSET = { x: 50, y: 44 };

export type GnObject = Omit<StrokeObj, 'id' | 'pageId' | 'z'> | Omit<ShapeObj, 'id' | 'pageId' | 'z'> | Omit<ImageObj, 'id' | 'pageId' | 'z'> | Omit<TextObj, 'id' | 'pageId' | 'z'>;

export interface GnPage {
  /** pt */
  width: number;
  height: number;
  /** 템플릿: assetId 는 첨부 uuid (호출 측에서 SHA-256 id 로 바꿔야 함) */
  bg: PageBackground;
  /** z 순서대로 정렬됨 */
  objects: GnObject[];
  paperFromFile: boolean;
  /** 굿노트가 만들어 둔 손글씨 인식 결과 (search/<노트 id>) — 바로 검색 가능 */
  hwr?: HwrWord[];
}

export interface GnImport {
  title: string;
  pages: GnPage[];
  /** 실제로 쓰인 첨부 (uuid → 바이트, mime) */
  attachments: Map<string, { bytes: Uint8Array; mime: string }>;
  warnings: string[];
  stats: Record<string, number>;
}

export interface GnOptions {
  /** 용지 정보가 없을 때 쓸 크기 (굿노트 단위). 기본 A4 */
  fallbackPaper?: { width: number; height: number };
  /** 점 단순화 허용 오차 (pt). 0 이면 끄기 */
  simplify?: number;
  /** 진행 상황 (페이지 단위) */
  onProgress?: (done: number, total: number) => void;
}

const f32 = (v: TplValue) => v as number;

/**
 * search/<노트 id>: 굿노트의 손글씨 인식 결과 (protobuf 하나).
 *   5: 페이지 id, 6(반복): 단어 { 1: 영역 {1 원점, 2 크기} (굿노트 단위), 3(반복): 후보 문자열(1순위 먼저) }
 *   공백·줄바꿈도 단어로 들어 있으므로 건너뛴다.
 */
export function readGnSearch(bytes: Uint8Array): HwrWord[] {
  const out: HwrWord[] = [];
  const m = new Msg(bytes);
  for (const f of m.all(6)) {
    const t = new Msg(f.bytes);
    const cands = t.all(3).map((c) => new TextDecoder().decode(c.bytes));
    const best = cands.find((c) => c.trim());
    if (!best || !cands[0].trim()) continue;
    const r = t.msg(1);
    const [x, y] = vec2(r?.msg(1) ?? null);
    const [w, h] = vec2(r?.msg(2) ?? null);
    if (!(w > 0 && h > 0)) continue;
    const word: HwrWord = { t: best, x: x * GN_TO_PT, y: y * GN_TO_PT, w: w * GN_TO_PT, h: h * GN_TO_PT };
    const alt = [...new Set(cands.filter((c) => c !== best && c.trim()))].slice(0, 4);
    if (alt.length) word.alt = alt;
    out.push(word);
  }
  return out;
}
const rgbaOf = (m: Msg | null): [number, number, number, number] =>
  m ? [m.f32(1) ?? 0, m.f32(2) ?? 0, m.f32(3) ?? 0, m.has(4) ? m.f32(4)! : 1] : [0, 0, 0, 1];
const hex = (c: number[]) => '#' + c.slice(0, 3).map((x) => Math.round(Math.max(0, Math.min(1, x)) * 255).toString(16).padStart(2, '0')).join('');
const vec2 = (m: Msg | null): [number, number] => [m?.f32(1) ?? 0, m?.f32(2) ?? 0];

export function sniffMime(b: Uint8Array): string {
  if (b[0] === 0x25 && b[1] === 0x50 && b[2] === 0x44 && b[3] === 0x46) return 'application/pdf';
  if (b[0] === 0xff && b[1] === 0xd8) return 'image/jpeg';
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'image/png';
  if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) return 'image/gif';
  if (b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return 'image/webp';
  if (b[4] === 0x66 && b[5] === 0x74 && b[6] === 0x79 && b[7] === 0x70) return 'image/heic';
  return 'application/octet-stream';
}

type Node = ['M', number, number, number] | ['Q', number, number, number, number, number, number];

/** 노드(시작점 + 2차 베지에 구간, 각 점에 굵기) → 점 배열들 (하위 획마다 하나) */
function sampleSpine(nodes: Node[], ox: number, oy: number): number[][] {
  const subs: number[][] = [];
  let lx = 0, ly = 0, lw = 0;
  for (const n of nodes) {
    if (n[0] === 'M') {
      [, lx, ly, lw] = n;
      subs.push([lx + ox, ly + oy, lw]);
      continue;
    }
    if (!subs.length) subs.push([lx + ox, ly + oy, lw]);
    const [, cx, cy, cw, x, y, w] = n;
    const L = Math.hypot(cx - lx, cy - ly) + Math.hypot(x - cx, y - cy);
    const steps = Math.max(1, Math.min(16, Math.ceil(L / 2)));
    const cur = subs[subs.length - 1];
    for (let k = 1; k <= steps; k++) {
      const t = k / steps, mt = 1 - t;
      cur.push(
        mt * mt * lx + 2 * mt * t * cx + t * t * x + ox,
        mt * mt * ly + 2 * mt * t * cy + t * t * y + oy,
        mt * mt * lw + 2 * mt * t * cw + t * t * w,
      );
    }
    lx = x;
    ly = y;
    lw = w;
  }
  return subs.filter((s) => s.length >= 3);
}

/** tpl 좌표 데이터 → 노드 (시그니처 종류별) */
function nodesFromTpl(sig: string, v: TplValue[]): { nodes: Node[]; constWidth?: number } | null {
  const arr = (x: TplValue) => x as number[];
  if (sig.startsWith('vA(v)A(u)A(u)')) {
    // 일반 펜: [2] 시작점(x,y,w), [3] 구간마다 제어점(x,y,w)+끝점(x,y,w)
    const st = arr(v[2]), sg = arr(v[3]);
    if (st.length < 3) return { nodes: [] };
    const nodes: Node[] = [['M', st[0], st[1], st[2]]];
    for (let k = 0; k + 5 < sg.length; k += 6) nodes.push(['Q', sg[k], sg[k + 1], sg[k + 2], sg[k + 3], sg[k + 4], sg[k + 5]]);
    return { nodes };
  }
  if (sig.startsWith('vuA(v)A(u)A(u)')) {
    // 여러 조각 펜: [2] 노드 코드(2=시작, 3=구간), [3] 시작점들, [4] 구간들
    const codes = arr(v[2]), mv = arr(v[3]), sg = arr(v[4]);
    const nodes: Node[] = [];
    let i = 0, j = 0;
    for (const c of codes) {
      if (c === 2) (nodes.push(['M', mv[i], mv[i + 1], mv[i + 2]]), (i += 3));
      else if (c === 3) (nodes.push(['Q', sg[j], sg[j + 1], sg[j + 2], sg[j + 3], sg[j + 4], sg[j + 5]]), (j += 6));
    }
    return { nodes };
  }
  if (sig.startsWith('vuA(v)A(S(uu))A(S(uuuu))')) {
    // 일정 굵기 (형광펜·스티커·도형): [1] 굵기, [2] 코드(0=시작, 1=구간), [3] 시작점(x,y), [4] 구간(cx,cy,x,y)
    const w = f32(v[1]), codes = arr(v[2]), mv = v[3] as number[][], qs = v[4] as number[][];
    const nodes: Node[] = [];
    let i = 0, j = 0;
    for (const c of codes) {
      if (c === 0) (nodes.push(['M', mv[i][0], mv[i][1], w]), i++);
      else if (c === 1) (nodes.push(['Q', qs[j][0], qs[j][1], w, qs[j][2], qs[j][3], w]), j++);
    }
    return { nodes, constWidth: w };
  }
  return null;
}

/** 도형 (요소 필드 9): 1 = 꺾은선, 2 = 곡선(시작·제어·끝), 3 = 사각형(중심·크기) */
function shapeNodes(g: Msg, fallbackW: number): { nodes: Node[]; rect?: [number, number, number, number]; w: number } | null {
  const w = g.f32(15) ?? fallbackW;
  const poly = g.msg(1);
  if (poly) {
    const pts = poly.all(1).map((f) => vec2(Msg.of(f.bytes)));
    if (pts.length < 2) return null;
    const nodes: Node[] = [['M', pts[0][0], pts[0][1], w]];
    for (const p of pts.slice(1)) nodes.push(['Q', p[0], p[1], w, p[0], p[1], w]);
    return { nodes, w };
  }
  const curve = g.msg(2);
  if (curve) {
    const [a, c, b] = [1, 2, 3].map((k) => vec2(curve.msg(k)));
    return { nodes: [['M', a[0], a[1], w], ['Q', c[0], c[1], w, b[0], b[1], w]], w };
  }
  const rect = g.msg(3);
  if (rect) {
    const [cx, cy] = vec2(rect.msg(1)), [sw, sh] = vec2(rect.msg(2));
    return { nodes: [], rect: [cx - sw / 2, cy - sh / 2, cx + sw / 2, cy + sh / 2], w };
  }
  return null;
}

function toStroke(pts: number[], color: string, opacity: number, tool: StrokeObj['tool'], eps: number): Omit<StrokeObj, 'id' | 'pageId' | 'z'> {
  let base = 0;
  for (let k = 2; k < pts.length; k += 3) base = Math.max(base, pts[k]);
  base = base || 1;
  let out: number[] = [];
  for (let k = 0; k < pts.length; k += 3) out.push(pts[k] * GN_TO_PT, pts[k + 1] * GN_TO_PT, pts[k + 2] / base);
  if (eps > 0 && out.length > 9) out = simplifyStroke(out, eps, base * GN_TO_PT);
  for (let k = 0; k < out.length; k++) out[k] = k % 3 === 2 ? Math.round(out[k] * 1000) / 1000 : Math.round(out[k] * 100) / 100;
  return { type: 'stroke', tool, color, opacity: Math.round(opacity * 1000) / 1000, width: Math.round(base * GN_TO_PT * 1000) / 1000, pts: out };
}

interface Paper {
  width: number;
  height: number;
  template?: string;
  templatePage: number;
}

function readEvents(b: Uint8Array | undefined, warnings: string[]) {
  const papers = new Map<string, Paper>();
  const pages = new Map<string, { paper?: string; order?: string }>();
  let title: string | undefined;
  if (!b) return { papers, pages, title };
  for (const rec of readRecords(b)) {
    let m: Msg;
    try {
      m = new Msg(rec);
    } catch {
      warnings.push('index.events.pb 레코드 해석 실패');
      continue;
    }
    for (const f of m.fields) {
      if (f.w !== 2) continue;
      if (f.n === 30) {
        const d = new Msg(f.bytes);
        title = d.msg(2)?.str(1) ?? title;
      } else if (f.n === 2) {
        const p = new Msg(f.bytes);
        const id = p.str(2);
        const size = p.msg(8);
        if (id && size) papers.set(id, { width: size.f32(1)!, height: size.f32(2)!, template: p.str(4), templatePage: Math.max(0, (p.int(6) ?? 1) - 1) });
      } else if (f.n === 54) {
        const p = new Msg(f.bytes);
        const id = p.str(2);
        if (id) pages.set(id.slice(0, 35), { paper: p.msg(3)?.str(1), order: p.msg(4)?.str(1) });
      }
    }
  }
  return { papers, pages, title };
}

export function convertGoodnotes(files: Map<string, Uint8Array>, opts: GnOptions = {}): GnImport {
  const warnings: string[] = [];
  const stats: Record<string, number> = {};
  const count = (k: string, n = 1) => (stats[k] = (stats[k] ?? 0) + n);
  const eps = opts.simplify ?? 0.05;

  const schema = files.get('schema.pb');
  if (schema && schema.length >= 2 && (schema[0] !== 0x08 || schema[1] > 24)) warnings.push(`처음 보는 굿노트 형식 버전(${schema[1]}) — 일부 내용이 빠질 수 있습니다`);

  const index = files.get('index.notes.pb');
  if (!index) throw new Error('굿노트 파일이 아닙니다 (index.notes.pb 없음)');
  let noteIds = readRecords(index).map((r) => new Msg(r).str(1)!).filter(Boolean);

  const ev = readEvents(files.get('index.events.pb'), warnings);
  // 이벤트에 순서 키가 있으면 그 순서(문자열 정렬)를 따른다
  if (ev.pages.size) {
    const key = (id: string) => ev.pages.get(id.slice(0, 35))?.order;
    if (noteIds.every((id) => key(id))) noteIds = [...noteIds].sort((a, b) => (key(a)! < key(b)! ? -1 : key(a)! > key(b)! ? 1 : 0));
  }
  const listed = new Set(noteIds);
  const orphans = [...files.keys()].filter((k) => k.startsWith('notes/') && !listed.has(k.slice(6)) && files.get(k)!.length);
  if (orphans.length) warnings.push(`페이지 목록에 없는 페이지 데이터 ${orphans.length}개는 굿노트에서 삭제된 페이지로 보고 가져오지 않았습니다`);

  const fallback = opts.fallbackPaper ?? GN_A4;
  // 페이지 기록이 없는 페이지는 노트에서 가장 많이 쓰인 용지를 따른다 (같은 노트는 대개 같은 용지)
  const paperUse = new Map<string, number>();
  for (const id of noteIds) {
    const pid = ev.pages.get(id.slice(0, 35))?.paper;
    if (pid && ev.papers.has(pid)) paperUse.set(pid, (paperUse.get(pid) ?? 0) + 1);
  }
  const commonPaper = [...paperUse.entries()].sort((x, y) => y[1] - x[1])[0]?.[0];
  const usedAttachments = new Set<string>();
  const pages: GnPage[] = [];

  for (const noteId of noteIds) {
    opts.onProgress?.(pages.length, noteIds.length);
    const data = files.get(`notes/${noteId}`) ?? new Uint8Array(0);
    const meta = ev.pages.get(noteId.slice(0, 35));
    const paper = (meta?.paper && ev.papers.get(meta.paper)) || (commonPaper ? ev.papers.get(commonPaper) : undefined);
    type Z = { z: number; sub: number; seq: number; o: GnObject };
    const items: Z[] = [];
    let seq = 0;
    let maxX = 0, maxY = 0;
    const grow = (pts: number[]) => {
      for (let k = 0; k < pts.length; k += 3) {
        if (pts[k] > maxX) maxX = pts[k];
        if (pts[k + 1] > maxY) maxY = pts[k + 1];
      }
    };
    let pageText: { text: string; fontSize: number; bold: boolean; color: string } | null = null;

    for (const rec of readRecords(data)) {
      let m: Msg;
      try {
        m = new Msg(rec);
      } catch {
        count('손상된 레코드');
        continue;
      }
      for (const f of m.fields) {
        if (f.w !== 2) continue;
        try {
          if (f.n === 7) {
            const e = new Msg(f.bytes);
            if (e.has(14)) {
              count('지운 획(제외)');
              continue;
            }
            const order = e.msg(7)?.msg(1);
            const z = order?.int(1) ?? 0, sub = order?.int(3) ?? 0;
            const rgba = rgbaOf(e.msg(4));
            const color = hex(rgba);
            const [ox, oy] = vec2(e.msg(6)); // 복사·이동·스티커 배치 오프셋
            const group = e.str(10);
            const highlighter = e.int(5) === 1;
            const blob = e.bytes(2);
            const shape = e.msg(9);
            let nodes: Node[] | null = null;
            let constW: number | undefined;
            if (shape) {
              const s = shapeNodes(shape, 1.3);
              if (s?.rect) {
                const [x1, y1, x2, y2] = s.rect;
                items.push({ z, sub, seq: seq++, o: { type: 'shape', shape: 'rect', color, opacity: rgba[3], width: s.w * GN_TO_PT, x1: (x1 + ox) * GN_TO_PT, y1: (y1 + oy) * GN_TO_PT, x2: (x2 + ox) * GN_TO_PT, y2: (y2 + oy) * GN_TO_PT, ...(group ? { group } : {}) } });
                maxX = Math.max(maxX, x2 + ox);
                maxY = Math.max(maxY, y2 + oy);
                count('도형');
                continue;
              }
              if (s) ((nodes = s.nodes), (constW = s.w));
            }
            if (!nodes && blob && isAppleLz4(blob)) {
              const t = readTpl(appleLz4(blob));
              const r = nodesFromTpl(t.signature, t.values);
              if (!r) {
                count('알 수 없는 획 형식');
                continue;
              }
              nodes = r.nodes;
              constW = r.constWidth;
            }
            if (!nodes) {
              count('알 수 없는 요소');
              continue;
            }
            const tool: StrokeObj['tool'] = highlighter ? 'highlighter' : constW !== undefined ? 'ballpoint' : 'pen';
            const poly = shape?.msg(1);
            if (poly) {
              // 꺾은선 도형: 꼭짓점을 두 번 넣어 곡선 보정에서도 모서리가 뾰족하게 유지되게 (단순화 X)
              const w = shape!.f32(15) ?? constW ?? 1.3;
              const vs = poly.all(1).map((f) => vec2(Msg.of(f.bytes)));
              const pts: number[] = [];
              vs.forEach(([x, y], i) => {
                const n = i === 0 || i === vs.length - 1 ? 1 : 2;
                for (let k = 0; k < n; k++) pts.push(x + ox, y + oy, w);
              });
              grow(pts);
              const s = toStroke(pts, color, rgba[3], tool, 0);
              items.push({ z, sub, seq: seq++, o: group ? { ...s, group } : s });
              count('도형');
              continue;
            }
            for (const pts of sampleSpine(nodes, ox, oy)) {
              grow(pts);
              const s = toStroke(pts, color, rgba[3], tool, eps);
              items.push({ z, sub, seq: seq++, o: group ? { ...s, group } : s });
            }
            count(highlighter ? '형광펜' : shape ? '도형' : group ? '스티커 조각' : '펜 획');
          } else if (f.n === 8) {
            const e = new Msg(f.bytes);
            const frame = e.msg(2), inner = e.msg(3) ?? frame;
            const [x, y] = vec2(inner?.msg(1) ?? null), [w, h] = vec2(inner?.msg(2) ?? null);
            const rtf = e.bytes(6);
            const t = rtf ? rtfToText(rtf) : { text: '', fontSize: 12, bold: false, color: '#000000' };
            const z = e.msg(5)?.msg(1)?.int(1) ?? 0;
            // 굿노트와 글꼴이 달라 줄이 바뀌지 않도록 폭에 약간 여유
            items.push({ z, sub: 0, seq: seq++, o: { type: 'text', x: x * GN_TO_PT, y: y * GN_TO_PT, w: w * GN_TO_PT * 1.12, h: h * GN_TO_PT, text: t.text, fontSize: t.fontSize * GN_TO_PT, bold: t.bold, color: t.color } });
            maxX = Math.max(maxX, x + w);
            maxY = Math.max(maxY, y + h);
            count('텍스트 상자');
          } else if (f.n === 12) {
            const e = new Msg(f.bytes);
            const rtf = e.bytes(3);
            if (rtf) pageText = rtfToText(rtf);
            count('페이지 텍스트');
          } else if (f.n === 1 && m.fields[0]?.n === 1 && m.fields.length === 1) {
            // 이미지: 레코드 전체가 { 1: {...} } 인 경우
            const e = new Msg(f.bytes);
            const att = e.str(4);
            const frame = e.msg(2);
            if (!att || !frame) continue;
            const [x, y] = vec2(frame.msg(1)), [w, h] = vec2(frame.msg(2));
            const z = e.msg(5)?.msg(1)?.int(1) ?? 0;
            if (!files.get(`attachments/${att}`)) {
              warnings.push('이미지 원본이 파일에 없어 건너뛰었습니다');
              continue;
            }
            usedAttachments.add(att);
            items.push({ z, sub: 0, seq: seq++, o: { type: 'image', assetId: att, x: x * GN_TO_PT, y: y * GN_TO_PT, w: w * GN_TO_PT, h: h * GN_TO_PT, opacity: 1 } });
            maxX = Math.max(maxX, x + w);
            maxY = Math.max(maxY, y + h);
            count('이미지');
          }
        } catch (err) {
          count('해석 실패 요소');
        }
      }
    }

    // 용지: 파일 정보 → 없으면 기본(A4), 내용이 넘치면 비율 유지하며 키움
    let W = paper?.width ?? fallback.width, H = paper?.height ?? fallback.height;
    if (!paper) {
      const k = Math.max(1, (maxX + 8) / W, (maxY + 8) / H);
      W *= k;
      H *= k;
    }
    const objects = items.sort((a, b) => a.z - b.z || a.sub - b.sub || a.seq - b.seq).map((i) => i.o);
    if (pageText && pageText.text) {
      // 페이지 텍스트: 좌상단에서 시작해 용지 폭에 맞춰 흐르는 큰 텍스트 상자 (맨 아래에 깔림)
      objects.unshift({
        type: 'text', flow: true, x: PAGE_TEXT_INSET.x * GN_TO_PT, y: PAGE_TEXT_INSET.y * GN_TO_PT,
        w: (W - PAGE_TEXT_INSET.x * 2) * GN_TO_PT, h: (H - PAGE_TEXT_INSET.y * 2) * GN_TO_PT,
        text: pageText.text, fontSize: pageText.fontSize * GN_TO_PT, bold: pageText.bold, color: pageText.color,
      });
    }
    let bg: PageBackground = { kind: 'blank' };
    if (paper?.template && files.get(`attachments/${paper.template}`)) {
      usedAttachments.add(paper.template);
      bg = { kind: 'pdf', assetId: paper.template, pageIndex: paper.templatePage };
    }
    let hwr: HwrWord[] | undefined;
    const search = files.get(`search/${noteId}`);
    if (search?.length) {
      try {
        hwr = readGnSearch(search);
        count('손글씨 인식 단어', hwr.length);
      } catch {
        count('검색 데이터 해석 실패');
      }
    }
    pages.push({ width: Math.round(W * GN_TO_PT * 100) / 100, height: Math.round(H * GN_TO_PT * 100) / 100, bg, objects, paperFromFile: !!paper, hwr });
  }

  if (pages.some((p) => !p.paperFromFile)) warnings.push('용지 크기 정보가 없는 페이지는 A4 기준으로 맞췄습니다 (내용이 넘치면 비율을 유지해 키움)');
  if (stats['알 수 없는 획 형식'] || stats['알 수 없는 요소'] || stats['해석 실패 요소']) warnings.push('해석하지 못한 요소가 있어 일부 내용이 빠졌을 수 있습니다');

  const attachments = new Map<string, { bytes: Uint8Array; mime: string }>();
  for (const id of usedAttachments) {
    const bytes = files.get(`attachments/${id}`)!;
    attachments.set(id, { bytes, mime: sniffMime(bytes) });
  }
  return { title: ev.title ?? '굿노트에서 가져온 노트', pages, attachments, warnings, stats };
}

export type { InkObject };
