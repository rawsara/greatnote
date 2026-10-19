/**
 * 굿노트의 자기 기술형 직렬화 "tpl".
 *   "tpl\0" + u32(전체 길이) + 시그니처 문자열 + "\0" + 리틀엔디언 데이터
 * 시그니처: v = u16, u = 32비트(실제로는 float), f = float32, A(T) = u32 개수 + T×개수, S(...) = 구조체
 * 예) "vA(v)A(u)A(u)..." → [버전, 노드 종류들, 시작점, 구간들, ...]
 */
export type TplType = string | { a: TplType } | { s: TplType[] };
export type TplValue = number | TplValue[];

export function parseSignature(sig: string): TplType[] {
  let i = 0;
  const seq = (end: string | null): TplType[] => {
    const out: TplType[] = [];
    while (i < sig.length && sig[i] !== end) out.push(one());
    if (end) i++; // ')' 소비
    return out;
  };
  const one = (): TplType => {
    const c = sig[i++];
    if (c === 'A' || c === 'S') {
      if (sig[i++] !== '(') throw new SyntaxError(`tpl: expected ( in ${sig}`);
      const inner = seq(')');
      if (c === 'A') {
        if (inner.length !== 1) throw new SyntaxError(`tpl: array needs one type in ${sig}`);
        return { a: inner[0] };
      }
      return { s: inner };
    }
    if (!'vuf'.includes(c)) throw new SyntaxError(`tpl: unknown type '${c}' in ${sig}`);
    return c;
  };
  return seq(null);
}

export interface Tpl {
  signature: string;
  values: TplValue[];
}

export function readTpl(b: Uint8Array): Tpl {
  if (b[0] !== 0x74 || b[1] !== 0x70 || b[2] !== 0x6c || b[3] !== 0) throw new SyntaxError('tpl: bad magic');
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  let end = 8;
  while (b[end] !== 0) end++;
  const signature = new TextDecoder().decode(b.subarray(8, end));
  let i = end + 1;
  const rd = (t: TplType): TplValue => {
    if (typeof t === 'string') {
      if (t === 'v') return (i += 2), dv.getUint16(i - 2, true);
      return (i += 4), dv.getFloat32(i - 4, true);
    }
    if ('a' in t) {
      const n = dv.getUint32(i, true);
      i += 4;
      const arr: TplValue[] = new Array(n);
      for (let k = 0; k < n; k++) arr[k] = rd(t.a);
      return arr;
    }
    return t.s.map(rd);
  };
  const values = parseSignature(signature).map(rd);
  if (i !== b.length) throw new RangeError(`tpl: ${b.length - i} trailing bytes`);
  return { signature, values };
}
