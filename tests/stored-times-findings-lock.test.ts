import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { Client } from 'pg';
import type { Report } from '../src/lib/report.ts';
import { privacyPolicyVersion, termsOfUseVersion } from '../src/lib/legal/versions.ts';
import { postReport } from './helpers/reports.ts';
import { testDatabaseUrl } from './helpers/test-database.ts';

const base = process.env.TEST_BASE_URL ?? 'http://127.0.0.1:3001';
const points = JSON.parse(await readFile(new URL('../data/fixtures/acceptance.json', import.meta.url), 'utf8'));
const database = new Client({ connectionString: testDatabaseUrl() });
await database.connect();
const runtimeUrl = new URL(testDatabaseUrl());
runtimeUrl.username = 'app_runtime';
runtimeUrl.password = process.env.RUNTIME_DB_PASSWORD ?? 'runtime-local-only';
const runtime = new Client({ connectionString: runtimeUrl.toString() });
await runtime.connect();
after(async () => { await runtime.end(); await database.end(); });

// Capture and fix times must sit inside the accepted window; only the occurrence may predate it.
function reportPayload(occurred = '2026-09-24T10:00:00+02:00') {
  const token = randomBytes(32).toString('hex');
  const at = '2026-09-24T10:00:00+02:00';
  const report: Report = {
    id: randomUUID(), event_type: 'person_with_gun', captured_at: at,
    occurred_at: { at: occurred, source: 'device_clock', coarseness: 'exact' },
    device_fix: { ...points.edge.point, accuracy_m: 8, at },
    incident_location: { ...points.edge.point, source: 'device_fix' },
    species: null, photo_sha256: [], has_note: false, app_version: '0.1.0',
    privacy_policy_version: privacyPolicyVersion, terms_of_use_version: termsOfUseVersion,
    token_sha256: createHash('sha256').update(token).digest('hex')
  };
  return { report, token };
}

async function settledReport(status: 'computed' | 'failed', occurred?: string) {
  const { report, token } = reportPayload(occurred);
  assert.equal((await postReport(base, report)).status, 201);
  for (let attempt = 0; attempt < 100; attempt++) {
    const findings = await fetch(`${base}/api/reports/${report.id}/findings`, { headers: { authorization: `Bearer ${token}` } });
    if ((await findings.json()).status === status) return { id: report.id, token };
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`Findings did not reach ${status}`);
}
const computedReport = () => settledReport('computed');
// Before the earliest Rule set, so the real worker ends the job in a terminal failure.
const failedReport = () => settledReport('failed', '2018-03-31T12:00:00Z');

