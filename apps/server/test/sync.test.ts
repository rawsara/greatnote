import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import type { Op, ServerMsg } from '@inknote/core';
import { startServer } from '../src/server';

let srv: Awaited<ReturnType<typeof startServer>>;
let dir: string;

beforeAll(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'inknote-'));
  srv = await startServer({ port: 0, dataDir: dir });
});
afterAll(async () => {
  await srv.close();
  await rm(dir, { recursive: true, force: true });
});

function client() {
  const ws = new WebSocket(`ws://127.0.0.1:${srv.port}/sync`);
  const inbox: ServerMsg[] = [];
  const waiters: Array<() => void> = [];
  ws.on('message', (d) => {
    inbox.push(JSON.parse(String(d)));
    waiters.splice(0).forEach((w) => w());
  });
  const next = async (type: ServerMsg['type']): Promise<ServerMsg> => {
    for (;;) {
      const i = inbox.findIndex((m) => m.type === type);
      if (i >= 0) return inbox.splice(i, 1)[0];
      await new Promise<void>((r) => waiters.push(r));
    }
  };
  return { ws, next, open: new Promise((r) => ws.once('open', r)) };
}

const op = (id: string, c: number, n: string, v: unknown): Op => ({ k: 'obj', id, s: { c, n }, v });

describe('sync server', () => {
  it('relays ops, resolves LWW conflicts, and catches up late joiners', async () => {
    const a = client();
    const b = client();
    await Promise.all([a.open, b.open]);
    a.ws.send(JSON.stringify({ type: 'hello', docId: 'doc1', clientId: 'a', since: 0 }));
    b.ws.send(JSON.stringify({ type: 'hello', docId: 'doc1', clientId: 'b', since: 0 }));
    await a.next('ops');
    await b.next('ops');

    a.ws.send(JSON.stringify({ type: 'push', docId: 'doc1', batch: 'x', ops: [op('s1', 5, 'a', { v: 'A' })] }));
    expect((await a.next('ack')).type).toBe('ack');
    const relayed = (await b.next('ops')) as Extract<ServerMsg, { type: 'ops' }>;
    expect(relayed.ops[0].v).toEqual({ v: 'A' });

    // 낮은 stamp 는 패배 → 브로드캐스트 없음, 상태 유지
    b.ws.send(JSON.stringify({ type: 'push', docId: 'doc1', batch: 'y', ops: [op('s1', 3, 'b', { v: 'B' })] }));
    await b.next('ack');

    const c = client();
    await c.open;
    c.ws.send(JSON.stringify({ type: 'hello', docId: 'doc1', clientId: 'c', since: 0 }));
    const snap = (await c.next('ops')) as Extract<ServerMsg, { type: 'ops' }>;
    expect(snap.ops.find((o) => o.id === 's1')?.v).toEqual({ v: 'A' });

    // since 이후 변경분만 수신
    c.ws.send(JSON.stringify({ type: 'hello', docId: 'doc1', clientId: 'c', since: snap.seq }));
    expect(((await c.next('ops')) as Extract<ServerMsg, { type: 'ops' }>).ops).toHaveLength(0);
    [a, b, c].forEach((x) => x.ws.close());
  });

  it('stores content-addressed blobs and rejects hash mismatch', async () => {
    const body = Buffer.from('%PDF-1.4 fake');
    const sha = createHash('sha256').update(body).digest('hex');
    const base = `http://127.0.0.1:${srv.port}/api/blobs`;
    expect((await fetch(`${base}/${sha}`, { method: 'PUT', body })).status).toBe(201);
    expect(Buffer.from(await (await fetch(`${base}/${sha}`)).arrayBuffer()).equals(body)).toBe(true);
    const bad = createHash('sha256').update('other').digest('hex');
    expect((await fetch(`${base}/${bad}`, { method: 'PUT', body })).status).toBe(400);
  });
});
