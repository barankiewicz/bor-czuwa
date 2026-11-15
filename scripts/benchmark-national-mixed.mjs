import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import { setTimeout as sleep } from 'node:timers/promises';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { homeArea, outgoingArea } from '../src/lib/home-area.ts';
import { reportSchema } from '../src/lib/report.ts';

const self = fileURLToPath(import.meta.url);
const sha = value => createHash('sha256').update(value).digest('hex');
const percentile = (values, fraction) => values.length ? [...values].sort((a, b) => a - b)[Math.ceil(values.length * fraction) - 1] : null;
function summary(rows) {
  return Object.fromEntries([...new Set(rows.map(row => row.route))].map(route => {
    const selected = rows.filter(row => row.route === route);
    return [route, { count: selected.length, statuses: selected.reduce((out, row) => {
      out[row.status] = (out[row.status] ?? 0) + 1; return out;
    }, {}), p50Ms: percentile(selected.map(row => row.milliseconds), .5),
    p95Ms: percentile(selected.map(row => row.milliseconds), .95),
    maxMs: percentile(selected.map(row => row.milliseconds), 1),
    maxSchedulingLagMs: Math.max(...selected.map(row => row.schedulingLagMs ?? 0)) }];
  }));
}

const at = '2026-10-01T12:00:00Z';
function reportFor(point, id, token, area) {
  const event = area?.eventType ?? 'person_with_gun';
  return reportSchema.parse({ id, token_sha256: sha(token), event_type: event, captured_at: at,
    occurred_at: { at, source: 'device_clock', coarseness: 'exact' },
    device_fix: area ? null : { lat: point.lat, lon: point.lon, accuracy_m: 8, at },
    incident_location: area?.location ?? { lat: point.lat, lon: point.lon, source: 'device_fix' },
    species: null, ...(event === 'shot' ? {} : { photo_sha256: [] }), has_note: false,
    app_version: '0.1.0', privacy_policy_version: 'mixed-benchmark', terms_of_use_version: 'mixed-benchmark' });
}

function areaFor(point, index, sourceIndex = index) {
  const kind = ['home-4km', 'home-8km', 'hearing', 'sighting', 'selected'][index % 5];
  const distance = [500, 1500, 3000][Math.floor(index / 5) % 3];
  const draft = { fix: { lat: point.lat, lon: point.lon, accuracy_m: 8, at }, fromHome: false,
    eventType: kind === 'hearing' ? 0 : 1, hearingBearing: (Math.floor(index / 5) * 35) % 360,
    hearingDistanceM: distance };
  const location = kind.startsWith('home-') ? homeArea(point, kind === 'home-4km' ? 4 : 8)
    : kind === 'selected' ? outgoingArea({ eventType: 1, locationMethod: 'map',
      manualLat: String(point.lat), manualLon: String(point.lon), pointRadiusM: distance })
      : outgoingArea(draft);
  return { sourceIndex, sourceKind: point.kind, sourceId: point.inspire_id ?? `national_grid:${sourceIndex}`,
    kind, eventType: kind === 'hearing' ? 'shot' : 'person_with_gun', location };
}

async function standSourceContext(pool, snapshot) {
  if (!/^geo_[a-f0-9]{20}$/.test(snapshot.storage_schema)) throw new Error('Invalid snapshot storage schema');
  const datasetPresent = snapshot.datasets.some(dataset => dataset.name === 'OpenStreetMap hunting stands');
  const { rows: [table] } = await pool.query('SELECT to_regclass($1) IS NOT NULL AS installed', [`${snapshot.storage_schema}.ambona`]);
  const count = table.installed
    ? (await pool.query(`SELECT count(*)::int AS count FROM ${snapshot.storage_schema}.ambona`)).rows[0].count : null;
  return { datasetPresent, tableInstalled: table.installed, count,
    availability: !datasetPresent ? 'dataset-not-in-snapshot' : !table.installed ? 'snapshot-table-missing'
      : count === 0 ? 'installed-empty' : 'installed-nonempty' };
}

