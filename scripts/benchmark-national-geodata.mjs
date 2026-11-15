import { createHash, randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { cpus, hostname, totalmem } from 'node:os';
import { performance } from 'node:perf_hooks';
import { pool } from '../server/db.ts';
import { runNextFindingsJob } from '../server/findings.ts';

if (process.env.BENCHMARK_DISPOSABLE !== '1' || !process.env.DATABASE_URL || !process.argv[2]) {
  throw new Error('Set BENCHMARK_DISPOSABLE=1 and DATABASE_URL to an empty disposable national database; pass output JSON path');
}

const ids = [];
const quantile = (values, fraction) => [...values].sort((a, b) => a - b)[Math.ceil(values.length * fraction) - 1];
try {
  // National counts and workload preparation are outside the timed worker transactions.
  await pool.query("SET statement_timeout = '5min'");
  const { rows: [snapshot] } = await pool.query(`SELECT s.* FROM current_geodata c
    JOIN geodata_snapshot s ON s.id = c.snapshot_id`);
  if (!snapshot || !/^geo_[a-f0-9]{20}$/.test(snapshot.storage_schema ?? '')) {
    throw new Error('Current snapshot has no versioned storage');
  }
  const schema = snapshot.storage_schema;
  const { rows: [counts] } = await pool.query(`SELECT
    (SELECT count(*)::int FROM report) AS reports,
    (SELECT count(*)::int FROM findings_job) AS jobs,
    (SELECT count(*)::int FROM ${schema}.dwelling) AS dwellings,
    (SELECT count(*)::int FROM ${schema}.recipient_jurisdiction WHERE kind = 'voiv') AS voivodeships`);
  if (counts.reports || counts.jobs || counts.dwellings < 1_000_000 || counts.voivodeships !== 16 ||
    snapshot.datasets.length !== 10 || snapshot.datasets.some(row => !row.source_url.startsWith('https://'))) {
    throw new Error('Benchmark requires empty Reports/jobs and a complete nationwide snapshot, not fixture coverage');
  }
  // Include the most detailed complete park and Natura polygons, without changing their storage.
  const { rows: protectedPoints } = await pool.query(`WITH points AS (
    SELECT kind, inspire_id, name, ST_NPoints(geom) AS vertices, ST_PointOnSurface(geom) AS point
    FROM ${schema}.protected_area
    WHERE kind IN ('park_narodowy', 'natura_2000_oso', 'natura_2000_soo')),
    ranked AS (SELECT p.*, row_number() OVER (PARTITION BY kind ORDER BY vertices DESC, inspire_id) AS rank
      FROM points p JOIN geodata_snapshot s ON s.id = $1 AND ST_Covers(s.coverage,p.point))
    SELECT kind, inspire_id, name, vertices,
      ST_X(ST_Transform(point,4326)) AS lon, ST_Y(ST_Transform(point,4326)) AS lat
    FROM ranked WHERE rank <= 50 ORDER BY kind, rank`, [snapshot.id]);
  for (const kind of ['park_narodowy', 'natura_2000_oso', 'natura_2000_soo']) {
    if (!protectedPoints.some(point => point.kind === kind)) throw new Error(`Missing national layer: ${kind}`);
  }
  const gridCount = 1000 - protectedPoints.length;
  const { rows: gridPoints } = await pool.query(`WITH covered AS (
    SELECT grid.i, grid.j, ST_Centroid(grid.geom) AS geom
    FROM geodata_snapshot s CROSS JOIN LATERAL ST_SquareGrid(10000, s.coverage) grid
    WHERE s.id = $1 AND ST_Covers(s.coverage, ST_Centroid(grid.geom))),
    distributed AS (SELECT *, ntile($2) OVER (ORDER BY i,j) AS bucket FROM covered)
    SELECT DISTINCT ON (bucket) 'national_grid' AS kind,
      ST_X(ST_Transform(geom,4326)) AS lon, ST_Y(ST_Transform(geom,4326)) AS lat
    FROM distributed ORDER BY bucket,i,j`, [snapshot.id, gridCount]);
  const workload = [...gridPoints, ...protectedPoints];
  if (workload.length !== 1000) throw new Error('National grid does not supply 1,000 points');
  const { rows: distribution } = await pool.query(`SELECT v.unit_id, v.name, count(*)::int AS points
    FROM jsonb_to_recordset($1::jsonb) AS p(lat double precision, lon double precision)
    JOIN ${schema}.recipient_jurisdiction v ON v.kind = 'voiv'
      AND ST_Covers(v.geom, ST_Transform(ST_SetSRID(ST_MakePoint(p.lon,p.lat),4326),2180))
    GROUP BY v.unit_id,v.name ORDER BY v.unit_id`, [JSON.stringify(workload)]);
  if (distribution.length !== 16) throw new Error('National workload must exercise all 16 voivodeships');
  await pool.query("SET statement_timeout = '10s'");
  const durations = [];
  const failures = [];
  const started = performance.now();
  for (const [index, point] of workload.entries()) {
    const id = randomUUID();
    ids.push(id);
    await pool.query(`INSERT INTO report (id, token_sha256, event_type, captured_at, occurred_at,
      occurred_source, occurred_coarseness, device_lat, device_lon, accuracy_m, device_fix_at,
      incident_lat, incident_lon, incident_source, has_note, photo_sha256, app_version,
      privacy_policy_version, terms_of_use_version)
      VALUES ($1,$2,'person_with_gun','2026-10-01T12:00:00Z','2026-10-01T12:00:00Z',
        'device_clock','exact',$3,$4,8,'2026-10-01T12:00:00Z',$3,$4,'device_fix',false,
        '[]'::jsonb,'0.1.0','national-benchmark','national-benchmark')`,
    [id, createHash('sha256').update(id).digest('hex'), point.lat, point.lon]);
    await pool.query('INSERT INTO findings_job (report_id) VALUES ($1)', [id]);
    const start = performance.now();
    await runNextFindingsJob();
    const milliseconds = performance.now() - start;
    const { rows: [state] } = await pool.query(`SELECT
      (SELECT count(*)::int FROM findings WHERE report_id = $1) AS computed,
      (SELECT attempts FROM findings_job WHERE report_id = $1) AS attempts,
      (SELECT failed_reason FROM findings_job WHERE report_id = $1) AS failed_reason`, [id]);
    if (state.computed !== 1) failures.push({ index, point, milliseconds, ...state });
    durations.push({ index, milliseconds, kind: point.kind });
    if ((index + 1) % 100 === 0) process.stderr.write(`National Findings ${index + 1}/1000\n`);
    if (state.computed !== 1) break;
  }
  const times = durations.map(row => row.milliseconds);
  const result = { measuredAt: new Date().toISOString(), node: process.version,
    hardware: { hostname: hostname(), cpu: cpus()[0].model, logicalCpus: cpus().length, memoryBytes: totalmem() },
    method: 'Sequential real runNextFindingsJob transactions with existing 10 s statement timeout; insertion and result checks excluded. Deterministic 10 km national grid plus up to 50 most detailed original polygons per park/Natura layer. No HTTP latency or concurrent workers.',
    snapshot: { id: snapshot.id, storageSchema: schema, datasets: snapshot.datasets }, counts,
    workloadSha256: createHash('sha256').update(JSON.stringify(workload)).digest('hex'), workload, distribution,
    completed: durations.length - failures.length, failures, durations,
    findingsP95Ms: quantile(times, 0.95), findingsMaxMs: quantile(times, 1),
    durationSeconds: (performance.now() - started) / 1000,
    subdivision: false,
    accepted: durations.length === 1000 && failures.length === 0 && quantile(times, 0.95) < 10000 };
  await writeFile(process.argv[2], `${JSON.stringify(result, null, 2)}\n`);
  process.stderr.write(`National Findings p95=${result.findingsP95Ms}ms max=${result.findingsMaxMs}ms completed=${result.completed}\n`);
  if (!result.accepted) process.exitCode = 1;
} finally {
  try {
    for (const table of ['findings_job', 'findings', 'report_event']) {
      await pool.query(`DELETE FROM ${table} WHERE report_id = ANY($1::uuid[])`, [ids]);
    }
    await pool.query('DELETE FROM report WHERE id = ANY($1::uuid[])', [ids]);
  } finally {
    await pool.end();
  }
}
