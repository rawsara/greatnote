const ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyz';

/** 충돌 확률이 무시 가능한 랜덤 ID (36^16 ≈ 8e24) — 오프라인에서도 기기별로 독립 생성 */
export function newId(len = 16): string {
  const bytes = new Uint8Array(len);
  (globalThis as unknown as { crypto: { getRandomValues(a: Uint8Array): Uint8Array } }).crypto.getRandomValues(bytes);
  let s = '';
  for (let i = 0; i < len; i++) s += ALPHABET[bytes[i] % 36];
  return s;
}