function areaMeasurementsAccepted(values, areas, snapshotId, standSource) {
  const fraction = value => Number.isFinite(value) && value >= 0 && value <= 1;
  return values.some(value => value.dwelling_distance.status === 'area_measured') && values.every((value, index) => {
    if (value.shape_version !== 2 || value.accuracy_m !== null ||
      value.geodata_snapshot_id !== snapshotId || JSON.stringify(value.area_bounds) !== JSON.stringify(areas[index].location.bounds)) return false;
    const dwelling = value.dwelling_distance;
    if (dwelling.status === 'not_computed') {
      return areas[index].context?.fully_covered === false && dwelling.reason === 'outside_coverage' &&
        value.obwod_lowiecki.reason === 'outside_coverage' && value.protected_areas.reason === 'outside_coverage' &&
        value.nearest_ambona.reason === 'outside_coverage';
    }
    if (!['area_measured', 'area_none_within_radius'].includes(dwelling.status) || dwelling.basis !== 'area' ||
      !fraction(dwelling.within_threshold_share) || !Number.isFinite(dwelling.threshold_m) || dwelling.threshold_m <= 0 ||
      dwelling.search_radius_m !== 1000 || typeof dwelling.contains_dwelling !== 'boolean' ||
      !['beyond_threshold', 'partly_within_threshold', 'contains_dwelling'].includes(dwelling.class)) return false;
    if (dwelling.status === 'area_measured' ? !Number.isFinite(dwelling.min_m) || dwelling.min_m < 0
      : dwelling.min_m !== null || dwelling.within_threshold_share !== 0 || dwelling.contains_dwelling) return false;
    const district = value.obwod_lowiecki;
    if (district.status !== 'area' || !fraction(district.outside_share) ||
      !district.obwody.every(row => fraction(row.share) && row.share > 0)) return false;
    const stand = value.nearest_ambona;
    if (standSource.datasetPresent) {
      if (!standSource.tableInstalled || !Number.isInteger(standSource.count) || standSource.count < 0) return false;
      if (standSource.count > 0) {
        if (stand.status !== 'mapped' || stand.measured_from !== 'area_edge' ||
          !Number.isFinite(stand.distance_m) || stand.distance_m < 0) return false;
      } else if (stand.status !== 'none_mapped') return false;
    } else if (stand.status !== 'none_mapped') return false;
    const protectedAreas = value.protected_areas;
    if (protectedAreas.status !== 'computed') return false;
    return ['park_narodowy', 'rezerwat', 'otulina', 'park_krajobrazowy', 'natura_2000_oso', 'natura_2000_soo']
      .every(kind => protectedAreas[kind].every(row => fraction(row.area_share) && row.area_share > 0 &&
        ['wholly_inside', 'partly_inside'].includes(row.coverage) &&
        (row.coverage !== 'partly_inside' || row.boundary_distance === undefined)));
  });
}

