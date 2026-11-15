import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { cpus, totalmem } from 'node:os';
import { setTimeout } from 'node:timers/promises';
import { pool } from '../server/db.ts';
import { runNextFindingsJob } from '../server/findings.ts';
import { backfillNextIntegritySignal, queueIntegrityRefresh } from '../server/integrity.ts';

if (process.env.BENCHMARK_DISPOSABLE !== '1' || !process.env.DATABASE_URL) {
  throw new Error('Set BENCHMARK_DISPOSABLE=1 and DATABASE_URL to a disposable fixture database');
}

const workload = (await readFile(new URL('../.scratch/faza-2/workloads/dense-cluster.jsonl', import.meta.url), 'utf8'))
  .trim().split('\n').slice(0, 1000).map(line => JSON.parse(line));
const ids = workload.map(row => row.id);
const quantile = (values, fraction) => values.sort((a, b) => a - b)[Math.ceil(values.length * fraction) - 1];

try {
  for (let offset = 0; offset < workload.length; offset += 500) {
    await pool.query(`INSERT INTO report (id, token_sha256, event_type, captured_at, occurred_at,
      occurred_source, occurred_coarseness, device_lat, device_lon, accuracy_m, device_fix_at,
      incident_lat, incident_lon, incident_source, has_note, photo_sha256, app_version,
      privacy_policy_version, terms_of_use_version)
      SELECT id, token_sha256, 'person_with_gun', captured_at::timestamptz, captured_at::timestamptz,
        'device_clock', 'exact', lat, lon, 8, captured_at::timestamptz,
        lat, lon, 'device_fix', false, photo_sha256::jsonb, '0.1.0',
        'internal-workload', 'internal-workload'
      FROM jsonb_to_recordset($1::jsonb) AS fixture(id uuid, token_sha256 text,
        captured_at text, lat double precision, lon double precision, photo_sha256 text)`,
    [JSON.stringify(workload.slice(offset, offset + 500).map(row => ({
      id: row.id, token_sha256: row.token_sha256, captured_at: row.captured_at,
      lat: row.incident_location.lat, lon: row.incident_location.lon,
      photo_sha256: JSON.stringify(row.photo_sha256)
    })))]);
  }
  const jobs = ids.slice(0, 100);
  await pool.query('INSERT INTO findings_job (report_id) SELECT unnest($1::uuid[])', [jobs]);
  await pool.query('INSERT INTO integrity_refresh (report_id) SELECT unnest($1::uuid[])', [ids]);
  await queueIntegrityRefresh(pool, ids[0]);
  const start = performance.now();
  const completed = new Map();
  const findings = (async () => {
    while (completed.size < jobs.length && performance.now() - start < 180_000) {
      await runNextFindingsJob();
      const terminal = await pool.query(`SELECT report_id, kind FROM report_event
        WHERE report_id = ANY($1::uuid[]) AND kind IN ('findings_computed', 'findings_failed')`, [jobs]);
      for (const row of terminal.rows) if (!completed.has(row.report_id)) {
        completed.set(row.report_id, { milliseconds: performance.now() - start, kind: row.kind });
      }
      if (completed.size < jobs.length) await setTimeout(10);
    }
  })();
  const integrity = (async () => {
    while (performance.now() - start < 180_000 && await backfillNextIntegritySignal(pool)) {}
  })();
  await Promise.all([findings, integrity]);
  const times = [...completed.values()].map(item => item.milliseconds);
  const result = { measuredAt: new Date().toISOString(), node: process.version,
    hardware: { cpu: cpus()[0].model, logicalCpus: cpus().length, memoryBytes: totalmem() },
    workloadSha256: createHash('sha256').update(JSON.stringify(workload)).digest('hex'),
    method: '100 legal Findings jobs alongside 1,000 clustered Integrity refreshes, one local process and disposable fixture PostGIS; no HTTP or network latency.',
    completed: completed.size, failed: [...completed.values()].filter(item => item.kind === 'findings_failed').length,
    findingsP95Ms: quantile(times, 0.95), findingsMaxMs: quantile(times, 1),
    integrityRemaining: (await pool.query('SELECT count(*)::int AS count FROM integrity_refresh')).rows[0].count,
    auditMixedTestP95Ms: 12910, comparableToAudit: false };
  await writeFile(new URL('../.scratch/faza-2/evidence/19-findings-latency.json', import.meta.url),
    `${JSON.stringify(result, null, 2)}\n`);
  process.stderr.write(`${JSON.stringify(result)}\n`);
} finally {
  for (const table of ['integrity_refresh', 'integrity_signal', 'findings_job', 'findings', 'report_event']) {
    await pool.query(`DELETE FROM ${table} WHERE report_id = ANY($1::uuid[])`, [ids]);
  }
  await pool.query('DELETE FROM report WHERE id = ANY($1::uuid[])', [ids]);
  await pool.end();
}
