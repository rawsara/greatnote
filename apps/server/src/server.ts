import { createHash } from 'node:crypto';
import { mkdir, readdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { createReadStream, existsSync } from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { WebSocketServer, type WebSocket } from 'ws';
import {
  cmpStamp, type ClientMsg, type DocMeta, type EntityKind, type Op, type RemoteDocInfo, type ServerMsg,
} from '@inknote/core';

interface ServerEntry {
  k: EntityKind;
  s: Op['s'];
  v: unknown;
  /** 이 엔트리가 마지막으로 바뀐 서버 시퀀스 */
  q: number;
}

/**
 * 문서 하나의 서버 상태: LWW 엔트리 + 단조 증가 seq.
 * op 로그를 쌓지 않고 "현재 상태"만 보관 → 저장 공간이 문서 크기에 비례.
 */
class DocState {
  entries = new Map<string, ServerEntry>();
  seq = 0;
  updatedAt = Date.now();
  private saveTimer: NodeJS.Timeout | null = null;

  constructor(
    readonly id: string,
    private readonly file: string,
  ) {}

  static async load(id: string, file: string): Promise<DocState> {
    const d = new DocState(id, file);
    if (existsSync(file)) {
      const raw = JSON.parse(await readFile(file, 'utf8')) as { seq: number; updatedAt: number; entries: [string, ServerEntry][] };
      d.seq = raw.seq;
      d.updatedAt = raw.updatedAt;
      d.entries = new Map(raw.entries);
    }
    return d;
  }

  /** 이긴(=상태를 바꾼) op 만 반환 */
  merge(ops: Op[]): Op[] {
    const won: Op[] = [];
    for (const op of ops) {
      const cur = this.entries.get(op.id);
      if (cur && cmpStamp(cur.s, op.s) >= 0) continue;
      this.entries.set(op.id, { k: op.k, s: op.s, v: op.v, q: ++this.seq });
      won.push(op);
    }
    if (won.length) {
      this.updatedAt = Date.now();
      this.scheduleSave();
    }
    return won;
  }

  since(seq: number): Op[] {
    const out: Op[] = [];
    for (const [id, e] of this.entries) if (e.q > seq) out.push({ k: e.k, id, s: e.s, v: e.v });
    return out;
  }

  get title(): string {
    return (this.entries.get('meta')?.v as DocMeta | null)?.title ?? '제목 없음';
  }

  private scheduleSave(): void {
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => void this.flush(), 400);
  }

  async flush(): Promise<void> {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = null;
    const tmp = `${this.file}.tmp`;
    await writeFile(tmp, JSON.stringify({ seq: this.seq, updatedAt: this.updatedAt, entries: [...this.entries] }));
    await rename(tmp, this.file); // 원자적 교체
  }
}

const ENTITY_KINDS = new Set<EntityKind>(['meta', 'page', 'obj', 'asset', 'hwr']);
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const SHA_RE = /^[a-f0-9]{64}$/;

function validOp(op: unknown): op is Op {
  const o = op as Op;
  return (
    !!o && ENTITY_KINDS.has(o.k) && typeof o.id === 'string' && ID_RE.test(o.id) &&
    !!o.s && Number.isFinite(o.s.c) && typeof o.s.n === 'string' && o.s.n.length <= 64
  );
}

export interface ServerOptions {
  port: number;
  dataDir: string;
  maxBlobBytes?: number;
}

