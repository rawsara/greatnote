/**
 * Fractional indexing — 두 키 사이에 항상 새 키를 만들 수 있는 문자열 순서 키.
 * 페이지 순서를 "배열"이 아니라 "각 페이지의 order 값"으로 저장하므로,
 * 서로 다른 기기에서 동시에 페이지를 추가/이동해도 충돌 없이 병합된다.
 *
 * 키는 base-36 소수부(0.xxxx)로 해석하며 '0' 으로 끝나지 않는다.
 */
const DIGITS = '0123456789abcdefghijklmnopqrstuvwxyz';
const BASE = DIGITS.length;

export function keyBetween(a: string | null, b: string | null): string {
  if (a !== null && b !== null && a >= b) throw new Error(`keyBetween: ${a} >= ${b}`);
  const lo = a ?? '';
  let hi: string | null = b;
  let out = '';
  for (let i = 0; ; i++) {
    const da = i < lo.length ? DIGITS.indexOf(lo[i]) : 0;
    const db = hi !== null ? (i < hi.length ? DIGITS.indexOf(hi[i]) : 0) : BASE;
    if (db - da > 1) return out + DIGITS[(da + db) >> 1];
    out += DIGITS[da];
    // 이 자리에서 hi 보다 작아졌으면 이후 자리는 상한 없음
    if (db > da) hi = null;
  }
}

/** n 개의 균등 분포 키 (PDF 가져오기처럼 페이지를 한꺼번에 만들 때) */
export function keysBetween(a: string | null, b: string | null, n: number): string[] {
  if (n <= 0) return [];
  if (n === 1) return [keyBetween(a, b)];
  const mid = keyBetween(a, b);
  const left = keysBetween(a, mid, Math.floor((n - 1) / 2));
  const right = keysBetween(mid, b, n - 1 - left.length);
  return [...left, mid, ...right];
}
