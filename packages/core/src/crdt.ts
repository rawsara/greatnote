/**
 * 동기화 계층의 핵심: LWW(Last-Writer-Wins) Element Map CRDT.
 *
 * - 문서는 (id → {kind, stamp, value}) 엔트리의 집합이다.
 *   value === null 은 삭제(tombstone).
 * - stamp 는 Lamport 시계 + clientId 로, 전순서(total order)를 이룬다.
 * - 어떤 순서로, 몇 번 중복 수신하더라도 "가장 큰 stamp 의 값"이 남으므로
 *   모든 기기(웹/iOS/Android)와 서버가 같은 상태로 수렴한다(교환·결합·멱등).
 *
 * 획은 대부분 불변(immutable)이라 객체 단위 LWW 로 충분하다.
 *   - 그리기: put
 *   - 이동/크기조절: 같은 id 로 put (변환된 좌표)
 *   - 부분 지우기: 원본 tombstone + 조각들을 새 id 로 put
 */
export interface Stamp {
  /** Lamport counter */
  c: number;
  /** client(device) id */
  n: string;
}

export type EntityKind = 'meta' | 'page' | 'obj' | 'asset';

export interface Op<V = unknown> {
  k: EntityKind;
  id: string;
  s: Stamp;
  v: V | null;
}

export interface Entry<V = unknown> {
  k: EntityKind;
  s: Stamp;
  v: V | null;
}

export function cmpStamp(a: Stamp, b: Stamp): number {
  if (a.c !== b.c) return a.c - b.c;
  return a.n < b.n ? -1 : a.n > b.n ? 1 : 0;
}

export class LwwStore<V = unknown> {
  readonly entries = new Map<string, Entry<V>>();

  get(id: string): Entry<V> | undefined {
    return this.entries.get(id);
  }

  /** 반환값: 상태가 바뀌었는지 */
  apply(op: Op<V>): boolean {
    const cur = this.entries.get(op.id);
    if (cur && cmpStamp(cur.s, op.s) >= 0) return false;
    this.entries.set(op.id, { k: op.k, s: op.s, v: op.v });
    return true;
  }

  toOps(): Op<V>[] {
    const out: Op<V>[] = [];
    for (const [id, e] of this.entries) out.push({ k: e.k, id, s: e.s, v: e.v });
    return out;
  }

  maxClock(): number {
    let m = 0;
    for (const e of this.entries.values()) if (e.s.c > m) m = e.s.c;
    return m;
  }
}
