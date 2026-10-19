/**
 * 스키마 없는 protobuf 와이어 포맷 리더 (굿노트 .goodnotes 분석용).
 * 64비트 varint(타임스탬프 등)는 정밀도가 깎일 수 있지만 우리는 값을 쓰지 않으므로 무방하다.
 */
export interface Field {
  n: number;
  /** wire type: 0 varint, 1 fixed64, 2 bytes, 5 fixed32 */
  w: number;
  int: number;
  bytes: Uint8Array;
}

export function readVarint(b: Uint8Array, i: number): [number, number] {
  let r = 0;
  let mul = 1;
  for (;;) {
    if (i >= b.length) throw new RangeError('varint overflow');
    const c = b[i++];
    r += (c & 0x7f) * mul;
    mul *= 128;
    if (c < 0x80) return [r, i];
  }
}

const EMPTY = new Uint8Array(0);

export function decodeMessage(b: Uint8Array): Field[] {
  const out: Field[] = [];
  let i = 0;
  while (i < b.length) {
    let key: number;
    [key, i] = readVarint(b, i);
    const n = Math.floor(key / 8), w = key & 7;
    if (w === 0) {
      let v: number;
      [v, i] = readVarint(b, i);
      out.push({ n, w, int: v, bytes: EMPTY });
    } else if (w === 1) {
      out.push({ n, w, int: 0, bytes: b.subarray(i, i + 8) });
      i += 8;
    } else if (w === 5) {
      out.push({ n, w, int: 0, bytes: b.subarray(i, i + 4) });
      i += 4;
    } else if (w === 2) {
      let len: number;
      [len, i] = readVarint(b, i);
      if (i + len > b.length) throw new RangeError('length overflow');
      out.push({ n, w, int: 0, bytes: b.subarray(i, i + len) });
      i += len;
    } else throw new RangeError(`unsupported wire type ${w}`);
  }
  return out;
}

/** varint 길이 접두 레코드들 */
export function readRecords(b: Uint8Array): Uint8Array[] {
  const out: Uint8Array[] = [];
  let i = 0;
  while (i < b.length) {
    let len: number;
    [len, i] = readVarint(b, i);
    out.push(b.subarray(i, i + len));
    i += len;
  }
  return out;
}

/** 필드 번호 → 첫 필드 (편의) */
export class Msg {
  readonly fields: Field[];
  constructor(b: Uint8Array) {
    this.fields = decodeMessage(b);
  }
  static of(b: Uint8Array | undefined): Msg | null {
    return b && b.length ? new Msg(b) : null;
  }
  has(n: number): boolean {
    return this.fields.some((f) => f.n === n);
  }
  get(n: number): Field | undefined {
    return this.fields.find((f) => f.n === n);
  }
  all(n: number): Field[] {
    return this.fields.filter((f) => f.n === n);
  }
  bytes(n: number): Uint8Array | undefined {
    return this.get(n)?.bytes;
  }
  msg(n: number): Msg | null {
    return Msg.of(this.bytes(n));
  }
  str(n: number): string | undefined {
    const b = this.bytes(n);
    return b ? new TextDecoder().decode(b) : undefined;
  }
  int(n: number): number | undefined {
    return this.get(n)?.int;
  }
  f32(n: number): number | undefined {
    const b = this.bytes(n);
    return b && b.length === 4 ? new DataView(b.buffer, b.byteOffset, 4).getFloat32(0, true) : undefined;
  }
  f64(n: number): number | undefined {
    const b = this.bytes(n);
    return b && b.length === 8 ? new DataView(b.buffer, b.byteOffset, 8).getFloat64(0, true) : undefined;
  }
}
