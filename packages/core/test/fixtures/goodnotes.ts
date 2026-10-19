/* 테스트 전용: 실제 사용자 파일 없이 굿노트 형식을 재현하는 생성기 */
// ───────── 합성 .goodnotes 생성기 (실제 사용자 파일 없이 테스트) ─────────
export const enc = new TextEncoder();
const cat = (...parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((s, p) => s + p.length, 0));
  let o = 0;
  for (const p of parts) (out.set(p, o), (o += p.length));
  return out;
};
const varint = (n: number) => {
  const b: number[] = [];
  while (n >= 0x80) (b.push((n % 128) | 0x80), (n = Math.floor(n / 128)));
  b.push(n);
  return new Uint8Array(b);
};
const f32 = (x: number) => new Uint8Array(new Float32Array([x]).buffer);
const u16 = (x: number) => new Uint8Array(new Uint16Array([x]).buffer);
const u32 = (x: number) => new Uint8Array(new Uint32Array([x]).buffer);
type F = [number, number | string | Uint8Array | { f: number }];
/** 필드 목록 → protobuf. number=varint, string/Uint8Array=bytes, {f}=fixed32 float */
const pb = (...fields: F[]) =>
  cat(
    ...fields.map(([n, v]) =>
      typeof v === 'number'
        ? cat(varint(n * 8), varint(v))
        : v instanceof Uint8Array
          ? cat(varint(n * 8 + 2), varint(v.length), v)
          : typeof v === 'string'
            ? cat(varint(n * 8 + 2), varint(enc.encode(v).length), enc.encode(v))
            : cat(varint(n * 8 + 5), f32(v.f)),
    ),
  );
const vec = (x: number, y: number) => pb([1, { f: x }], [2, { f: y }]);
const rgba = (r: number, g: number, b: number, a: number) => pb(...([[1, r], [2, g], [3, b], [4, a]] as const).filter(([, v]) => v !== 0).map(([n, v]) => [n, { f: v }] as F));
const records = (...msgs: Uint8Array[]) => cat(...msgs.map((m) => cat(varint(m.length), m)));
/** tpl 블롭을 Apple LZ4 '비압축 블록'으로 감쌈 */
const tpl = (sig: string, data: Uint8Array) => {
  const body = cat(enc.encode('tpl\0'), u32(0), enc.encode(sig + '\0'), data);
  new DataView(body.buffer).setUint32(4, body.length, true);
  return cat(enc.encode('bv4-'), u32(body.length), body, enc.encode('bv4$'));
};
const fl = (...xs: number[]) => cat(...xs.map(f32));
const arrF = (...xs: number[]) => cat(u32(xs.length), fl(...xs));
const arrV = (...xs: number[]) => cat(u32(xs.length), ...xs.map(u16));
export const SIG_PEN = 'vA(v)A(u)A(u)A(v)A(v)A(u)A(u)A(u)A(u)A(v)';
const SIG_CONST = 'vuA(v)A(S(uu))A(S(uuuu))';

/** 펜 획: 시작점 + 2차 구간 하나 */
export const penTpl = (x0: number, y0: number, w0: number, cx: number, cy: number, x1: number, y1: number, w1: number) =>
  tpl(SIG_PEN, cat(u16(2), arrV(0, 1), arrF(x0, y0, w0), arrF(cx, cy, (w0 + w1) / 2, x1, y1, w1), arrV(), arrV(), arrF(), arrF(), arrF(), arrF(), arrV()));
/** 일정 굵기: 시작점 + 구간들 (cx,cy,x,y) */
const constTpl = (w: number, start: [number, number], ...qs: [number, number, number, number][]) =>
  tpl(SIG_CONST, cat(u16(2), f32(w), arrV(0, ...qs.map(() => 1)), u32(1), fl(...start), u32(qs.length), ...qs.map((q) => fl(...q))));

let elemSeq = 0;
/** (헤더, 요소) 레코드 쌍 */
const element = (fieldNo: number, body: Uint8Array) => {
  const id = `E${String(elemSeq++).padStart(3, '0')}-0000-0000-0000-000000000000`;
  return [pb([1, id], [2, pb([1, 2], [2, 1])]), pb([fieldNo, body])];
};
const stroke = (z: number, blob: Uint8Array, extra: F[] = []) =>
  element(7, pb([1, 'S'], [2, blob], [4, rgba(0.1, 0.2, 0.4, 1)], [7, pb([1, pb([1, z])])], ...extra));

/** 구조가 올바른 최소 PDF (빈 페이지 1장, 미디어박스 w×h) */
export function minimalPdf(w = 612, h = 792): Uint8Array {
  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${w} ${h}] /Contents 4 0 R /Resources << >> >>`,
    '<< /Length 39 >>\nstream\n0.9 0.9 0.8 rg 0 0 100 100 re f\nendstream',
  ];
  let body = '%PDF-1.4\n';
  const offsets: number[] = [];
  objs.forEach((o, i) => {
    offsets.push(body.length);
    body += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = body.length;
  body += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n` + offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('');
  body += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return enc.encode(body);
}

