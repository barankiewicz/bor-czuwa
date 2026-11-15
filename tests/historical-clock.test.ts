import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { startClockedApi } from './helpers/clocked-api.ts';
import { createConnection } from 'node:net';
import { once } from 'node:events';
import { setTimeout } from 'node:timers/promises';
import { createApiServer } from '../server/api.ts';
import { pool } from '../server/db.ts';
import { postReport, reportAt } from './helpers/reports.ts';

after(() => pool.end());

test('historical Report limit survives live API cleanup', async () => {
  const now = Date.parse('2026-09-25T21:59:00Z');
  const historical = await startClockedApi(now);
  const { base, database } = historical;
  const sentinel = randomUUID();
  const live = createApiServer();
  try {
    for (let index = 0; index < 50; index++) assert.equal((await postReport(base, reportAt())).status, 201);
    assert.equal((await postReport(base, reportAt())).status, 429);
    await pool.query(`INSERT INTO rate_counter (ip_hash, daily_count, hourly_count, hour_start, expires_at)
      VALUES ($1, 1, 1, $2, $2)`, [sentinel, new Date(now)]);
    await new Promise<void>(resolve => live.listen(0, '127.0.0.1', resolve));
    for (let index = 0; index < 100; index++) {
      if (!(await pool.query('SELECT 1 FROM rate_counter WHERE ip_hash = $1', [sentinel])).rowCount) break;
      await setTimeout(10);
    }
    assert.equal((await pool.query('SELECT 1 FROM rate_counter WHERE ip_hash = $1', [sentinel])).rowCount, 0);
    // One row for the client's address, one for the service-wide hourly ceiling.
    assert.deepEqual((await database.query('SELECT daily_count FROM rate_counter')).rows, [{ daily_count: 50 }, { daily_count: 50 }]);
    const refused = await postReport(base, reportAt());
    assert.equal(refused.status, 429);
    assert.equal(refused.headers.get('retry-after'), '60');
    assert.equal((await database.query('SELECT count(*)::int AS count FROM findings_job')).rows[0].count, 50);
    await historical.setTime(now + 60_001);
    assert.equal((await postReport(base, reportAt())).status, 201);
  } finally {
    try { await new Promise<void>(resolve => live.close(() => resolve())); }
    finally { await historical.close(); }
  }
});

test('clocked API closes its owned unfinished connection without killing its process', async () => {
  const historical = await startClockedApi(Date.parse('2026-09-25T21:59:00Z'));
  const socket = createConnection({ host: '127.0.0.1', port: Number(new URL(historical.base).port) });
  try {
    await once(socket, 'connect');
    const signal = AbortSignal.timeout(15_000);
    socket.write('POST /api/reports HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Type: application/json\r\nContent-Length: 2\r\nExpect: 100-continue\r\n\r\n');
    let response = '';
    while (!response.includes('\r\n\r\n')) {
      const chunk = socket.read();
      if (chunk === null) await once(socket, 'readable', { signal });
      else response += chunk.toString();
    }
    assert.match(response, /^HTTP\/1\.1 100 Continue\r\n/);
    assert.equal((await historical.database.query('SELECT count(*)::int AS count FROM report')).rows[0].count, 0);
    assert.equal(socket.destroyed, false);
  } finally {
    const closed = socket.destroyed ? undefined : once(socket, 'close');
    try {
      await historical.close();
      if (closed) await closed;
      assert.equal(socket.destroyed, true);
    }
    finally { socket.destroy(); }
  }
});