async function drive(base, config) {
  const requests = [], reports = [], prepared = [];
  async function request(route, path, payload, headers = {}, scheduled = performance.now()) {
    const started = performance.now(), startedAtMs = Date.now();
    let status = 0, body, retryAfter;
    try {
      const response = await fetch(`${base}${path}`, { method: payload ? 'POST' : 'GET',
        headers: { 'content-type': 'application/json', ...headers },
        body: payload ? JSON.stringify(payload) : undefined, signal: AbortSignal.timeout(20000) });
      status = response.status;
      retryAfter = response.headers.get('retry-after');
      body = await response.json();
    } catch (error) { body = { error: error.name }; }
    requests.push({ route, status, milliseconds: performance.now() - started, startedAtMs, endedAtMs: Date.now(),
      schedulingLagMs: Math.max(0, started - scheduled), retryAfter, error: body?.error });
    return { status, body };
  }
  // Proof of work is client CPU. Prepare it before timing so it cannot stall the offered HTTP schedule.
  for (let index = 0; index < config.seconds * config.capturesPerSecond; index++) {
    const response = await fetch(`${base}/api/challenge`, { signal: AbortSignal.timeout(20000) });
    if (!response.ok) throw new Error(`Challenge preparation failed: ${response.status}`);
    const challenge = await response.json();
    let number = 0;
    while (number <= challenge.maxnumber && sha(challenge.salt + number) !== challenge.challenge) number++;
    if (number > challenge.maxnumber) throw new Error('No challenge solution');
    const { maxnumber: _, ...proof } = challenge;
    prepared.push({ ...proof, number });
  }
  if (process.send) process.send({ ready: true });
  if (process.connected) await new Promise(resolve => process.once('message', resolve));
  const started = performance.now(), pending = [];
  for (const [route, rate] of [['capture', config.capturesPerSecond], ['lookup', config.lookupsPerSecond], ['read', config.readsPerSecond]]) {
    for (let index = 0; index < config.seconds * rate; index++) {
      const scheduled = started + index * 1000 / rate;
      pending.push((async () => {
        await sleep(Math.max(0, scheduled - performance.now()));
        const point = config.points[(index * 37) % config.points.length];
        if (route === 'capture') {
          const token = randomBytes(32).toString('hex'), id = randomUUID();
          const report = reportFor(point, id, token, config.areas?.[(index * 37) % config.points.length]);
          const response = await request(route, '/api/reports', { ...report, solution: prepared[index] },
            { 'x-real-ip': `198.18.${Math.floor(index / 250)}.${index % 250 + 1}` }, scheduled);
          if (response.status === 201) reports.push({ id, token,
            ...(config.areas ? { areaIndex: (index * 37) % config.points.length } : {}) });
        } else if (route === 'lookup') await request(route, '/api/recipients',
          config.areas ? config.areas[(index * 37) % config.points.length].location : { lat: point.lat, lon: point.lon }, {}, scheduled);
        else {
          const report = config.readReports?.[index % config.readReports.length] ?? reports[0];
          await request(route, report ? `/api/reports/${report.id}/findings` : '/api/ready', undefined,
            report ? { authorization: `Bearer ${report.token}` } : {}, scheduled);
        }
      })());
    }
  }
  await Promise.all(pending);
  return { seconds: (performance.now() - started) / 1000, requests, reports, summary: summary(requests),
    accepted: requests.every(row => row.error === undefined && row.status >= 200 && row.status < 300) };
}

async function prepareTraffic(base, config) {
  const { fork } = await import('node:child_process');
  const child = fork(self, ['--drive', base], { execArgv: ['--import', 'tsx'], stdio: ['ignore', 'pipe', 'inherit', 'ipc'] });
  let stdout = '';
  child.stdout.on('data', chunk => stdout += chunk);
  const traffic = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', code => code === 0 ? resolve(JSON.parse(stdout)) : reject(new Error(`Driver exited ${code}`)));
  });
  await new Promise((resolve, reject) => {
    child.on('message', message => {
      if (message.needsConfig) child.send({ config });
      else if (message.ready) resolve();
    });
    child.once('error', reject);
    child.once('exit', code => reject(new Error(`Driver preparation exited ${code}`)));
  });
  return { child, traffic };
}

