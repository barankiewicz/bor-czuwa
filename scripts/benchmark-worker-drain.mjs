// Times how long the running API process (server/main.ts) takes to drain 10,000 queued
// Findings jobs. It only inserts the workload and watches the queue; the worker loop under
// test is the one already serving DATABASE_URL.
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { cpus, totalmem } from 'node:os';
import { setTimeout } from 'node:timers/promises';
import pg from 'pg';

if (process.env.BENCHMARK_DISPOSABLE !== '1' || !process.env.DATABASE_URL || !process.argv[2]) {
  throw new Error('Usage: BENCHMARK_DISPOSABLE=1 DATABASE_URL=<disposable owner URL> node scripts/benchmark-worker-drain.mjs <output.json> [label]');
}
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const workload = (await readFile(new URL('../.scratch/faza-2/workloads/scattered.jsonl', import.meta.url), 'utf8'))
  .trim().split('\n').slice(0, 10_000).map(line => JSON.parse(line));
const ids = workload.map(row => row.id);
if (workload.length !== 10_000) throw new Error('Expected 10,000 workload Reports');
if ((await pool.query('SELECT 1 FROM report WHERE id = ANY($1::uuid[]) LIMIT 1', [ids])).rowCount) {
  await pool.end();
  throw new Error('Workload Report IDs already exist; use an empty disposable database');
}
const queued = async () => (await pool.query(`SELECT count(*)::int AS count FROM findings_job
  WHERE report_id = ANY($1::uuid[]) AND failed_reason IS NULL`, [ids])).rows[0].count;

try {
  for (let offset = 0; offset < workload.length; offset += 1000) {
    await pool.query(`INSERT INTO report (id, token_sha256, event_type, captured_at, occurred_at,
      occurred_source, occurred_coarseness, device_lat, device_lon, accuracy_m, device_fix_at,
      incident_lat, incident_lon, incident_source, has_note, app_version,
      privacy_policy_version, terms_of_use_version)
      SELECT id, token_sha256, 'shot', captured_at::timestamptz, captured_at::timestamptz,
        'device_clock', 'exact', lat, lon, 8, captured_at::timestamptz,
        lat, lon, 'device_fix', false, '0.1.0', 'internal-workload', 'internal-workload'
      FROM jsonb_to_recordset($1::jsonb) AS fixture(id uuid, token_sha256 text,
        captured_at text, lat double precision, lon double precision)`,
    [JSON.stringify(workload.slice(offset, offset + 1000).map(row => ({
      id: row.id, token_sha256: row.token_sha256, captured_at: row.captured_at,
      lat: row.incident_location.lat, lon: row.incident_location.lon })))]);
  }
  const started = Date.now();
  await pool.query('INSERT INTO findings_job (report_id) SELECT unnest($1::uuid[])', [ids]);
  const samples = [];
  let remaining = ids.length;
  while (remaining > 0 && Date.now() - started < 45 * 60_000) {
    await setTimeout(1000);
    remaining = await queued();
    samples.push({ seconds: Math.round((Date.now() - started) / 1000), remaining });
  }
  const outcomes = (await pool.query(`SELECT kind, count(*)::int AS count FROM report_event
    WHERE report_id = ANY($1::uuid[]) AND kind IN ('findings_computed', 'findings_failed') GROUP BY kind ORDER BY kind`,
  [ids])).rows;
  const result = { label: process.argv[3] ?? null, measuredAt: new Date().toISOString(), node: process.version,
    hardware: { cpu: cpus()[0].model, logicalCpus: cpus().length, memoryBytes: totalmem() },
    workloadSha256: createHash('sha256').update(JSON.stringify(workload)).digest('hex'),
    method: '10,000 scattered Findings jobs queued at once against disposable fixture PostGIS, drained by the stack\'s own server/main.ts worker loop; queue sampled every second.',
    jobs: ids.length, drained: remaining === 0, drainSeconds: remaining === 0 ? samples.at(-1).seconds : null,
    remaining, outcomes, samples: samples.filter((_, index) => index % 30 === 0 || index === samples.length - 1) };
  await writeFile(process.argv[2], `${JSON.stringify(result, null, 2)}\n`);
  process.stderr.write(`${JSON.stringify({ ...result, samples: undefined })}\n`);
  if (!result.drained || outcomes.length !== 1 || outcomes[0].kind !== 'findings_computed' || outcomes[0].count !== 10_000) {
    process.exitCode = 1;
  }
} finally {
  for (const table of ['integrity_refresh', 'integrity_signal', 'findings_job', 'findings', 'report_event']) {
    await pool.query(`DELETE FROM ${table} WHERE report_id = ANY($1::uuid[])`, [ids]);
  }
  await pool.query('DELETE FROM report WHERE id = ANY($1::uuid[])', [ids]);
  await pool.end();
}
