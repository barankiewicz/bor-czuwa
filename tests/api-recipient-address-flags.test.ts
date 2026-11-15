import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createApiServer } from '../server/api.ts';
import { pool } from '../server/db.ts';
import { postReport, reportAt } from './helpers/reports.ts';

const unit = { kind: 'police', unit_id: 'c753fb0c-78e2-419d-ad48-d7bf3b5218ac' };

test('address flags store only known unit and server date, with existing daily IP limit', async () => {
  const now = Date.parse('2030-01-15T12:00:00Z');
  const server = createApiServer(() => now);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const url = `http://127.0.0.1:${address.port}/api/recipient-address-flags`;
  const report = reportAt();
  const post = (payload: unknown) => fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) });
  try {
    for (const invalid of [
      { ...unit, report_id: crypto.randomUUID() },
      { ...unit, sender: 'someone@example.org' },
      { kind: 'police', unit_id: 'unknown' },
      { kind: 'unknown', unit_id: unit.unit_id }
    ]) assert.equal((await post(invalid)).status, 400);
    assert.equal((await post(unit)).status, 201);
    const saved = await pool.query('SELECT kind, unit_id, flagged_on::text FROM recipient_address_flag WHERE flagged_on = $1', ['2030-01-15']);
    assert.deepEqual(saved.rows, [{ ...unit, flagged_on: '2030-01-15' }]);
    for (let count = 1; count < 50; count++) assert.equal((await post(unit)).status, 201);
    assert.equal((await post(unit)).status, 429);
    const total = await pool.query('SELECT count(*)::integer AS count FROM recipient_address_flag WHERE flagged_on = $1', ['2030-01-15']);
    assert.equal(total.rows[0].count, 50);
    assert.equal((await postReport(`http://127.0.0.1:${address.port}`, report)).status, 201);
    const signals = await pool.query('SELECT 1 FROM integrity_signal WHERE report_id = $1', [report.id]);
    assert.equal(signals.rowCount, 0);
  } finally {
    server.close();
    await once(server, 'close');
    await pool.query('DELETE FROM recipient_address_flag WHERE flagged_on = $1', ['2030-01-15']).catch(() => {});
    for (const table of ['findings_job', 'findings', 'report_event', 'integrity_signal']) {
      await pool.query(`DELETE FROM ${table} WHERE report_id = $1`, [report.id]);
    }
    await pool.query('DELETE FROM report WHERE id = $1', [report.id]);
  }
});
