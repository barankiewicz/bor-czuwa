import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { setTimeout as sleep } from 'node:timers/promises';
import { Client } from 'pg';
import type { Report } from '../src/lib/report.ts';
import { privacyPolicyVersion, termsOfUseVersion } from '../src/lib/legal/versions.ts';
import { postReport } from './helpers/reports.ts';
import { testDatabaseUrl } from './helpers/test-database.ts';
import { loseReports } from './helpers/server-loss.ts';

const base = process.env.TEST_BASE_URL ?? 'http://127.0.0.1:3001';
const points = JSON.parse(await readFile(new URL('../data/fixtures/acceptance.json', import.meta.url), 'utf8'));
const helperClient = new Client({ connectionString: testDatabaseUrl() });
const worker = new Client({ connectionString: testDatabaseUrl() });
// Outside any transaction, so pg_stat_activity is read fresh each time instead of from a cached snapshot.
const probe = new Client({ connectionString: testDatabaseUrl() });
await helperClient.connect();
await worker.connect();
await probe.connect();
after(async () => { await probe.end(); await worker.end(); await helperClient.end(); });

test('loseReports survives a Findings worker that holds the job row and then needs the Report row', async () => {
  const token = randomBytes(32).toString('hex');
  const at = '2026-10-05T10:00:00+02:00';
  const report: Report = {
    id: randomUUID(), event_type: 'person_with_gun', captured_at: at,
    occurred_at: { at, source: 'device_clock', coarseness: 'exact' },
    device_fix: { ...points.edge.point, accuracy_m: 8, at },
    incident_location: { ...points.edge.point, source: 'device_fix' },
    species: null, photo_sha256: [], has_note: false, app_version: '0.1.0',
    privacy_policy_version: privacyPolicyVersion, terms_of_use_version: termsOfUseVersion,
    token_sha256: createHash('sha256').update(token).digest('hex')
  };
  assert.equal((await postReport(base, report)).status, 201);
  for (let attempt = 0; attempt < 120; attempt++) {
    const body = await (await fetch(`${base}/api/reports/${report.id}/findings`, { headers: { authorization: `Bearer ${token}` } })).json() as { status: string };
    if (body.status !== 'pending') break;
    await sleep(250);
  }
  // The integrity loop must be done with this Report too, or it holds a refresh row of its own during the test.
  for (let attempt = 0; attempt < 120; attempt++) {
    const { rows } = await helperClient.query(`SELECT (SELECT count(*) FROM integrity_refresh WHERE report_id = $1)::int AS refresh,
      (SELECT count(*) FROM integrity_signal WHERE report_id = $1)::int AS signal`, [report.id]) as { rows: { refresh: number; signal: number }[] };
    if (rows[0].refresh === 0 && rows[0].signal === 1) break;
    await sleep(250);
  }
  // A job the real worker will not claim for an hour, so only this test holds it.
  await helperClient.query("INSERT INTO findings_job (report_id, available_at) VALUES ($1, now() + interval '1 hour')", [report.id]);

  await worker.query('BEGIN');
  await worker.query('SELECT 1 FROM findings_job WHERE report_id = $1 FOR UPDATE', [report.id]);
  const helper = loseReports(helperClient, [report.id]);
  // Wait until the helper holds the Report row and is queued behind the worker's job row.
  let queued = false;
  for (let attempt = 0; attempt < 100 && !queued; attempt++) {
    const { rows } = await probe.query(`SELECT 1 FROM pg_stat_activity
      WHERE wait_event_type = 'Lock' AND query LIKE 'DELETE FROM findings_job%' AND pid <> pg_backend_pid()`);
    queued = rows.length > 0;
    if (!queued) await sleep(50);
  }
  assert.ok(queued, 'the helper queued behind the worker job row');
  // The worker's findings insert needs KEY SHARE on the Report row the helper has locked: a lock cycle.
  const share = worker.query('SELECT 1 FROM report WHERE id = $1 FOR KEY SHARE', [report.id])
    .then(() => worker.query('COMMIT'), () => worker.query('ROLLBACK'));
  await Promise.all([helper, share]);
  const left = await helperClient.query('SELECT (SELECT count(*) FROM report WHERE id = $1)::int AS reports, (SELECT count(*) FROM findings WHERE report_id = $1)::int AS findings, (SELECT count(*) FROM findings_job WHERE report_id = $1)::int AS jobs', [report.id]);
  assert.deepEqual(left.rows[0], { reports: 0, findings: 0, jobs: 0 });
});