async function fixtureAreas(output, base) {
  if (process.env.BENCHMARK_DISPOSABLE !== '1') throw new Error('BENCHMARK_DISPOSABLE=1 is required');
  const { pool } = await import('../server/db.ts');
  const fixtureBytes = await readFile(new URL('../data/fixtures/area-acceptance.json', import.meta.url));
  const fixture = JSON.parse(fixtureBytes);
  const centre = bounds => ({ lat: (bounds[1] + bounds[3]) / 2, lon: (bounds[0] + bounds[2]) / 2, kind: 'fixture' });
  const home4 = fixture.cases.home_cell_4km_east, home8 = fixture.cases.home_cell_8km;
  const points = [centre(home4.bounds), centre(home8.bounds),
    ...Array.from({ length: 3 }, () => centre(fixture.cases.dwelling_contains.bounds))];
  const areas = points.map((point, index) => areaFor(point, index));
  const result = { fixture: true, scope: 'Bounded area-driver compatibility proof, not national timing or capacity',
    fixtureSha256: sha(fixtureBytes), profile: { seconds: 2, capturesPerSecond: 5, lookupsPerSecond: 5, readsPerSecond: 5 },
    areas, accepted: false };
  let child;
  try {
    const { rows: [snapshot] } = await pool.query('SELECT s.* FROM current_geodata c JOIN geodata_snapshot s ON s.id=c.snapshot_id');
    if (snapshot.id !== 'moniecki-2026-09-25-osm-v1') throw new Error('Area fixture requires the unchanged published fixture snapshot');
    result.snapshotId = snapshot.id;
    result.standSource = await standSourceContext(pool, snapshot);
    for (const [index, area] of areas.entries()) {
      const { rows: [context] } = await pool.query(`SELECT ST_Covers(coverage,
        ST_Transform(ST_MakeEnvelope($1,$2,$3,$4,4326),2180)) AS fully_covered
        FROM geodata_snapshot WHERE id=$5`, [...area.location.bounds, snapshot.id]);
      area.context = context;
      area.expectedFullCoverage = index !== 1;
    }
    await writeFile(output, JSON.stringify(result, null, 2) + '\n');
    if (JSON.stringify(areas[0].location.bounds) !== JSON.stringify(home4.bounds) ||
      JSON.stringify(areas[1].location.bounds) !== JSON.stringify(home8.bounds) ||
      areas.some(area => area.context.fully_covered !== area.expectedFullCoverage)) {
      throw new Error('Generated fixture bounds/coverage differ from the existing independent expectations');
    }
    const prepared = await prepareTraffic(base, { points, areas, ...result.profile });
    child = prepared.child;
    child.send({ start: true });
    result.http = await prepared.traffic;
    const reports = result.http.reports;
    result.captures = reports;
    if (!result.http.accepted || reports.length !== 10) throw new Error('Area fixture HTTP offer failed');
    let rows = [];
    for (let attempt = 0; attempt < 100; attempt++) {
      rows = (await pool.query(`SELECT f.report_id, f.computed_at,
        to_jsonb(f) - 'id' - 'report_id' - 'computed_at' AS value
        FROM unnest($1::uuid[]) WITH ORDINALITY ids(id,position)
        JOIN findings f ON f.report_id=ids.id ORDER BY ids.position`, [reports.map(report => report.id)])).rows;
      if (rows.length === reports.length) break;
      await sleep(100);
    }
    result.measurements = rows;
    const reportAreas = reports.map(report => areas[report.areaIndex]);
    result.numericAreaContract = rows.length === 10 && areaMeasurementsAccepted(rows.map(row => row.value), reportAreas, snapshot.id, result.standSource);
    result.independentHome4Matches = rows.filter((row, index) => reportAreas[index].kind === 'home-4km').length === 2 &&
      rows.every((row, index) => reportAreas[index].kind !== 'home-4km' ||
        (Math.abs(row.value.dwelling_distance.min_m - home4.dwelling.min_m) <= 0.5 &&
          Math.abs(row.value.dwelling_distance.within_threshold_share - home4.dwelling.within_threshold_share) <= 1e-4));
    const fingerprints = new Map();
    result.repeatedMeasurementsUnchanged = rows.length === 10 && rows.every((row, index) => {
      const kind = reportAreas[index].kind, hash = sha(JSON.stringify(row.value));
      if (!fingerprints.has(kind)) fingerprints.set(kind, hash);
      return fingerprints.get(kind) === hash;
    });
    result.measuredKinds = [...new Set(rows.flatMap((row, index) =>
      row.value.dwelling_distance.status === 'area_measured' ? [reportAreas[index].kind] : []))].sort();
    result.outsideKinds = [...new Set(rows.flatMap((row, index) =>
      row.value.dwelling_distance.reason === 'outside_coverage' ? [reportAreas[index].kind] : []))].sort();
    result.end = await (await fetch(`${base}/api/worker-status`)).json();
    result.accepted = result.numericAreaContract && result.independentHome4Matches && result.repeatedMeasurementsUnchanged &&
      JSON.stringify(result.measuredKinds) === JSON.stringify(['hearing', 'home-4km', 'selected', 'sighting']) &&
      JSON.stringify(result.outsideKinds) === JSON.stringify(['home-8km']) &&
      result.end.terminal_failures === 0 && result.end.integrity_terminal_failures === 0;
    if (!result.accepted) throw new Error('Area fixture acceptance failed; inspect retained profile evidence');
  } catch (error) {
    result.error = { name: error.name, message: error.message };
    throw error;
  } finally {
    if (child?.exitCode === null) child.kill('SIGTERM');
    await writeFile(output, JSON.stringify(result, null, 2) + '\n');
    await pool.end();
  }
}

