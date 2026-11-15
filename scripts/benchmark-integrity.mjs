import { readFile, writeFile } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import { cpus, totalmem } from 'node:os';
import { createHash } from 'node:crypto';
import pg from 'pg';
import { backfillNextIntegritySignal, queueIntegrityNeighbors, queueIntegrityRefresh } from '../server/integrity.ts';

if (process.env.BENCHMARK_DISPOSABLE !== '1' || !process.env.DATABASE_URL) {
  throw new Error('Set BENCHMARK_DISPOSABLE=1 and DATABASE_URL to a disposable PostGIS database');
}

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 2 });
const quantile = (values, fraction) => values.sort((a, b) => a - b)[Math.ceil(values.length * fraction) - 1];
const results = [];
const workloadSha256 = {};

try {
  for (const layout of ['scattered', 'dense-cluster']) {
    const workload = await readFile(new URL(`../.scratch/faza-2/workloads/${layout}.jsonl`, import.meta.url), 'utf8');
    workloadSha256[layout] = createHash('sha256').update(workload).digest('hex');
    const rows = workload.trim().split('\n').map(line => JSON.parse(line));
    for (const size of (process.env.BENCHMARK_SIZES ?? '100,1000,10000').split(',').map(Number)) {
      const reports = rows.slice(0, size);
      const ids = reports.map(row => row.id);
      const started = performance.now();
      try {
        for (let offset = 0; offset < size; offset += 500) {
          await pool.query(`INSERT INTO report (id, token_sha256, event_type, captured_at, occurred_at,
            occurred_source, occurred_coarseness, device_lat, device_lon, accuracy_m, device_fix_at,
            incident_lat, incident_lon, incident_source, has_note, photo_sha256, app_version,
            privacy_policy_version, terms_of_use_version)
            SELECT id, token_sha256, event_type, captured_at::timestamptz, occurred_at::timestamptz,
              'device_clock', 'exact', lat, lon, 8, captured_at::timestamptz,
              lat, lon, 'device_fix', false, photo_sha256::jsonb, '0.1.0',
              'internal-workload', 'internal-workload'
            FROM jsonb_to_recordset($1::jsonb) AS fixture(id uuid, token_sha256 text, event_type text,
              captured_at text, occurred_at text, lat double precision, lon double precision,
              photo_sha256 text)`, [JSON.stringify(reports.slice(offset, offset + 500).map(row => ({
            id: row.id, token_sha256: row.token_sha256, event_type: row.event_type,
            captured_at: row.captured_at, occurred_at: row.occurred_at.at,
            lat: row.incident_location.lat, lon: row.incident_location.lon,
            photo_sha256: JSON.stringify(row.photo_sha256)
          })))]);
        }
        const insertedMs = performance.now() - started;
        const queuedAt = performance.now();
        await queueIntegrityRefresh(pool, ids[0]);
        await pool.query(`INSERT INTO integrity_refresh (report_id, expand_neighbors)
          SELECT unnest($1::uuid[]), $2::boolean ON CONFLICT (report_id) DO NOTHING`,
        [ids, process.env.BENCHMARK_EXPAND_ALL === '1']);
        const enqueueMs = performance.now() - queuedAt;
        const initialQueue = (await pool.query('SELECT count(*)::int AS count FROM integrity_refresh')).rows[0].count;
        if (process.env.BENCHMARK_ENQUEUE_ONLY === '1') {
          const withdrawalQueuedAt = performance.now();
          await queueIntegrityNeighbors(pool, ids[0]);
          const withdrawalQueueMs = performance.now() - withdrawalQueuedAt;
          const seedStartedAt = performance.now();
          await backfillNextIntegritySignal(pool);
          const seedRefreshMs = performance.now() - seedStartedAt;
          results.push({ layout, reports: size, insertedMs, enqueueMs, initialQueue,
            withdrawalQueueMs, seedRefreshMs });
          continue;
        }
        const durations = [];
        while (await backfillNextIntegritySignal(pool)) {
          durations.push(performance.now() - queuedAt);
          if (durations.length % 1000 === 0) process.stderr.write(`${layout} ${size}: ${durations.length} refreshed\n`);
        }
        const remaining = (await pool.query('SELECT count(*)::int AS count FROM integrity_refresh')).rows[0].count;
        const failures = (await pool.query(`SELECT count(*)::int AS count FROM integrity_refresh
          WHERE failed_reason IS NOT NULL`)).rows[0].count;
        const result = { layout, reports: size, insertedMs, enqueueMs, initialQueue,
          refreshed: durations.length,
          ...(process.env.BENCHMARK_EXPAND_ALL === '1' ? {} : { completionP95Ms: quantile(durations, 0.95) }),
          completionMaxMs: durations.at(-1), remaining, failures };
        results.push(result);
        process.stderr.write(`${JSON.stringify(result)}\n`);
      } finally {
        await pool.query('DELETE FROM integrity_refresh WHERE report_id = ANY($1::uuid[])', [ids]);
        await pool.query('DELETE FROM integrity_signal WHERE report_id = ANY($1::uuid[])', [ids]);
        await pool.query('DELETE FROM report WHERE id = ANY($1::uuid[])', [ids]);
      }
    }
  }
  const recoveryRow = JSON.parse((await readFile(new URL('../.scratch/faza-2/workloads/scattered.jsonl', import.meta.url), 'utf8')).split('\n')[0]);
  await pool.query(`INSERT INTO report (id, token_sha256, event_type, captured_at, occurred_at,
    occurred_source, occurred_coarseness, device_lat, device_lon, accuracy_m, device_fix_at,
    incident_lat, incident_lon, incident_source, has_note, photo_sha256, app_version,
    privacy_policy_version, terms_of_use_version)
    VALUES ($1,$2,'person_with_gun',$3,$3,'device_clock','exact',$4,$5,8,$3,
      $4,$5,'device_fix',false,$6,'0.1.0','internal-workload','internal-workload')`,
  [recoveryRow.id, recoveryRow.token_sha256, recoveryRow.captured_at,
    recoveryRow.incident_location.lat, recoveryRow.incident_location.lon,
    JSON.stringify(recoveryRow.photo_sha256)]);
  let recovery;
  try {
    await queueIntegrityRefresh(pool, recoveryRow.id);
    await pool.query(`UPDATE integrity_refresh SET lease_until = now() + interval '15 seconds' WHERE report_id = $1`,
      [recoveryRow.id]);
    const skippedWhileLeased = !(await backfillNextIntegritySignal(pool));
    await pool.query(`UPDATE integrity_refresh SET lease_until = now() - interval '1 second' WHERE report_id = $1`,
      [recoveryRow.id]);
    const recovered = await backfillNextIntegritySignal(pool);
    const signal = await pool.query('SELECT 1 FROM integrity_signal WHERE report_id = $1', [recoveryRow.id]);
    recovery = { skippedWhileLeased, recovered, signalRows: signal.rowCount };
  } finally {
    await pool.query('DELETE FROM integrity_refresh WHERE report_id = $1', [recoveryRow.id]);
    await pool.query('DELETE FROM integrity_signal WHERE report_id = $1', [recoveryRow.id]);
    await pool.query('DELETE FROM report WHERE id = $1', [recoveryRow.id]);
  }
  const database = (await pool.query('SELECT version() AS postgres, postgis_lib_version() AS postgis')).rows[0];
  const hardware = { cpu: cpus()[0].model, logicalCpus: cpus().length, memoryBytes: totalmem() };
  const evidenceFile = process.env.BENCHMARK_ENQUEUE_ONLY === '1' ? '19-neighbour-enqueue.json'
    : process.env.BENCHMARK_EXPAND_ALL === '1' ? '19-all-expansions.json' : '19-bounded-findings.json';
  await writeFile(new URL(`../.scratch/faza-2/evidence/${evidenceFile}`, import.meta.url),
    `${JSON.stringify({ measuredAt: new Date().toISOString(), node: process.version, database,
      hardware, workloadSha256, method: process.env.BENCHMARK_ENQUEUE_ONLY === '1'
        ? 'One local worker, disposable PostGIS, no API process. Bulk fixture insert, measure neighbor enqueue and one seed refresh; remaining queue is deleted without draining.'
        : process.env.BENCHMARK_EXPAND_ALL === '1'
        ? 'One local worker, disposable PostGIS, no API process. Bulk fixture insert, every Report expands neighbours; completionMaxMs is total queue drain, not per-Report p95.'
        : 'One local worker, disposable PostGIS, no API process. Bulk fixture insert, one neighbour expansion, all Reports queued for exact signal refresh.',
      results, recovery }, null, 2)}\n`);
} finally {
  await pool.end();
}