export async function startServer(opts: ServerOptions) {
  const docsDir = path.join(opts.dataDir, 'docs');
  const blobsDir = path.join(opts.dataDir, 'blobs');
  await mkdir(docsDir, { recursive: true });
  await mkdir(blobsDir, { recursive: true });
  const maxBlob = opts.maxBlobBytes ?? 300 * 1024 * 1024;

  const docs = new Map<string, Promise<DocState>>();
  const getDoc = (id: string) => {
    let p = docs.get(id);
    if (!p) docs.set(id, (p = DocState.load(id, path.join(docsDir, `${id}.json`))));
    return p;
  };
  for (const f of await readdir(docsDir)) if (f.endsWith('.json')) void getDoc(f.slice(0, -5));

  const subscribers = new Map<string, Set<WebSocket>>();

  const cors = (res: http.ServerResponse) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET,PUT,HEAD,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  };

  const server = http.createServer(async (req, res) => {
    cors(res);
    try {
      const url = new URL(req.url ?? '/', 'http://x');
      if (req.method === 'OPTIONS') return void res.writeHead(204).end();

      if (url.pathname === '/api/health') return void res.end('ok');

      if (url.pathname === '/api/docs' && req.method === 'GET') {
        const list: RemoteDocInfo[] = [];
        for (const p of docs.values()) {
          const d = await p;
          if (d.entries.size) list.push({ id: d.id, title: d.title, seq: d.seq, updatedAt: d.updatedAt });
        }
        res.setHeader('Content-Type', 'application/json');
        return void res.end(JSON.stringify(list));
      }

      const m = url.pathname.match(/^\/api\/blobs\/([a-f0-9]+)$/);
      if (m && SHA_RE.test(m[1])) {
        const file = path.join(blobsDir, m[1]);
        if (req.method === 'GET' || req.method === 'HEAD') {
          if (!existsSync(file)) return void res.writeHead(404).end();
          const st = await stat(file);
          res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': st.size, 'Cache-Control': 'public, max-age=31536000, immutable' });
          if (req.method === 'HEAD') return void res.end();
          return void createReadStream(file).pipe(res);
        }
        if (req.method === 'PUT') {
          if (existsSync(file)) return void res.writeHead(200).end(); // content-addressed: 이미 있음
          const chunks: Buffer[] = [];
          let size = 0;
          for await (const c of req) {
            size += (c as Buffer).length;
            if (size > maxBlob) return void res.writeHead(413).end();
            chunks.push(c as Buffer);
          }
          const buf = Buffer.concat(chunks);
          if (createHash('sha256').update(buf).digest('hex') !== m[1]) return void res.writeHead(400).end('hash mismatch');
          await writeFile(`${file}.tmp`, buf);
          await rename(`${file}.tmp`, file);
          return void res.writeHead(201).end();
        }
      }
      res.writeHead(404).end();
    } catch (e) {
      console.error(e);
      if (!res.headersSent) res.writeHead(500);
      res.end();
    }
  });

  const wss = new WebSocketServer({ server, path: '/sync', maxPayload: 32 * 1024 * 1024 });
  wss.on('connection', (ws) => {
    const subs = new Set<string>();
    const send = (m: ServerMsg) => ws.readyState === ws.OPEN && ws.send(JSON.stringify(m));

    ws.on('message', async (data) => {
      let msg: ClientMsg;
      try {
        msg = JSON.parse(String(data));
      } catch {
        return send({ type: 'error', message: 'bad json' });
      }
      if (!msg || typeof msg.docId !== 'string' || !ID_RE.test(msg.docId)) return send({ type: 'error', message: 'bad doc id' });
      const doc = await getDoc(msg.docId);

      if (msg.type === 'hello') {
        subs.add(msg.docId);
        let set = subscribers.get(msg.docId);
        if (!set) subscribers.set(msg.docId, (set = new Set()));
        set.add(ws);
        send({ type: 'ops', docId: msg.docId, ops: doc.since(Number(msg.since) || 0), seq: doc.seq });
      } else if (msg.type === 'push') {
        if (!Array.isArray(msg.ops) || !msg.ops.every(validOp)) return send({ type: 'error', message: 'bad ops' });
        const won = doc.merge(msg.ops);
        send({ type: 'ack', docId: msg.docId, batch: msg.batch, seq: doc.seq });
        if (won.length) {
          const payload = JSON.stringify({ type: 'ops', docId: msg.docId, ops: won, seq: doc.seq } satisfies ServerMsg);
          for (const peer of subscribers.get(msg.docId) ?? []) if (peer !== ws && peer.readyState === peer.OPEN) peer.send(payload);
        }
      }
    });

    ws.on('close', () => {
      for (const id of subs) subscribers.get(id)?.delete(ws);
    });
  });

  await new Promise<void>((r) => server.listen(opts.port, r));
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : opts.port;

  return {
    port,
    async close() {
      for (const c of wss.clients) c.terminate();
      wss.close();
      await new Promise((r) => server.close(r));
      for (const p of docs.values()) await (await p).flush();
    },
  };
}
