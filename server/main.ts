import { setTimeout } from 'node:timers/promises';
import { createApiServer } from './api.ts';
import { noteDatabaseFailure, pool } from './db.ts';
import { assertStartupCompatible, refusalLine, refusalToken, startupRefusals } from './startup-check.ts';
import { runNextFindingsJob } from './findings.ts';
import { backfillNextIntegritySignal } from './integrity.ts';
import { workerStatus } from './worker-status.ts';

try {
  await assertStartupCompatible(pool);
} catch (error) {
  // Only the fixed token and its sentence are printed, never the exception. The token also
  // leaves as the exit status, which the unit's ExecStopPost records for the monitor.
  const token = refusalToken(error);
  console.error(refusalLine(token));
  process.exit(startupRefusals[token].exit);
}
const server = createApiServer();
await new Promise<void>(resolve => server.listen(Number(process.env.PORT ?? 3001), process.env.HOST ?? '127.0.0.1', resolve));
let stopping = false;
let closeServer: Promise<void> | undefined;
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    stopping = true;
    closeServer ??= new Promise(resolve => server.close(() => resolve()));
  });
}
async function work(run: () => Promise<boolean>, poll: () => void) {
  while (!stopping) {
    let worked = false;
    try {
      worked = await run();
      poll();
    } catch (error) {
      noteDatabaseFailure(error);
      workerStatus.recoveryCount++;
      console.error('Report worker unavailable; retrying.');
    }
    // A backlog drains back to back; only an empty pass waits before polling again.
    if (!stopping && !worked) await setTimeout(1000);
  }
}
await Promise.all([
  work(runNextFindingsJob, () => { workerStatus.lastPollAt = Date.now(); }),
  work(() => backfillNextIntegritySignal(pool), () => { workerStatus.lastIntegrityPollAt = Date.now(); })
]);
await closeServer;
await pool.end();
