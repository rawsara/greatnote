import path from 'node:path';
import { startServer } from './server';

const port = Number(process.env.PORT ?? 8787);
const dataDir = process.env.DATA_DIR ?? path.resolve('data');

const srv = await startServer({ port, dataDir });
console.log(`InkNote sync server  http://0.0.0.0:${srv.port}  (ws: /sync, data: ${dataDir})`);

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, async () => {
    await srv.close();
    process.exit(0);
  });
}
