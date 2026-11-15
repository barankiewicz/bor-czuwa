import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { pool } from '../server/db.ts';
import { backfillNextIntegritySignal, computeIntegritySignals, queueIntegrityRefresh } from '../server/integrity.ts';
import { exclude, liftExclusion, unpublish, digestForDay, clusterReportIds } from '../server/operator.ts';
import { reportAt } from './helpers/reports.ts';

const ids: string[] = [];

async function waitForIntegrity(reportIds: string[], expected: 'complete' | 'failed' = 'complete') {
  const deadline = performance.now() + 2_000;
  let state;
  do {
    state = (await pool.query(`SELECT owned.report_id, pending.report_id IS NOT NULL AS queued,
      pending.lease_until, pending.attempts, pending.generation, pending.available_at,
      pending.failed_reason, pending.error_class, pending.failure_step,
      signal.report_id IS NOT NULL AS has_signal
      FROM unnest($1::uuid[]) AS owned(report_id)
      LEFT JOIN integrity_refresh pending USING (report_id)
      LEFT JOIN integrity_signal signal USING (report_id)
      ORDER BY owned.report_id`, [reportIds])).rows;
    if (expected === 'failed') {
      if (state.every(row => row.queued && row.failed_reason !== null)) return;
    } else {
      assert.ok(state.every(row => row.failed_reason === null),
        `Integrity refresh failed: ${JSON.stringify(state)}`);
      if (state.every(row => !row.queued && row.has_signal)) return;
    }
    await backfillNextIntegritySignal(pool);
  } while (performance.now() < deadline);
  assert.fail(`Integrity refresh did not reach ${expected}: ${JSON.stringify(state)}`);
}

after(async () => {
  for (const table of ['integrity_refresh', 'integrity_signal', 'findings_job', 'findings', 'report_event']) {
    await pool.query(`DELETE FROM ${table} WHERE report_id = ANY($1::uuid[])`, [ids]);
  }
  await pool.query('DELETE FROM report WHERE id = ANY($1::uuid[])', [ids]);
  await pool.end();
});

test('point, burst and photo signals stay separate from Findings', async () => {
  const base = reportAt();
  const photoHash = randomBytes(32).toString('hex');
  for (let i = 0; i < 6; i++) {
    const report = reportAt();
    ids.push(report.id);
    const lon = i === 1 ? 18.5 + 0.5 / 72000 : 18.5 + i * 20 / 72000;
    await pool.query(`INSERT INTO report (id, token_sha256, event_type, captured_at, occurred_at,
      occurred_source, occurred_coarseness, device_lat, device_lon, accuracy_m, device_fix_at,
      incident_lat, incident_lon, incident_source, has_note, photo_sha256, app_version,
      privacy_policy_version, terms_of_use_version, received_at)
      VALUES ($1,$2,'person_with_gun',$3,$3,'device_clock','exact',49.5,$4,8,$3,
        49.5,$4,'device_fix',false,$5,'0.1.0','fixture','fixture',$6)`,
    [report.id, report.token_sha256, base.captured_at, lon,
      i < 2 ? JSON.stringify([photoHash]) : JSON.stringify([]),
      new Date(Date.parse(base.captured_at) + i * 60_000)]);
    await queueIntegrityRefresh(pool, report.id);
  }
  await waitForIntegrity(ids.slice(0, 6));
  const signals = await pool.query(`SELECT report_id, duplicate_point_count, burst_count,
    duplicate_photo_count FROM integrity_signal WHERE report_id = ANY($1::uuid[])`, [ids]);
  const byId = new Map(signals.rows.map(row => [row.report_id, row]));
  assert.equal(byId.get(ids[0]).duplicate_point_count, 1);
  assert.equal(byId.get(ids[0]).duplicate_photo_count, 1);
  assert.equal(byId.get(ids[0]).burst_count, 6);
  assert.equal(byId.get(ids[1]).duplicate_point_count, 1);
  assert.equal(byId.get(ids[1]).duplicate_photo_count, 1);
  assert.equal(byId.get(ids[5]).burst_count, 6);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM findings WHERE report_id = ANY($1::uuid[])', [ids])).rows[0].n, 0);
});

test('cluster follows links through an intermediate Report', async () => {
  const chain = Array.from({ length: 3 }, () => reportAt());
  for (const [index, report] of chain.entries()) {
    ids.push(report.id);
    const lon = 18.5 + index * 400 / 72000;
    await pool.query(`INSERT INTO report (id, token_sha256, event_type, captured_at, occurred_at,
      occurred_source, occurred_coarseness, device_lat, device_lon, accuracy_m, device_fix_at,
      incident_lat, incident_lon, incident_source, has_note, app_version,
      privacy_policy_version, terms_of_use_version, received_at)
      VALUES ($1,$2,'shot',$3,$3,'device_clock','exact',49.5,$4,8,$3,
        49.5,$4,'device_fix',false,'0.1.0','fixture','fixture',$3)`,
    [report.id, report.token_sha256, '2027-01-02T12:00:00Z', lon]);
  }
  assert.deepEqual(await clusterReportIds(chain[0].id), chain.map(report => report.id).sort());
});

