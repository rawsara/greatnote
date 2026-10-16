import type { Op } from './crdt';

/**
 * 웹/모바일 클라이언트 ↔ 동기화 서버 WebSocket 프로토콜.
 *
 *  C→S hello  {docId, clientId, since}   since 이후 바뀐 엔트리를 요청
 *  S→C ops    {docId, ops, seq}          catch-up 또는 다른 기기 변경 브로드캐스트
 *  C→S push   {docId, batch, ops}        로컬 변경 업로드 (오프라인 큐 포함)
 *  S→C ack    {docId, batch, seq}        서버 반영 확인 → 클라이언트 outbox 에서 제거
 *
 * 서버는 LWW 상태 + 엔트리별 seq 만 보관하므로 로그가 무한히 커지지 않고,
 * 재접속 시 "since 이후 seq 가 바뀐 엔트리"만 내려주면 된다.
 */
export type ClientMsg =
  | { type: 'hello'; docId: string; clientId: string; since: number }
  | { type: 'push'; docId: string; batch: string; ops: Op[] };

export type ServerMsg =
  | { type: 'ops'; docId: string; ops: Op[]; seq: number }
  | { type: 'ack'; docId: string; batch: string; seq: number }
  | { type: 'error'; message: string };

export interface RemoteDocInfo {
  id: string;
  title: string;
  seq: number;
  updatedAt: number;
}