const withdraw = (id: string, token: string) => fetch(`${base}/api/reports/${id}`, { method: 'DELETE',
  headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` } });
const fine = (value: Date) => value.getTime() % 60_000;
const sqlState = (error: unknown) => (error as { code?: string }).code;

test('every server-written time of a Report and its Withdrawal has zero seconds and milliseconds', async () => {
  const kept = await computedReport();
  const failed = await failedReport();
  const gone = await computedReport();
  assert.equal((await withdraw(gone.id, gone.token)).status, 204);
  const findings = (await database.query('SELECT computed_at FROM findings WHERE report_id = $1', [kept.id])).rows;
  assert.equal(findings.length, 1);
  assert.equal(fine(findings[0].computed_at), 0, `computed_at ${findings[0].computed_at.toISOString()}`);
  for (const [id, kinds] of [[kept.id, ['synced', 'findings_computed']], [failed.id, ['synced', 'findings_failed']]] as const) {
    const events = (await database.query('SELECT kind, at FROM report_event WHERE report_id = $1', [id])).rows;
    for (const kind of kinds) {
      const matching = events.filter(row => row.kind === kind);
      assert.equal(matching.length, 1, `one ${kind} event`);
      assert.equal(fine(matching[0].at), 0, `${kind} at ${matching[0].at.toISOString()}`);
    }
  }
  const tombstone = (await database.query('SELECT withdrawn_at FROM report_withdrawal WHERE id = $1', [gone.id])).rows;
  assert.equal(tombstone.length, 1);
  assert.equal(fine(tombstone[0].withdrawn_at), 0, `withdrawn_at ${tombstone[0].withdrawn_at.toISOString()}`);
});

test('the runtime role cannot update or delete Findings or store a second row for a Report', async () => {
  const { id } = await computedReport();
  for (const statement of ['UPDATE findings SET accuracy_m = 1 WHERE report_id = $1', 'DELETE FROM findings WHERE report_id = $1']) {
    await runtime.query('BEGIN');
    try {
      await assert.rejects(runtime.query(statement, [id]), error => sqlState(error) === '42501');
    } finally { await runtime.query('ROLLBACK'); }
  }
  await runtime.query('BEGIN');
  try {
    await assert.rejects(runtime.query(`INSERT INTO findings (report_id, rule_set_id, geodata_snapshot_id, dwelling_distance, obwod_lowiecki)
      SELECT report_id, rule_set_id, geodata_snapshot_id, dwelling_distance, obwod_lowiecki FROM findings WHERE report_id = $1`, [id]),
    error => sqlState(error) === '23505');
  } finally { await runtime.query('ROLLBACK'); }
  assert.equal((await database.query('SELECT count(*)::int AS n FROM findings WHERE report_id = $1', [id])).rows[0].n, 1);
});

test('Withdrawal still removes the Findings row with the revoked grants', async () => {
  const { id, token } = await computedReport();
  assert.equal((await withdraw(id, token)).status, 204);
  assert.equal((await database.query('SELECT count(*)::int AS n FROM findings WHERE report_id = $1', [id])).rows[0].n, 0);
});

test('the operator requeue command still re-queues a failed job as the runtime role', async () => {
  const { report } = reportPayload();
  await database.query(`INSERT INTO report (id, token_sha256, event_type, captured_at, occurred_at, occurred_source,
    occurred_coarseness, incident_lat, incident_lon, incident_source, has_note, app_version, privacy_policy_version, terms_of_use_version)
    VALUES ($1, $2, 'shot', now(), now(), 'device_clock', 'exact', 52, 21, 'moved_by_reporter', false, 'test', 'v1', 'v1')`,
  [report.id, randomBytes(32).toString('hex')]);
  const hold = new Client({ connectionString: testDatabaseUrl() });
  await hold.connect();
  try {
    await database.query("INSERT INTO findings_job (report_id, failed_reason, attempts, available_at) VALUES ($1, 'point_outside_fixture', 3, now() + interval '1 day')", [report.id]);
    await database.query("INSERT INTO report_event (report_id, kind, details) VALUES ($1, 'findings_failed', '{\"reason\":\"point_outside_fixture\"}')", [report.id]);
    // Share-lock Findings (as the owner: the runtime role cannot lock it) so the stack's worker cannot
    // finish the re-queued job before its reset state is read.
    await hold.query('BEGIN');
    await hold.query('LOCK TABLE findings IN SHARE MODE');
    const command = await promisify(execFile)(process.execPath, ['--import', 'tsx', 'server/operator-cli.ts',
      'requeue-findings', 'point_outside_fixture', '--since', '2020-01-01'],
    { env: { ...process.env, DATABASE_URL: runtimeUrl.toString() } });
    assert.match(command.stdout, /Requeued [1-9]\d* Findings jobs/);
    const reset = (await database.query(`SELECT attempts, failed_reason, available_at <= now() AS available_now
      FROM findings_job WHERE report_id = $1`, [report.id])).rows[0];
    assert.deepEqual(reset, { attempts: 0, failed_reason: null, available_now: true });
  } finally {
    await hold.query('ROLLBACK');
    await hold.end();
    // Let the worker finish with the job (it deletes it or marks it failed again) before removing the rows.
    for (let attempt = 0; attempt < 100; attempt++) {
      const job = (await database.query('SELECT failed_reason FROM findings_job WHERE report_id = $1', [report.id])).rows[0];
      if (!job || job.failed_reason) break;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    for (const table of ['findings_job', 'findings', 'integrity_signal', 'integrity_refresh', 'report_event']) {
      await database.query(`DELETE FROM ${table} WHERE report_id = $1`, [report.id]);
    }
    await database.query('DELETE FROM report WHERE id = $1', [report.id]);
  }
});
