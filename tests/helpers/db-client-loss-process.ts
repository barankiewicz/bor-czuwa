import { createApiServer } from '../../server/api.ts';
import { pool } from '../../server/db.ts';
import { workerStatus } from '../../server/worker-status.ts';

// The real db.ts and API in their own process: an unhandled 'error' on a checked-out client ends it.
const server = createApiServer();
await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
const ready = async () => fetch(`${base}/api/ready`).then(response => response.status, () => 0);

process.send!({ step: 'ready-before', status: await ready() });
const client = await pool.connect();
process.send!({ step: 'held' });
let rejected = '';
try {
  await client.query('SELECT pg_sleep(60)');
} catch (error) {
  rejected = error instanceof Error ? error.message : String(error);
}
client.release(true);
process.send!({ step: 'rejected', message: rejected });
const statuses = new Set<number>();
let acknowledged = false;
for (let attempt = 0; attempt < 100; attempt++) {
  const status = await ready();
  statuses.add(status);
  // Tell the test the outage was seen, so it reopens the database only after readiness reported it.
  if (status !== 200 && !acknowledged) { acknowledged = true; process.send!({ step: 'outage', status }); }
  // Stop at the first 200 after a non-200: the outage was seen and readiness is back.
  if (status === 200 && statuses.size > 1) break;
  await new Promise(resolve => setTimeout(resolve, 100));
}
process.send!({ step: 'done', statuses: [...statuses], recoveryCount: workerStatus.databaseRecoveryCount });
server.close();
await pool.end();
process.exit(0);
