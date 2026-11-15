import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { pool } from '../server/db.ts';
import { runNextFindingsJob } from '../server/findings.ts';
import { reportAt } from './helpers/reports.ts';

const ids: string[] = [];
const point = JSON.parse(await readFile(new URL('../data/fixtures/acceptance.json', import.meta.url), 'utf8')).edge.point;

after(async () => {
  for (const table of ['integrity_refresh', 'integrity_signal', 'findings_job', 'findings', 'report_event']) {
    await pool.query(`DELETE FROM ${table} WHERE report_id = ANY($1::uuid[])`, [ids]);
  }
  await pool.query('DELETE FROM report WHERE id = ANY($1::uuid[])', [ids]);
  await pool.end();
});

test('a claimed job keeps its Rule set and snapshot and writes one terminal event', async () => {
  const report = reportAt();
  ids.push(report.id);
  const snapshot = (await pool.query('SELECT snapshot_id FROM current_geodata')).rows[0].snapshot_id;
  const rule = 'pl-2018-04-01-v2-protected-v1';
  const at = '2026-09-24T12:00:00Z';
  await pool.query(`INSERT INTO report (id, token_sha256, event_type, captured_at, occurred_at,
    occurred_source, occurred_coarseness, device_lat, device_lon, accuracy_m, device_fix_at,
    incident_lat, incident_lon, incident_source, has_note, app_version,
    privacy_policy_version, terms_of_use_version)
    VALUES ($1,$2,'shot',$3,$3,'device_clock','exact',$4,$5,8,$3,
      $4,$5,'device_fix',false,'0.1.0','fixture','fixture')`,
  [report.id, report.token_sha256, at, point.lat, point.lon]);
  await pool.query(`INSERT INTO findings_job (report_id, rule_set_id, geodata_snapshot_id, available_at)
    VALUES ($1,$2,$3,now() + interval '1 hour')`, [report.id, rule, snapshot]);
  const interrupted = await pool.connect();
  try {
    await interrupted.query('BEGIN');
    await interrupted.query('SELECT 1 FROM findings_job WHERE report_id = $1 FOR UPDATE', [report.id]);
    await interrupted.query('UPDATE findings_job SET attempts = attempts + 1 WHERE report_id = $1', [report.id]);
    await interrupted.query('ROLLBACK');
  } finally { interrupted.release(); }
  assert.equal((await pool.query('SELECT attempts FROM findings_job WHERE report_id = $1', [report.id])).rows[0].attempts, 0);
  await pool.query('UPDATE findings_job SET available_at = now() WHERE report_id = $1', [report.id]);
  for (let attempt = 0; attempt < 100; attempt++) {
    const findings = await pool.query('SELECT rule_set_id, geodata_snapshot_id FROM findings WHERE report_id = $1', [report.id]);
    if (findings.rowCount) {
      assert.deepEqual(findings.rows[0], { rule_set_id: rule, geodata_snapshot_id: snapshot });
      break;
    }
    await runNextFindingsJob();
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  const events = await pool.query(`SELECT kind FROM report_event WHERE report_id = $1
    AND kind IN ('findings_computed', 'findings_failed')`, [report.id]);
  assert.deepEqual(events.rows.map(row => row.kind), ['findings_computed']);
  assert.equal((await pool.query('SELECT 1 FROM findings_job WHERE report_id = $1', [report.id])).rowCount, 0);
});

test('runtime operator requeues a non-retryable failure and Findings compute through HTTP', async () => {
  const { createApiServer } = await import('../server/api.ts');
  const { requeueFindings } = await import('../server/operator.ts');
  const pg = (await import('pg')).default;
  const admin = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL });
  const token = 'a'.repeat(64);
  const report = reportAt();
  report.token_sha256 = createHash('sha256').update(token).digest('hex');
  ids.push(report.id);
  const at = '2026-09-24T12:00:00Z';
  await pool.query(`INSERT INTO report (id, token_sha256, event_type, captured_at, occurred_at,
    occurred_source, occurred_coarseness, incident_lat, incident_lon, incident_source,
    has_note, app_version, privacy_policy_version, terms_of_use_version)
    VALUES ($1,$2,'shot',$3,$3,'device_clock','exact',$4,$5,'moved_by_reporter',false,'0.1.0','fixture','fixture')`,
  [report.id, report.token_sha256, at, point.lat, point.lon]);
  await pool.query(`INSERT INTO findings_job (report_id, available_at)
    VALUES ($1, now() + interval '1 hour')`, [report.id]);
  const server = createApiServer();
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as { port: number };
  const url = `http://127.0.0.1:${address.port}/api`;
  try {
    await admin.query(`CREATE FUNCTION force_findings_failure_04() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.report_id = '${report.id}'::uuid THEN
        RAISE EXCEPTION 'private report and query text' USING ERRCODE = '23514';
      END IF; RETURN NEW; END $$`);
    await admin.query(`CREATE TRIGGER force_findings_failure_04 BEFORE INSERT ON findings
      FOR EACH ROW EXECUTE FUNCTION force_findings_failure_04()`);
    await pool.query('UPDATE findings_job SET available_at = now() WHERE report_id = $1', [report.id]);
    for (let i = 0; i < 100; i++) {
      await runNextFindingsJob();
      if ((await pool.query('SELECT failed_reason FROM findings_job WHERE report_id = $1', [report.id])).rows[0]?.failed_reason) break;
    }
    const failure = (await pool.query("SELECT details FROM report_event WHERE report_id = $1 AND kind = 'findings_failed'", [report.id])).rows[0];
    assert.deepEqual(failure.details, { reason: 'computation_failed', error_class: '23514', step: 'write_findings' });
    const status = await (await fetch(`${url}/worker-status`)).json();
    assert.ok(status.terminal_failures >= 1);
    await pool.query("UPDATE findings_job SET failed_reason = 'unknown_species' WHERE report_id = $1", [report.id]);
    const domainStatus = await (await fetch(`${url}/worker-status`)).json();
    assert.equal(domainStatus.terminal_failures, status.terminal_failures - 1);
    assert.equal(domainStatus.domain_outcomes, status.domain_outcomes + 1);
    await pool.query(`UPDATE findings_job SET failed_reason = 'computation_failed', attempts = 3,
      available_at = now() + interval '1 day' WHERE report_id = $1`, [report.id]);
    assert.equal(typeof status.api_503_by_class, 'object');
    await admin.query('DROP TRIGGER force_findings_failure_04 ON findings');
    await admin.query('DROP FUNCTION force_findings_failure_04()');
    assert.equal(await requeueFindings('computation_failed', '2099-01-01'), 0);
    const inspection = await pool.connect();
    try {
      await inspection.query('BEGIN');
      // Keep the live worker from committing Findings before we inspect the reset job.
      await inspection.query('LOCK TABLE findings IN SHARE MODE');
      const command = await promisify(execFile)(process.execPath, ['--import', 'tsx',
        'server/operator-cli.ts', 'requeue-findings', 'computation_failed', '--since', '2020-01-01']);
      assert.match(command.stdout, /Requeued [1-9][0-9]* Findings jobs/);
      const reset = (await pool.query(`SELECT attempts, failed_reason, rule_set_id, geodata_snapshot_id,
        available_at <= now() AS available_now FROM findings_job WHERE report_id = $1`, [report.id])).rows[0];
      assert.deepEqual(reset, { attempts: 0, failed_reason: null, rule_set_id: null,
        geodata_snapshot_id: null, available_now: true });
    } finally {
      try { await inspection.query('ROLLBACK'); }
      finally { inspection.release(); }
    }
    for (let i = 0; i < 100; i++) {
      await runNextFindingsJob();
      if ((await pool.query('SELECT 1 FROM findings WHERE report_id = $1', [report.id])).rowCount) break;
    }
    const findings = await (await fetch(`${url}/reports/${report.id}/findings`, {
      headers: { authorization: `Bearer ${token}` }
    })).json();
    assert.equal(findings.status, 'computed');
  } finally {
    await admin.query('DROP TRIGGER IF EXISTS force_findings_failure_04 ON findings');
    await admin.query('DROP FUNCTION IF EXISTS force_findings_failure_04()');
    await admin.end();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

test('a geodata switchover held longer than the retry budget delays Findings without failing them', async () => {
  const pg = (await import('pg')).default;
  const ingest = new pg.Client({ connectionString: process.env.TEST_DATABASE_URL });
  const report = reportAt();
  ids.push(report.id);
  const at = '2026-09-24T12:00:00Z';
  await pool.query(`INSERT INTO report (id, token_sha256, event_type, captured_at, occurred_at,
    occurred_source, occurred_coarseness, incident_lat, incident_lon, incident_source,
    has_note, app_version, privacy_policy_version, terms_of_use_version)
    VALUES ($1,$2,'shot',$3,$3,'device_clock','exact',$4,$5,'moved_by_reporter',false,'0.1.0','fixture','fixture')`,
  [report.id, report.token_sha256, at, point.lat, point.lon]);
  await ingest.connect();
  try {
    // Ingest holds this lock while it switches views; the retry budget is about 27 s.
    await ingest.query('BEGIN');
    await ingest.query('SELECT snapshot_id FROM current_geodata FOR UPDATE');
    await pool.query('INSERT INTO findings_job (report_id) VALUES ($1)', [report.id]);
    const until = Date.now() + 32_000;
    while (Date.now() < until) {
      await pool.query('UPDATE findings_job SET available_at = now() WHERE report_id = $1', [report.id]);
      await runNextFindingsJob();
    }
    const held = (await pool.query('SELECT attempts, failed_reason FROM findings_job WHERE report_id = $1', [report.id])).rows[0];
    assert.deepEqual(held, { attempts: 0, failed_reason: null });
  } finally {
    await ingest.query('ROLLBACK').catch(() => {});
    await ingest.end();
  }
  for (let i = 0; i < 100; i++) {
    await pool.query('UPDATE findings_job SET available_at = now() WHERE report_id = $1', [report.id]);
    await runNextFindingsJob();
    if ((await pool.query('SELECT 1 FROM findings WHERE report_id = $1', [report.id])).rowCount) break;
  }
  const events = await pool.query(`SELECT kind FROM report_event WHERE report_id = $1
    AND kind IN ('findings_computed', 'findings_failed')`, [report.id]);
  assert.deepEqual(events.rows.map(row => row.kind), ['findings_computed']);
});
