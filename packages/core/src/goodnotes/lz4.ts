/**
 * Apple Compression 프레임 LZ4 ("bv41" 압축 블록 / "bv4-" 비압축 블록 / "bv4$" 끝) 해제.
 * 굿노트는 획 좌표 데이터를 이 형식으로 압축해 protobuf 안에 넣는다.
 */
const MAGIC_LZ4 = 0x31347662; // 'bv41' (little-endian)
const MAGIC_RAW = 0x2d347662; // 'bv4-'
const MAGIC_END = 0x24347662; // 'bv4$'

export function isAppleLz4(b: Uint8Array): boolean {
  return b.length >= 4 && b[0] === 0x62 && b[1] === 0x76 && b[2] === 0x34;
}

export function lz4Block(src: Uint8Array, outLen: number): Uint8Array {
  const dst = new Uint8Array(outLen);
  let i = 0, o = 0;
  while (i < src.length) {
    const tok = src[i++];
    let lit = tok >> 4;
    if (lit === 15) {
      let c: number;
      do {
        c = src[i++];
        lit += c;
      } while (c === 255);
    }
    dst.set(src.subarray(i, i + lit), o);
    i += lit;
    o += lit;
    if (i >= src.length || o >= outLen) break;
    const off = src[i] | (src[i + 1] << 8);
    i += 2;
    if (off === 0) throw new RangeError('lz4: zero offset');
    let ml = tok & 15;
    if (ml === 15) {
      let c: number;
      do {
        c = src[i++];
        ml += c;
      } while (c === 255);
    }
    ml += 4;
    // 겹치는 복사(off < ml)도 바이트 단위로 처리
    for (let k = 0; k < ml; k++) dst[o + k] = dst[o - off + k];
    o += ml;
  }
  if (o !== outLen) throw new RangeError(`lz4: size mismatch ${o} != ${outLen}`);
  return dst;
}

export function appleLz4(b: Uint8Array): Uint8Array {
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const parts: Uint8Array[] = [];
  let i = 0;
  while (i + 4 <= b.length) {
    const magic = dv.getUint32(i, true);
    if (magic === MAGIC_END) break;
    if (magic === MAGIC_LZ4) {
      const dlen = dv.getUint32(i + 4, true), clen = dv.getUint32(i + 8, true);
      parts.push(lz4Block(b.subarray(i + 12, i + 12 + clen), dlen));
      i += 12 + clen;
    } else if (magic === MAGIC_RAW) {
      const dlen = dv.getUint32(i + 4, true);
      parts.push(b.subarray(i + 8, i + 8 + dlen));
      i += 8 + dlen;
    } else throw new RangeError('apple-lz4: bad block magic');
  }
  const total = parts.reduce((s, p) => s + p.length, 0);
  const out = new Uint8Array(total);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}
