import { once } from 'node:events';
import { createApiServer } from '../../server/api.ts';
import { pool } from '../../server/db.ts';

let now = Number(process.env.TEST_CLOCK_NOW);
const server = createApiServer(() => now);
await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
process.send!(`http://127.0.0.1:${(server.address() as { port: number }).port}`);
process.on('message', (value: number) => {
  now = value;
  process.send!(now);
});
let stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true;
  const closed = once(server, 'close');
  server.close();
  server.closeAllConnections();
  await closed;
  await pool.end();
  if (process.connected) process.disconnect();
}
process.on('SIGTERM', () => void stop());
process.on('disconnect', () => void stop());
