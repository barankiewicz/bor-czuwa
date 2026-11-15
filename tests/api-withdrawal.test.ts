import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { Client } from 'pg';
import type { Report } from '../src/lib/report.ts';
import { privacyPolicyVersion, termsOfUseVersion } from '../src/lib/legal/versions.ts';
import { postReport } from './helpers/reports.ts';
import { testDatabaseUrl } from './helpers/test-database.ts';
import { createApiServer } from '../server/api.ts';
import { reportCounts } from '../server/operator.ts';

const base = process.env.TEST_BASE_URL ?? 'http://127.0.0.1:3001';
const points = JSON.parse(await readFile(new URL('../data/fixtures/acceptance.json', import.meta.url), 'utf8'));
const database = new Client({ connectionString: testDatabaseUrl() });
await database.connect();
after(() => database.end());

function reportPayload() {
  const token = randomBytes(32).toString('hex');
  const at = '2026-09-24T10:00:00+02:00';
  const report: Report = {
    id: randomUUID(), event_type: 'person_with_gun', captured_at: at,
    occurred_at: { at, source: 'device_clock', coarseness: 'exact' },
    device_fix: { ...points.edge.point, accuracy_m: 8, at },
    incident_location: { ...points.edge.point, source: 'device_fix' },
    species: null, photo_sha256: [], has_note: false, app_version: '0.1.0',
    privacy_policy_version: privacyPolicyVersion, terms_of_use_version: termsOfUseVersion,
    token_sha256: createHash('sha256').update(token).digest('hex')
  };
  return { report, token };
}

async function syncedReport() {
  const { report, token } = reportPayload();
  assert.equal((await postReport(base, report)).status, 201);
  for (let attempt = 0; attempt < 100; attempt++) {
    const findings = await fetch(`${base}/api/reports/${report.id}/findings`, { headers: { authorization: `Bearer ${token}` } });
    if ((await findings.json()).status === 'computed') {
      await integrityRefreshDone(report.id);
      return { id: report.id, token };
    }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('Findings were not computed');
}

// Findings can be computed while the new Report's own integrity_refresh row is still queued.
async function integrityRefreshDone(id: string) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (!(await database.query('SELECT 1 FROM integrity_refresh WHERE report_id = $1', [id])).rowCount) return;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('Integrity refresh did not finish');
}

function withdraw(id: string, token?: string) {
  return fetch(`${base}/api/reports/${id}`, { method: 'DELETE',
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) } });
}

async function rowCounts(id: string) {
  const counts: Record<string, number> = {};
  for (const [table, column] of [['report', 'id'], ['report_event', 'report_id'], ['findings', 'report_id'],
    ['findings_job', 'report_id'], ['integrity_signal', 'report_id']]) {
    counts[table] = (await database.query(`SELECT count(*)::int AS n FROM ${table} WHERE ${column} = $1`, [id])).rows[0].n;
  }
  return counts;
}