test('queued refresh adds a signal row to a Report completed before this feature', async () => {
  const report = reportAt();
  ids.push(report.id);
  const at = '2026-01-01T00:00:00Z';
  await pool.query(`INSERT INTO report (id, token_sha256, event_type, captured_at, occurred_at,
    occurred_source, occurred_coarseness, device_lat, device_lon, accuracy_m, device_fix_at,
    incident_lat, incident_lon, incident_source, has_note, app_version,
    privacy_policy_version, terms_of_use_version, received_at)
    VALUES ($1,$2,'shot',$3,$3,'device_clock','exact',49.5,18.5,8,$3,
      49.5,18.5,'device_fix',false,'0.1.0','fixture','fixture',$3)`,
  [report.id, report.token_sha256, at]);
  await queueIntegrityRefresh(pool, report.id);
  await waitForIntegrity([report.id]);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM integrity_signal WHERE report_id = $1',
    [report.id])).rows[0].n, 1);
});

test('a later commit requeues an already refreshed neighbour', async () => {
  const reports = [reportAt(), reportAt()];
  ids.push(...reports.map(report => report.id));
  const clients = await Promise.all([pool.connect(), pool.connect()]);
  try {
    await Promise.all(clients.map(client => client.query('BEGIN')));
    for (const [index, client] of clients.entries()) {
      const report = reports[index];
      await client.query(`INSERT INTO report (id, token_sha256, event_type, captured_at, occurred_at,
        occurred_source, occurred_coarseness, device_lat, device_lon, accuracy_m, device_fix_at,
        incident_lat, incident_lon, incident_source, has_note, app_version,
        privacy_policy_version, terms_of_use_version)
        VALUES ($1,$2,'shot',$3,$3,'device_clock','exact',49.5,18.7,8,$3,
          49.5,18.7,'device_fix',false,'0.1.0','fixture','fixture')`,
      [report.id, report.token_sha256, '2027-01-02T12:00:00Z']);
      await queueIntegrityRefresh(client, report.id);
    }
    await clients[0].query('COMMIT');
    await waitForIntegrity([reports[0].id]);
    assert.equal((await pool.query('SELECT duplicate_point_count FROM integrity_signal WHERE report_id = $1',
      [reports[0].id])).rows[0].duplicate_point_count, 0);
    await clients[1].query('COMMIT');
    await waitForIntegrity(reports.map(report => report.id));
    const counts = await pool.query('SELECT duplicate_point_count FROM integrity_signal WHERE report_id = ANY($1::uuid[])',
      [reports.map(report => report.id)]);
    assert.deepEqual(counts.rows.map(row => row.duplicate_point_count).sort(), [1, 1]);
  } finally {
    await Promise.all(clients.map(async client => { await client.query('ROLLBACK'); client.release(); }));
  }
});

test('operator events reverse exclusion count and leave unpublishing distinct', async () => {
  const id = ids[0];
  const signalBefore = (await pool.query('SELECT duplicate_point_count, burst_count, duplicate_photo_count FROM integrity_signal WHERE report_id = $1', [id])).rows[0];
  const count = async () => (await pool.query(`SELECT
    count(*) FILTER (WHERE exclusion_reason IS NULL)::int AS included,
    count(*) FILTER (WHERE exclusion_reason IS NOT NULL)::int AS excluded
    FROM report_public_state WHERE id = $1`, [id])).rows[0];
  assert.deepEqual(await count(), { included: 1, excluded: 0 });
  await exclude([id], 'test');
  assert.deepEqual(await count(), { included: 0, excluded: 1 });
  assert.deepEqual((await pool.query('SELECT duplicate_point_count, burst_count, duplicate_photo_count FROM integrity_signal WHERE report_id = $1', [id])).rows[0], signalBefore);
  assert.deepEqual((await pool.query(`SELECT kind FROM report_event WHERE report_id = $1
    AND kind IN ('excluded', 'exclusion_lifted') ORDER BY id`, [id])).rows.map(row => row.kind), ['excluded']);
  await liftExclusion([id]);
  assert.deepEqual(await count(), { included: 1, excluded: 0 });
  assert.deepEqual((await pool.query('SELECT duplicate_point_count, burst_count, duplicate_photo_count FROM integrity_signal WHERE report_id = $1', [id])).rows[0], signalBefore);
  await unpublish(id);
  assert.equal((await pool.query('SELECT publishable FROM report WHERE id = $1', [id])).rows[0].publishable, false);
  assert.deepEqual(await count(), { included: 1, excluded: 0 });
});