async function benchmark(output, workloadPath) {
  if (process.env.BENCHMARK_DISPOSABLE !== '1') throw new Error('BENCHMARK_DISPOSABLE=1 is required');
  const { pool } = await import('../server/db.ts');
  const workloadRecord = JSON.parse(await readFile(workloadPath, 'utf8'));
  const points = workloadRecord.workload;
  if (points.length !== 1000 || sha(JSON.stringify(points)) !== workloadRecord.workloadSha256) throw new Error('National workload hash/count mismatch');
  const { rows: [snapshot] } = await pool.query('SELECT s.* FROM current_geodata c JOIN geodata_snapshot s ON s.id=c.snapshot_id');
  if (snapshot.id !== workloadRecord.snapshot.id || !/^geo_[a-f0-9]{20}$/.test(snapshot.storage_schema)) throw new Error('Snapshot differs from pinned workload');
  const counts = (await pool.query(`SELECT (SELECT count(*)::int FROM report) AS reports,
    (SELECT count(*)::int FROM ${snapshot.storage_schema}.dwelling) AS dwellings,
    (SELECT count(*)::int FROM ${snapshot.storage_schema}.recipient_jurisdiction WHERE kind='voiv') AS voivodeships`)).rows[0];
  if (counts.reports || counts.dwellings < 1000000 || counts.voivodeships !== 16 ||
    JSON.stringify(snapshot.datasets) !== JSON.stringify(workloadRecord.snapshot.datasets)) throw new Error('Requires empty Reports and the pinned national datasets');
  const standSource = await standSourceContext(pool, snapshot);
  const waits = [];
  const connect = pool.connect.bind(pool);
  // Observe acquisitions in this benchmark process only, including Pool.query's callback form.
  pool.connect = callback => {
    const start = performance.now();
    if (callback) return connect((error, client, release) => {
      waits.push({ milliseconds: performance.now() - start, failed: !!error }); callback(error, client, release);
    });
    return connect().then(client => { waits.push({ milliseconds: performance.now() - start, failed: false }); return client; },
      error => { waits.push({ milliseconds: performance.now() - start, failed: true }); throw error; });
  };
  const result = { measuredAt: new Date().toISOString(), node: process.version, snapshot, counts, standSource,
    workloadSha256: workloadRecord.workloadSha256, workload: points, distribution: workloadRecord.distribution,
    envelope: { requestsPerSecond: 42, secondsPerMixedPhase: 30, capturesPerSecond: 2,
      lookupsPerSecond: 20, readsPerSecond: 20, seededReportsPerPhase: 1000,
      scope: 'Offered local test envelope only; not maximum capacity, long-duration or approved-host capacity. Point phases precede separately identified area phases; Reports accumulate.' },
    pool: { max: pool.options.max, connectionTimeoutMillis: pool.options.connectionTimeoutMillis,
      statement_timeout: pool.options.statement_timeout, lock_timeout: pool.options.lock_timeout },
    phases: [], accepted: false };
  process.env.HOST = '127.0.0.1'; process.env.PORT = '3001'; process.env.TRUSTED_PROXY_IP = '127.0.0.1';
  const main = import('../server/main.ts');
  const base = 'http://127.0.0.1:3001';
  async function status() { return (await (await fetch(`${base}/api/worker-status`)).json()); }
  for (let attempt = 0; ; attempt++) {
    try { if ((await fetch(`${base}/api/ready`)).ok) break; } catch { /* listener is starting */ }
    if (attempt === 100) throw new Error('API did not start');
    await sleep(100);
  }
  const baselines = new Map();
  try {
    let areas;
    const definitions = [
      { name: 'worker-only', workload: 'point', traffic: false },
      { name: 'mixed', workload: 'point', traffic: true },
      { name: 'recovery', workload: 'point', traffic: true },
      { name: 'area-worker-only', workload: 'area', traffic: false },
      { name: 'area-mixed', workload: 'area', traffic: true },
      { name: 'area-recovery', workload: 'area', traffic: true }
    ];
    for (const definition of definitions) {
      const { name, workload } = definition;
      if (workload === 'area' && !areas) {
        const setupStarted = performance.now();
        const candidates = points.flatMap((point, sourceIndex) =>
          Array.from({ length: 5 }, (_, kind) => areaFor(point, sourceIndex * 5 + kind, sourceIndex)));
        result.areaWorkload = { status: 'qualifying', candidates, reports: [],
          selection: 'Separate coverage-qualified anchors: enumerate five area kinds at every pinned point; for each kind select 200 evenly spaced eligible anchors in pinned source order; interleave kinds. Original point cohort unchanged.',
          oracle: 'Repeated measurements establish invariance, not an independent oracle for national shares.' };
        await writeFile(output, JSON.stringify(result, null, 2) + '\n');
        const { rows: coverage } = await pool.query(`SELECT (c.ordinality-1)::int AS candidate_index,
          ST_Covers(s.coverage, ST_Transform(ST_MakeEnvelope(
            (c.value->'location'->'bounds'->>0)::float, (c.value->'location'->'bounds'->>1)::float,
            (c.value->'location'->'bounds'->>2)::float, (c.value->'location'->'bounds'->>3)::float,4326),2180)) AS fully_covered
          FROM jsonb_array_elements($1::jsonb) WITH ORDINALITY c(value,ordinality)
          CROSS JOIN geodata_snapshot s WHERE s.id=$2 ORDER BY c.ordinality`, [JSON.stringify(candidates), snapshot.id]);
        for (const row of coverage) {
          const candidate = candidates[row.candidate_index];
          candidate.context = { fully_covered: row.fully_covered };
          candidate.disposition = row.fully_covered ? 'eligible-not-selected' : 'rejected-outside-full-coverage';
        }
        const kinds = ['home-4km', 'home-8km', 'hearing', 'sighting', 'selected'];
        const eligible = kinds.map(kind => candidates.filter(candidate => candidate.kind === kind && candidate.context?.fully_covered));
        result.areaWorkload.eligibleCounts = Object.fromEntries(kinds.map((kind, index) => [kind, eligible[index].length]));
        result.areaWorkload.qualificationErrors = [
          ...(coverage.length === candidates.length ? [] : ['incomplete candidate coverage results']),
          ...kinds.filter((kind, index) => eligible[index].length < 200).map(kind => `fewer than 200 fully covered ${kind} anchors`)
        ];
        await writeFile(output, JSON.stringify(result, null, 2) + '\n');
        if (result.areaWorkload.qualificationErrors.length) throw new Error('Area anchor qualification failed; attempted bounds and rejection reasons retained');
        areas = Array.from({ length: 1000 }, (_, index) => {
          const group = eligible[index % 5];
          const area = group[Math.floor(Math.floor(index / 5) * group.length / 200)];
          area.disposition = 'selected';
          return area;
        });
        result.areaWorkload.reports = areas;
        for (const area of areas) {
          const { rows: [context] } = await pool.query(`WITH area AS (
            SELECT ST_Transform(ST_MakeEnvelope($1,$2,$3,$4,4326),2180) AS geom)
            SELECT (SELECT count(*)::int FROM ${snapshot.storage_schema}.dwelling d, area a
              WHERE ST_Intersects(d.geom,a.geom)) AS dwelling_count,
              (SELECT array_agg(v.unit_id ORDER BY v.unit_id) FROM ${snapshot.storage_schema}.recipient_jurisdiction v, area a
                WHERE v.kind='voiv' AND ST_Relate(v.geom,a.geom,'T********')) AS voivodeships
            FROM area`, area.location.bounds);
          area.context = { ...area.context, ...context };
        }
        const dwellingCounts = areas.map(area => area.context.dwelling_count);
        const voivodeships = [...new Set(areas.flatMap(area => area.context.voivodeships ?? []))].sort();
        result.areaWorkload.context = { voivodeships, minimumDwellingCount: Math.min(...dwellingCounts), maximumDwellingCount: Math.max(...dwellingCounts) };
        result.areaWorkload.sha256 = sha(JSON.stringify(areas));
        result.areaWorkload.setupSeconds = (performance.now() - setupStarted) / 1000;
        result.areaWorkload.qualificationErrors = [
          ...(voivodeships.length === 16 ? [] : ['selected cohort does not intersect all 16 voivodeships']),
          ...(Math.min(...dwellingCounts) !== Math.max(...dwellingCounts) ? [] : ['selected cohort lacks observed dwelling-count variation'])
        ];
        result.areaWorkload.status = result.areaWorkload.qualificationErrors.length ? 'rejected' : 'qualified';
        await writeFile(output, JSON.stringify(result, null, 2) + '\n');
        if (result.areaWorkload.qualificationErrors.length) throw new Error('Area cohort context qualification failed; attempted cohort and reasons retained');
      }
      const existingReports = (await pool.query('SELECT count(*)::int AS count FROM report')).rows[0].count;
      const phasePoints = workload === 'area' ? areas.map(area => points[area.sourceIndex]) : points;
      const ids = [];
      for (const [index, point] of phasePoints.entries()) {
        const id = randomUUID(); ids.push(id);
        if (workload === 'area') {
          const report = reportFor(point, id, 'a'.repeat(64), areas[index]);
          const location = report.incident_location;
          await pool.query(`INSERT INTO report (id, token_sha256, event_type, captured_at, occurred_at,
            occurred_source, occurred_coarseness, device_lat, device_lon, accuracy_m, device_fix_at,
            incident_lat, incident_lon, incident_source, incident_bounds, area_basis, precise_fix_withheld,
            hearing_bearing_deg, hearing_distance_m, has_note, photo_sha256, app_version, privacy_policy_version, terms_of_use_version)
            VALUES ($1,$2,$3,$4,$4,'device_clock','exact',NULL,NULL,NULL,NULL,$5,$6,'area',$7,$8,$9,$10,$11,false,$12,
              '0.1.0','mixed-benchmark','mixed-benchmark')`, [id, report.token_sha256, report.event_type, at,
            (location.bounds[1] + location.bounds[3]) / 2, (location.bounds[0] + location.bounds[2]) / 2,
            JSON.stringify(location.bounds), location.basis, location.precise_fix_withheld,
            location.hearing_bearing_deg ?? null, location.hearing_distance_m ?? null,
            report.photo_sha256 === undefined ? null : JSON.stringify(report.photo_sha256)]);
        } else await pool.query(`INSERT INTO report (id, token_sha256, event_type, captured_at, occurred_at,
          occurred_source, occurred_coarseness, device_lat, device_lon, accuracy_m, device_fix_at,
          incident_lat, incident_lon, incident_source, has_note, photo_sha256, app_version, privacy_policy_version, terms_of_use_version)
          VALUES ($1,$2,'person_with_gun','2026-10-01T12:00:00Z','2026-10-01T12:00:00Z','device_clock','exact',
            $3,$4,8,'2026-10-01T12:00:00Z',$3,$4,'device_fix',false,'[]','0.1.0','mixed-benchmark','mixed-benchmark')`, [id, sha('a'.repeat(64)), point.lat, point.lon]);
      }
      let child, traffic;
      if (definition.traffic) {
        const config = { points: phasePoints, ...(workload === 'area' ? { areas } : {}),
          readReports: ids.slice(0, 100).map(id => ({ id, token: 'a'.repeat(64) })), seconds: 30, capturesPerSecond: 2, lookupsPerSecond: 20, readsPerSecond: 20 };
        ({ child, traffic } = await prepareTraffic(base, config));
      }
      await pool.query(`WITH jobs AS (INSERT INTO findings_job (report_id) SELECT unnest($1::uuid[]))
        INSERT INTO integrity_refresh (report_id) SELECT unnest($1::uuid[])`, [ids]);
      waits.length = 0;
      const startedAt = new Date().toISOString();
      const start = performance.now(), cpu = process.cpuUsage(), samples = [];
      if (child) child.send({ start: true });
      let initialDrainSeconds;
      while (performance.now() - start < 180000) {
        const current = await status();
        samples.push({ seconds: (performance.now() - start) / 1000, ...current,
          poolWaiting: pool.waitingCount, poolTotal: pool.totalCount, rssBytes: process.memoryUsage().rss });
        const remaining = (await pool.query(`SELECT count(*)::int AS count FROM findings_job WHERE report_id=ANY($1::uuid[])`, [ids])).rows[0].count;
        if (!remaining && initialDrainSeconds === undefined) initialDrainSeconds = (performance.now() - start) / 1000;
        if (!current.queued && !current.integrity_queued && (!child || performance.now() - start >= 30000)) break;
        await sleep(200);
      }
      const http = traffic ? await traffic : null;
      const end = await status();
      const rows = (await pool.query(`SELECT to_jsonb(f) - 'id' - 'report_id' - 'computed_at' AS value
        FROM unnest($1::uuid[]) WITH ORDINALITY ids(id,position) JOIN findings f ON f.report_id=ids.id ORDER BY ids.position`, [ids])).rows;
      const values = rows.map(row => row.value);
      const measurementsSha256 = sha(JSON.stringify(values));
      if (!baselines.has(workload)) baselines.set(workload, measurementsSha256);
      const phase = { name, workload, startedAt, endedAt: new Date().toISOString(), existingReports, initialReports: ids.length, initialDrainSeconds, seconds: (performance.now() - start) / 1000,
        cpuMicroseconds: process.cpuUsage(cpu), samples, http, end, computed: values.length, measurementsSha256,
        unchangedMeasurements: measurementsSha256 === baselines.get(workload),
        ...(workload === 'area' ? { measurements: values, numericAreaContract: areaMeasurementsAccepted(values, areas, snapshot.id, standSource) } : {}),
        poolWait: { count: waits.length, failures: waits.filter(row => row.failed).length,
          p95Ms: percentile(waits.map(row => row.milliseconds), .95), maxMs: percentile(waits.map(row => row.milliseconds), 1) } };
      result.phases.push(phase);
      await writeFile(output, JSON.stringify(result, null, 2) + '\n');
      console.error(`${name}: initial drain ${initialDrainSeconds}s, final queues ${end.queued}/${end.integrity_queued}`);
      if (name === 'mixed' || name === 'area-mixed') {
        const held = await Promise.all(Array.from({ length: 5 }, () => pool.connect()));
        const start = performance.now(), waitStart = waits.length;
        try {
          const responses = await Promise.all(Array.from({ length: 32 }, async () => {
            const at = performance.now();
            const response = await fetch(`${base}/api/recipients`, { method: 'POST', headers: { 'content-type': 'application/json' },
              body: JSON.stringify(workload === 'area' ? areas[0].location : { lat: phasePoints[0].lat, lon: phasePoints[0].lon }),
              signal: AbortSignal.timeout(15000) });
            return { status: response.status, retryAfter: response.headers.get('retry-after'), body: await response.json(), milliseconds: performance.now() - at };
          }));
          result[name === 'mixed' ? 'overload' : 'areaOverload'] = { method: 'Hold all five pool clients, then issue 32 concurrent HTTP lookups. Release after responses.',
            seconds: (performance.now() - start) / 1000, responses, poolAcquisitions: waits.slice(waitStart) };
        } finally { held.forEach(client => client.release()); }
        const deadlineStart = performance.now();
        const deadlineKey = name === 'mixed' ? 'statementDeadline' : 'areaStatementDeadline';
        try { await pool.query('SELECT pg_sleep(11)'); result[deadlineKey] = { cancelled: false }; }
        catch (error) { result[deadlineKey] = { cancelled: error.code === '57014', code: error.code, milliseconds: performance.now() - deadlineStart }; }
      }
    }
    result.accepted = result.phases.every(phase => phase.computed === 1000 && phase.unchangedMeasurements &&
      phase.end.queued === 0 && phase.end.integrity_queued === 0 && phase.end.terminal_failures === 0 && phase.end.integrity_terminal_failures === 0 &&
      (!phase.http || phase.http.accepted) &&
      (phase.workload !== 'area' || phase.numericAreaContract)) &&
      [result.overload, result.areaOverload].every(overload =>
        overload.responses.some(row => row.status === 429 && row.retryAfter === '1') &&
        overload.responses.some(row => row.status === 503)) &&
      result.statementDeadline.cancelled && result.areaStatementDeadline.cancelled;
  } catch (error) {
    result.error = { name: error.name, message: error.message };
    throw error;
  } finally {
    await writeFile(output, JSON.stringify(result, null, 2) + '\n');
    process.emit('SIGTERM');
    await main;
  }
  if (!result.accepted) throw new Error('Mixed national benchmark acceptance failed; inspect evidence');
}

if (process.argv[2] === '--drive') {
  const config = process.argv[4] ? JSON.parse(process.argv[4])
    : await new Promise(resolve => {
      process.once('message', message => resolve(message.config));
      process.send({ needsConfig: true });
    });
  console.log(JSON.stringify(await drive(process.argv[3], config)));
  if (process.connected) process.disconnect();
} else if (process.argv[2] === '--fixture-areas') await fixtureAreas(process.argv[3], process.argv[4]);
else await benchmark(process.argv[2], process.argv[3]);