const RTF_KO = enc.encode(
  "{\\rtf1\\ansi{\\fonttbl\\f0\\fnil\\fcharset129 AppleSDGothicNeo-Regular;\\f1\\fnil\\fcharset0 HelveticaNeue;}{\\colortbl;\\red255\\green255\\blue255;\\red0\\green0\\blue0;}\\pard\\f0\\fs48 \\cf2 ",
);
export const RTF_KO_TEXT = cat(RTF_KO, new Uint8Array([0xc7, 0xd1, 0xb1, 0xdb]), enc.encode('\\f1  ABC}')); // "한글 ABC"
export const RTF_TITLE = enc.encode('{\\rtf1\\ansi{\\fonttbl\\f0\\fnil\\fcharset0 Helvetica-Bold;}\\pard\\f0\\b\\fs68 \\cf0 Title}');

const gnToken = (cands: string[], x: number, y: number, w: number, h: number) =>
  pb([1, pb([1, vec(x, y)], [2, vec(w, h)])], ...cands.map((c): F => [3, c]), ...cands.map((): F => [4, { f: 0.5 }]));

/** 합성 굿노트 파일 (압축 해제된 형태). 펜·지운 획·형광펜·스티커·사각형·삼각형·텍스트·페이지 텍스트·이미지 포함 */
export function sampleFiles(withPaper = true) {
  elemSeq = 0;
  const NOTE = 'AAAAAAAA-0000-0000-0000-000000000001';
  const PAGE = 'AAAAAAAA-0000-0000-0000-000000000000'; // 굿노트: 페이지 id 와 notes id 는 마지막 자리만 다름
  const page = records(
    ...stroke(5, penTpl(100, 100, 0.4, 150, 80, 200, 100, 0.8)),
    ...stroke(6, penTpl(0, 0, 1, 1, 1, 2, 2, 1), [[14, 1]]), // 지운 획
    ...stroke(7, constTpl(20, [100, 300], [150, 300, 200, 300]), [[5, 1]]), // 형광펜
    ...stroke(8, constTpl(4, [0, 0], [5, 0, 10, 0]), [[6, vec(500, 600)], [10, 'GROUP-1'], [7, pb([1, pb([1, 8], [3, 2])])]]), // 스티커 조각 (오프셋)
    ...element(7, pb([1, 'R'], [2, constTpl(1.8, [0, 0])], [4, rgba(1, 0, 0, 1)], [7, pb([1, pb([1, 9])])], [9, pb([3, pb([1, vec(300, 200)], [2, vec(100, 50)])], [15, { f: 1.8 }])])), // 사각형
    ...element(7, pb([1, 'T'], [2, constTpl(1.8, [0, 0])], [4, rgba(0, 0, 0, 1)], [7, pb([1, pb([1, 10])])], [9, pb([1, cat(pb([1, vec(10, 10)]), pb([1, vec(60, 10)]), pb([1, vec(35, 50)]), pb([1, vec(10, 10)]))], [15, { f: 1.8 }])])), // 삼각형
    ...element(8, pb([1, 'X'], [2, pb([1, vec(400, 40)], [2, vec(120, 50)])], [3, pb([1, vec(410, 50)], [2, vec(100, 30)])], [5, pb([1, pb([1, 11])])], [6, RTF_KO_TEXT])),
    ...element(12, pb([1, 'P'], [3, RTF_TITLE])),
    pb([1, 'IMG-HEADER'], [4, 'ATT-IMG']),
    pb([1, pb([1, 'IMG'], [2, pb([1, vec(300, 500)], [2, vec(200, 100)])], [4, 'ATT-IMG'], [5, pb([1, pb([1, 4])])])]),
  );
  const files = new Map<string, Uint8Array>([
    ['schema.pb', new Uint8Array([0x08, 0x18])],
    ['index.notes.pb', records(pb([1, NOTE], [2, `notes/${NOTE}`]))],
    [`notes/${NOTE}`, page],
    ['attachments/ATT-IMG', new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3])],
    ['attachments/ATT-TPL', minimalPdf()],
    // 굿노트 손글씨 인식 결과: "기말 고사" (공백 토큰 포함), 두 번째 단어는 1순위가 틀리고 2순위가 맞음
    [`search/${NOTE}`, pb(
      [5, PAGE],
      [6, gnToken(['기말', '기밀'], 100, 100, 60, 30)],
      [6, gnToken([' ', ' '], 160, 100, 10, 30)],
      [6, gnToken(['고시', '고사'], 170, 100, 60, 30)],
    )],
  ]);
  if (withPaper) {
    files.set(
      'index.events.pb',
      records(
        pb([1, 'DOC'], [30, pb([1, 'DOC'], [2, pb([1, '샘플 노트'])])]),
        pb([1, 'PAPER'], [2, pb([1, 'DOC'], [2, 'PAPER'], [4, 'ATT-TPL'], [5, 1], [6, 1], [8, vec(1122, 1452)])]),
        pb([1, PAGE], [54, pb([1, 'DOC'], [2, PAGE], [3, pb([1, 'PAPER'])], [4, pb([1, 'a0'])])]),
      ),
    );
  }
  return files;
}