async function duplicatePoints(id: string) {
  for (let attempt = 0; attempt < 100; attempt++) {
    const pending = await database.query('SELECT 1 FROM integrity_refresh WHERE report_id = $1', [id]);
    const signal = await database.query('SELECT duplicate_point_count FROM integrity_signal WHERE report_id = $1', [id]);
    if (!pending.rowCount && signal.rowCount) return signal.rows[0].duplicate_point_count as number;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('Integrity refresh did not finish');
}

test('a wrong, missing or foreign token withdraws nothing', async () => {
  const { id, token } = await syncedReport();
  const other = await syncedReport();
  const before = await rowCounts(id);
  // The job row goes once Findings are computed; every other table holds this Report.
  assert.deepEqual(Object.entries(before).filter(([, count]) => !count).map(([table]) => table), ['findings_job']);
  // A malformed or missing token is refused. A well-formed token that does not own the Report
  // answers 204 exactly as an unknown id does (ticket 48), and deletes nothing.
  for (const candidate of [undefined, 'not-a-token']) assert.equal((await withdraw(id, candidate)).status, 404);
  for (const candidate of [randomBytes(32).toString('hex'), other.token]) {
    assert.equal((await withdraw(id, candidate)).status, 204);
  }
  assert.equal((await withdraw(randomUUID(), 'not-a-token')).status, 404);
  assert.deepEqual(await rowCounts(id), before);
  assert.equal((await withdraw(other.id, other.token)).status, 204);
  assert.equal((await withdraw(id, token)).status, 204);
});

test('the right token leaves no row in any Report table and refreshes neighbours\' signals', async () => {
  const neighbour = await syncedReport();
  const { id, token } = await syncedReport();
  await duplicatePoints(id); // its own refresh has run, and queued the neighbour in the same transaction
  const before = await duplicatePoints(neighbour.id);
  assert.equal((await withdraw(id, token)).status, 204);
  assert.deepEqual(await rowCounts(id), { report: 0, report_event: 0, findings: 0, findings_job: 0, integrity_signal: 0 });
  assert.equal(await duplicatePoints(neighbour.id), before - 1);
  assert.equal((await withdraw(id, token)).status, 204);
  const findings = await fetch(`${base}/api/reports/${id}/findings`, { headers: { authorization: `Bearer ${token}` } });
  assert.equal(findings.status, 404);
  assert.equal((await withdraw(neighbour.id, neighbour.token)).status, 204);
});

test('excluded Withdrawal keeps the excluded tally once and erases Report data', async () => {
  const { id, token } = await syncedReport();
  await database.query("INSERT INTO report_event (report_id, kind, details) VALUES ($1, 'excluded', '{\"reason\":\"fabricated\"}')", [id]);
  const before = await reportCounts();
  assert.equal((await withdraw(id, randomBytes(32).toString('hex'))).status, 204);
  assert.deepEqual(await reportCounts(), before);
  const deleted = await Promise.all([withdraw(id, token), withdraw(id, token)]);
  assert.deepEqual(deleted.map(response => response.status), [204, 204]);
  assert.equal((await withdraw(id, token)).status, 204);
  assert.deepEqual(await reportCounts(), before);
  assert.deepEqual(await rowCounts(id), { report: 0, report_event: 0, findings: 0, findings_job: 0, integrity_signal: 0 });
  assert.equal((await database.query('SELECT 1 FROM integrity_refresh WHERE report_id = $1', [id])).rowCount, 0);
});

test('included and lifted Exclusion Withdrawals shrink only the included tally', async () => {
  for (const lifted of [false, true]) {
    const { id, token } = await syncedReport();
    if (lifted) {
      await database.query("INSERT INTO report_event (report_id, kind, details) VALUES ($1, 'excluded', '{\"reason\":\"test\"}'), ($1, 'exclusion_lifted', '{}')", [id]);
    }
    const before = await reportCounts();
    assert.equal((await withdraw(id, token)).status, 204);
    assert.deepEqual(await reportCounts(), { included: before.included - 1, excluded: before.excluded });
  }
});

test('Withdrawal waits for a concurrent Exclusion and keeps its committed tally', async () => {
  const { id, token } = await syncedReport();
  const before = await reportCounts();
  await database.query('BEGIN');
  let deleted: Promise<Response> | undefined;
  try {
    await database.query('SELECT id FROM report WHERE id = $1 FOR UPDATE', [id]);
    await database.query("INSERT INTO report_event (report_id, kind, details) VALUES ($1, 'excluded', '{\"reason\":\"duplicate\"}')", [id]);
    deleted = withdraw(id, token);
    await new Promise(resolve => setTimeout(resolve, 100));
    await database.query('COMMIT');
    assert.equal((await deleted).status, 204);
    assert.deepEqual(await reportCounts(), { included: before.included - 1, excluded: before.excluded + 1 });
    assert.deepEqual(await rowCounts(id), { report: 0, report_event: 0, findings: 0, findings_job: 0, integrity_signal: 0 });
  } finally {
    await database.query('ROLLBACK');
    if (deleted) await deleted;
  }
});

test('concurrent nearby creations and withdrawals converge to the prior signal count', async () => {
  const anchor = await syncedReport();
  const before = await duplicatePoints(anchor.id);
  const first = reportPayload();
  const second = reportPayload();
  const posted = await Promise.all([postReport(base, first.report), postReport(base, second.report)]);
  assert.deepEqual(posted.map(response => response.status), [201, 201]);
  const waitForCount = async (expected: number) => {
    for (let attempt = 0; attempt < 100; attempt++) {
      if (await duplicatePoints(anchor.id) === expected) return;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert.equal(await duplicatePoints(anchor.id), expected);
  };
  await waitForCount(before + 2);
  assert.deepEqual((await Promise.all([
    withdraw(first.report.id, first.token), withdraw(second.report.id, second.token)
  ])).map(response => response.status), [204, 204]);
  await waitForCount(before);
  assert.equal((await withdraw(anchor.id, anchor.token)).status, 204);
});

test('withdrawal before upload prevents creation and survives a repeated DELETE', async () => {
  const { report, token } = reportPayload();
  assert.equal((await withdraw(report.id, token)).status, 204);
  assert.equal((await postReport(base, report)).status, 410);
  assert.equal((await withdraw(report.id, token)).status, 204);
  assert.equal((await withdraw(report.id, randomBytes(32).toString('hex'))).status, 204);
  assert.deepEqual(await rowCounts(report.id), {
    report: 0, report_event: 0, findings: 0, findings_job: 0, integrity_signal: 0
  });
});

test('simultaneous upload and withdrawal end with no Report', async () => {
  const { report, token } = reportPayload();
  const [posted, deleted] = await Promise.all([postReport(base, report), withdraw(report.id, token)]);
  assert.ok([201, 410].includes(posted.status));
  assert.equal(deleted.status, 204);
  assert.equal((await postReport(base, report)).status, 410);
  assert.deepEqual(await rowCounts(report.id), {
    report: 0, report_event: 0, findings: 0, findings_job: 0, integrity_signal: 0
  });
});

test('unknown Report withdrawals are bounded per address without blocking idempotent retry', async () => {
  const server = createApiServer();
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const token = randomBytes(32).toString('hex');
  const ids = Array.from({ length: 51 }, () => randomUUID());
  const request = (id: string) => fetch(`${url}/api/reports/${id}`, {
    method: 'DELETE', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }
  });
  try {
    for (const id of ids.slice(0, 50)) assert.equal((await request(id)).status, 204);
    const limited = await request(ids[50]);
    assert.equal(limited.status, 429);
    assert.ok(Number(limited.headers.get('retry-after')) > 0);
    assert.equal((await request(ids[0])).status, 204);
    assert.equal((await database.query('SELECT 1 FROM report_withdrawal WHERE id = $1', [ids[50]])).rowCount, 0);
  } finally {
    await database.query('DELETE FROM report_withdrawal WHERE id = ANY($1::uuid[])', [ids]);
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

// SYNCED_REPORT_CALLS raises the count for a repeat run (the daily Report limit is 50 per address).
test('syncedReport returns only after the new Report\'s own integrity refresh has run', async () => {
  // Earlier tests in a full run spend the shared 50-Report daily budget; this disposable database is ours to reset.
  await database.query('DELETE FROM rate_counter');
  for (let call = 0; call < Number(process.env.SYNCED_REPORT_CALLS ?? 5); call++) {
    const { id, token } = await syncedReport();
    assert.equal((await database.query('SELECT 1 FROM integrity_refresh WHERE report_id = $1', [id])).rowCount, 0, `call ${call}`);
    assert.equal((await withdraw(id, token)).status, 204);
  }
});
