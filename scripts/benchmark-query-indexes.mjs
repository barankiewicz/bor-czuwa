// Run only against a disposable database. Drops and recreates ticket 18 indexes.
import pg from 'pg';
import { readFile } from 'node:fs/promises';

const url = process.env.TEST_DATABASE_URL;
if (!url || process.env.BENCHMARK_DISPOSABLE !== '1') {
  throw new Error('Set TEST_DATABASE_URL to a disposable database and BENCHMARK_DISPOSABLE=1');
}
const client = new pg.Client({ connectionString: url });
await client.connect();

const migration = await readFile(new URL('../server/migrations/005-query-indexes.sql', import.meta.url), 'utf8');
const target = '00000000-0000-0000-0000-000000007750';
const queries = {
  history: `SELECT kind, event_id, at, details FROM report_event
    WHERE report_id = '${target}' AND kind IN ('notice_composed', 'handed_to_mail_client', 'confirmed_by_reporter', 'outcome_reported') ORDER BY id`,
  latest_state: `SELECT kind, details, at FROM report_event WHERE report_id = '${target}'
    AND kind IN ('excluded', 'exclusion_lifted') ORDER BY id DESC LIMIT 1`,
  outcome_prerequisite: `SELECT 1 FROM report_event WHERE report_id = '${target}'
    AND kind = 'confirmed_by_reporter' AND details->>'notice_id' = 'test'
    AND details->>'recipient_kind' = 'police' AND details->>'unit_id' = 'unit' LIMIT 1`,
  withdrawal_events: `DELETE FROM report_event WHERE report_id = '${target}'`,
  withdrawal_findings: `DELETE FROM findings WHERE report_id = '${target}'`,
  withdrawal_job: `DELETE FROM findings_job WHERE report_id = '${target}'`,
  findings_read: `SELECT id FROM findings WHERE report_id = '${target}' ORDER BY id LIMIT 1`,
  ready_job: `SELECT * FROM findings_job WHERE failed_reason IS NULL AND available_at <= now()
    ORDER BY available_at FOR UPDATE SKIP LOCKED LIMIT 1`
};

async function plan(sql) {
  await client.query('BEGIN');
  try {
    const result = await client.query(`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${sql}`);
    const top = result.rows[0]['QUERY PLAN'][0];
    return { ms: top['Execution Time'], buffers: top.Plan['Shared Hit Blocks'] + top.Plan['Shared Read Blocks'],
      plan: top.Plan };
  } finally { await client.query('ROLLBACK'); }
}

async function writeCost() {
  await client.query('BEGIN');
  try {
    const event = await client.query(`EXPLAIN (ANALYZE, WAL, FORMAT JSON)
      INSERT INTO report_event (report_id, kind)
      SELECT id, 'created' FROM report WHERE id::text LIKE '00000000-0000-0000-0000-00000000%' LIMIT 1000`);
    const job = await client.query(`EXPLAIN (ANALYZE, WAL, FORMAT JSON)
      UPDATE findings_job SET available_at = available_at + interval '1 second'
      WHERE report_id IN (SELECT id FROM report ORDER BY id LIMIT 1000)`);
    return Object.fromEntries([['event_insert', event], ['job_update', job]].map(([name, result]) => {
      const top = result.rows[0]['QUERY PLAN'][0];
      return [name, { ms: top['Execution Time'], walBytes: top.Plan['WAL Bytes'] }];
    }));
  } finally { await client.query('ROLLBACK'); }
}

async function median(measure) {
  for (let i = 0; i < 2; i++) await measure();
  const values = [];
  for (let i = 0; i < 5; i++) values.push(await measure());
  return values.sort((a, b) => a.ms - b.ms)[2];
}

async function medianWriteCost() {
  for (let i = 0; i < 2; i++) await writeCost();
  const values = [];
  for (let i = 0; i < 5; i++) values.push(await writeCost());
  return Object.fromEntries(['event_insert', 'job_update'].map(name =>
    [name, values.map(value => value[name]).sort((a, b) => a.ms - b.ms)[2]]));
}

try {
  await client.query(`INSERT INTO report (id, token_sha256, event_type, captured_at, occurred_at,
    occurred_source, occurred_coarseness, incident_lat, incident_lon, incident_source,
    has_note, app_version, privacy_policy_version, terms_of_use_version)
    SELECT ('00000000-0000-0000-0000-' || lpad(n::text, 12, '0'))::uuid,
      repeat('a', 64), 'shot', now(), now(), 'device_clock', 'exact',
      52, 21, 'moved_by_reporter', false, 'test', 'v1', 'v1'
    FROM generate_series(1, 20000) AS n`);
  await client.query(`INSERT INTO report_event (report_id, kind, details)
    SELECT r.id, CASE WHEN n = 1 THEN 'confirmed_by_reporter'
      WHEN n = 2 THEN 'notice_composed' WHEN n = 3 THEN 'handed_to_mail_client'
      WHEN n = 4 THEN 'outcome_reported'
      WHEN n = 9 AND right(r.id::text, 1) = '0' THEN 'excluded'
      WHEN n = 10 AND right(r.id::text, 1) = '0' THEN 'exclusion_lifted'
      ELSE 'created' END,
      CASE WHEN n = 1 THEN '{"notice_id":"test","recipient_kind":"police","unit_id":"unit"}'::jsonb ELSE '{}'::jsonb END
    FROM report r CROSS JOIN generate_series(1, 10) AS n`);
  await client.query(`INSERT INTO findings_job (report_id, failed_reason, available_at)
    SELECT id, CASE WHEN right(id::text, 2)::int % 50 = 0 THEN NULL ELSE 'terminal' END,
      now() - interval '1 minute' FROM report`);
  await client.query(`INSERT INTO geodata_snapshot (id, datasets, coverage)
    VALUES ('benchmark', '[]', ST_Multi(ST_MakeEnvelope(0, 0, 1, 1, 2180)))`);
  await client.query(`INSERT INTO findings (report_id, rule_set_id, geodata_snapshot_id,
    dwelling_distance, obwod_lowiecki)
    SELECT id, (SELECT id FROM rule_set LIMIT 1), 'benchmark', '{}', '{}' FROM report
    WHERE right(id::text, 1) = '0'`);
  await client.query('ANALYZE report');
  await client.query('ANALYZE report_event');
  await client.query('ANALYZE findings_job');
  await client.query('ANALYZE findings');
  for (const name of ['report_event_report_id_id_idx', 'findings_job_ready_idx']) {
    await client.query(`DROP INDEX ${name}`);
  }
  const results = {};
  for (const state of ['before', 'after']) {
    if (state === 'after') {
      await client.query(migration);
      await client.query('ANALYZE report_event');
      await client.query('ANALYZE findings_job');
    }
    results[state] = { queries: {}, write: {} };
    for (const [name, sql] of Object.entries(queries)) {
      results[state].queries[name] = await median(() => plan(sql));
    }
    results[state].write = await medianWriteCost();
    results[state].indexBytes = state === 'after'
      ? (await client.query(`SELECT indexrelid::regclass::text AS name, pg_relation_size(indexrelid) AS bytes
          FROM pg_index WHERE indexrelid::regclass::text IN
          ('report_event_report_id_id_idx', 'findings_job_ready_idx') ORDER BY name`)).rows
      : [];
  }
  console.log(JSON.stringify({ reports: 20000, events: 200000, jobs: 20000,
    terminalJobs: 19600, findings: 2000, results }, null, 2));
} finally { await client.end(); }