test('cluster and daily digest list ids without precise locations', async () => {
  const cluster = await clusterReportIds(ids[5]);
  assert.ok(ids.slice(0, 6).every(id => cluster.includes(id)));
  const photoHash = randomBytes(32).toString('hex');
  const fixture = [
    { ...reportAt(), lat: 49.5, lon: 18.5 },
    { ...reportAt(), lat: 53.403481363130055, lon: 22.658699342051676 }
  ];
  for (const report of fixture) {
    ids.push(report.id);
    await pool.query(`INSERT INTO report (id, token_sha256, event_type, captured_at, occurred_at,
      occurred_source, occurred_coarseness, device_lat, device_lon, accuracy_m, device_fix_at,
      incident_lat, incident_lon, incident_source, has_note, photo_sha256, app_version,
      privacy_policy_version, terms_of_use_version, received_at)
      VALUES ($1,$2,'person_with_gun',$3,$3,'device_clock','exact',$4,$5,8,$3,
        $4,$5,'device_fix',false,$6,'0.1.0','fixture','fixture',$3)`,
    [report.id, report.token_sha256, '2027-01-01T12:00:00Z', report.lat, report.lon, JSON.stringify([photoHash])]);
    await computeIntegritySignals(pool, report.id);
  }
  const digest = await digestForDay('2027-01-01');
  assert.match(digest, /Gmina: Mońki/);
  assert.ok(fixture.every(report => digest.includes(report.id)));
  assert.doesNotMatch(digest, /53\.403|22\.658|49\.5|18\.5|latitude|longitude|coordinates/);
});

test('Integrity failure keeps SQLSTATE and step, then requeue clears diagnostics', async () => {
  const pg = (await import('pg')).default;
  const admin = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL });
  const id = ids[0];
  const client = await pool.connect();
  try {
    await admin.query(`CREATE FUNCTION force_integrity_failure_04() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.report_id = '${id}'::uuid THEN
        RAISE EXCEPTION 'private report and query text' USING ERRCODE = '23514';
      END IF; RETURN NEW; END $$`);
    await admin.query(`CREATE TRIGGER force_integrity_failure_04 BEFORE INSERT OR UPDATE ON integrity_signal
      FOR EACH ROW EXECUTE FUNCTION force_integrity_failure_04()`);
    await client.query('BEGIN');
    await queueIntegrityRefresh(client, id);
    await client.query('UPDATE integrity_refresh SET attempts = 3 WHERE report_id = $1', [id]);
    await client.query('COMMIT');
    await waitForIntegrity([id], 'failed');
    const failure = (await pool.query(`SELECT failed_reason, attempts, error_class, failure_step
      FROM integrity_refresh WHERE report_id = $1`, [id])).rows[0];
    assert.deepEqual(failure, { failed_reason: 'refresh_failed', attempts: 4,
      error_class: '23514', failure_step: 'compute_signals' });
    await admin.query('DROP TRIGGER force_integrity_failure_04 ON integrity_signal');
    await admin.query('DROP FUNCTION force_integrity_failure_04()');
    await client.query('BEGIN');
    await queueIntegrityRefresh(client, id);
    const reset = (await client.query(`SELECT failed_reason, attempts, error_class, failure_step
      FROM integrity_refresh WHERE report_id = $1`, [id])).rows[0];
    assert.deepEqual(reset, { failed_reason: null, attempts: 0, error_class: null, failure_step: null });
    await client.query('COMMIT');
    await waitForIntegrity([id]);
    assert.equal((await pool.query('SELECT 1 FROM integrity_refresh WHERE report_id = $1', [id])).rowCount, 0);
  } finally {
    await client.query('ROLLBACK');
    client.release();
    await admin.query('DROP TRIGGER IF EXISTS force_integrity_failure_04 ON integrity_signal');
    await admin.query('DROP FUNCTION IF EXISTS force_integrity_failure_04()');
    await admin.end();
  }
});


test('minute receive buckets retain the inclusive 60-minute Integrity burst window', async () => {
  const reports = Array.from({ length: 3 }, () => reportAt());
  const times = ['2027-02-01T12:00:59.999Z', '2027-02-01T13:00:59.999Z', '2027-02-01T13:01:00Z'];
  for (const [index, report] of reports.entries()) {
    ids.push(report.id);
    await pool.query(`INSERT INTO report (id, token_sha256, event_type, captured_at, occurred_at,
      occurred_source, occurred_coarseness, incident_lat, incident_lon, incident_source, has_note,
      app_version, privacy_policy_version, terms_of_use_version, received_at)
      VALUES ($1,$2,'shot',$3,$3,'device_clock','exact',49,19,'moved_by_reporter',false,
        'test','test','test',date_trunc('minute',$3::timestamptz))`,
    [report.id, report.token_sha256, times[index]]);
  }
  await computeIntegritySignals(pool, reports[0].id);
  const matches = (await pool.query('SELECT report_id FROM integrity_matches($1) WHERE burst ORDER BY report_id',
    [reports[0].id])).rows.map(row => row.report_id);
  assert.deepEqual(matches, reports.slice(0, 2).map(report => report.id).sort());
  assert.equal((await pool.query('SELECT burst_count FROM integrity_signal WHERE report_id = $1',
    [reports[0].id])).rows[0].burst_count, 2);
});
