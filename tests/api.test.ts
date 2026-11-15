import { postReport } from './helpers/reports.ts';
import { after, before, beforeEach, test } from 'node:test';
import { createApiServer } from '../server/api.ts';
import { pool } from '../server/db.ts';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import type { Report, FindingsResult } from '../src/lib/report.ts';
import { homeArea, outgoingArea } from '../src/lib/home-area.ts';
import { Client } from 'pg';
import { privacyPolicyVersion, termsOfUseVersion } from '../src/lib/legal/versions.ts';
import { testDatabaseUrl } from './helpers/test-database.ts';

const server = createApiServer();
let base: string;
before(async () => {
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
after(async () => {
  try { await new Promise<void>(resolve => server.close(() => resolve())); }
  finally { await pool.end(); }
});
const points = JSON.parse(await readFile(new URL('../data/fixtures/acceptance.json', import.meta.url), 'utf8'));
const areaCases = JSON.parse(await readFile(new URL('../data/fixtures/area-acceptance.json', import.meta.url), 'utf8')).cases;
const stands = JSON.parse(await readFile(new URL('../data/fixtures/osm/acceptance.json', import.meta.url), 'utf8'));

// Each case represents a fresh Reporter; shared fixture traffic must not consume their daily budget.
beforeEach(async () => {
  const client = new Client({ connectionString: testDatabaseUrl() });
  await client.connect();
  try { await client.query('DELETE FROM rate_counter'); }
  finally { await client.end(); }
});

test('Android local origin can reach API without opening CORS to other origins', async () => {
  const preflight = await fetch(`${base}/api/reports`, {
    method: 'OPTIONS', headers: { origin: 'https://localhost',
      'access-control-request-method': 'POST', 'access-control-request-headers': 'content-type' }
  });
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get('access-control-allow-origin'), 'https://localhost');
  assert.match(preflight.headers.get('access-control-allow-headers') ?? '', /content-type/);
  const foreign = await fetch(`${base}/api/reports`, {
    method: 'OPTIONS', headers: { origin: 'https://other.example', 'access-control-request-method': 'POST' }
  });
  assert.equal(foreign.headers.get('access-control-allow-origin'), null);
});

function capture(point: { lat: number; lon: number }, accuracy = 8) {
  const token = randomBytes(32).toString('hex');
  const at = '2026-09-24T10:00:00+02:00';
  const report: Report = {
    id: randomUUID(), event_type: 'shot', captured_at: at,
    occurred_at: { at, source: 'device_clock', coarseness: 'exact' },
    device_fix: { ...point, accuracy_m: accuracy, at },
    incident_location: { ...point, source: 'device_fix' },
    species: null, has_note: false, app_version: '0.1.0',
    privacy_policy_version: privacyPolicyVersion, terms_of_use_version: termsOfUseVersion,
    token_sha256: createHash('sha256').update(token).digest('hex')
  };
  return { report, token };
}

async function post(report: unknown) {
  return postReport(base, report);
}

async function findings(id: string, token: string) {
  for (let attempt = 0; attempt < 80; attempt++) {
    const response = await fetch(`${base}/api/reports/${id}/findings`, {
      headers: { authorization: `Bearer ${token}` }
    });
    assert.equal(response.status, 200);
    const result = await response.json() as FindingsResult;
    if (result.status !== 'pending') return result;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('Findings did not complete');
}

test('ordinary Report yields footprint distance and Accuracy, survives retry, and protects Findings', async () => {
  const { report, token } = capture(points.edge.point, 70);
  assert.equal((await post(report)).status, 201);
  const database = new Client({ connectionString: testDatabaseUrl() });
  await database.connect();
  try {
    const event = await database.query("SELECT details FROM report_event WHERE report_id = $1 AND kind = 'created'", [report.id]);
    assert.deepEqual(event.rows[0].details, {
      privacy_policy_version: privacyPolicyVersion,
      terms_of_use_version: termsOfUseVersion
    });
  } finally { await database.end(); }
  const result = await findings(report.id, token);
  assert.equal(result.status, 'computed');
  if (result.status !== 'computed') return;
  assert.equal(result.dwelling_distance.status, 'measured');
  assert.ok(result.dwelling_distance.status === 'measured');
  assert.ok(result.dwelling_distance.value_m !== null);
  assert.ok(Math.abs(result.dwelling_distance.value_m - points.edge.expected_m) <= 0.5,
    `Expected footprint distance ${points.edge.expected_m}, got ${result.dwelling_distance.value_m}`);
  assert.equal(result.dwelling_distance.search_radius_m, 1000);
  assert.equal(result.accuracy_m, 70);
  assert.equal(result.rule_set_id, 'pl-2026-09-24-v2-protected-v1');
  assert.equal(result.datasets.length, 10);
  assert.equal(new Set(result.datasets.map(dataset => dataset.name)).size, 10);
  assert.equal(result.datasets[0].name, 'BDOT10k BUBD');
  assert.match(result.datasets[0].sha256, /^[a-f0-9]{64}$/);
  const snapshot = new Client({ connectionString: testDatabaseUrl() });
  await snapshot.connect();
  try {
    const datasets = await snapshot.query('SELECT name, sha256 FROM geodata_dataset WHERE snapshot_id = $1',
      [result.geodata_snapshot_id]);
    assert.equal(datasets.rowCount, 10);
    assert.deepEqual(new Map(datasets.rows.map(row => [row.name, row.sha256])),
      new Map(result.datasets.map(dataset => [dataset.name, dataset.sha256])));
  } finally { await snapshot.end(); }
  assert.equal(result.obwod_lowiecki.status, 'inside');
  assert.ok(result.obwod_lowiecki.status === 'inside');
  if (result.obwod_lowiecki.status === 'inside') {
    assert.equal(result.obwod_lowiecki.name, 'Obwód łowiecki');
    assert.equal(result.obwod_lowiecki.number, '112');
    assert.equal(result.obwod_lowiecki.source_year, 2025);
  }
  assert.match(result.obwod_lowiecki.disclaimer, /charakter poglądowy/);
  assert.equal(result.obwod_lowiecki.source_name, 'Bank Danych o Lasach');
  assert.match(result.obwod_lowiecki.source_url, /bdl\.lasy\.gov\.pl/);
  assert.equal(result.nearest_ambona?.status, 'mapped');
  if (result.nearest_ambona?.status === 'mapped') {
    assert.equal(result.nearest_ambona.osm_id, stands.osm_id);
    assert.ok(Math.abs(result.nearest_ambona.distance_m - stands.expected_m) < 0.5);
  }
  assert.equal(result.geodata_snapshot_id, 'moniecki-2026-09-25-osm-v1');
  assert.equal(result.datasets.find(dataset => dataset.name === 'OpenStreetMap hunting stands')?.sha256.length, 64);
  const extract = await fetch(`${process.env.TEST_WEB_URL ?? 'http://127.0.0.1:3000'}/api/geodata/${result.geodata_snapshot_id}/ambony`);
  assert.equal(extract.status, 200);
  assert.match(extract.headers.get('content-type') ?? '', /geo\+json-seq/);
  assert.match(extract.headers.get('link') ?? '', /rel="license"/);
  assert.match(await extract.text(), /node\/10000000001/);
  assert.ok(result.obwod_lowiecki.retrieved_at);
  const retries = await Promise.all(Array.from({ length: 5 }, () => post(report)));
  assert.ok(retries.every(response => response.status === 200));
  assert.deepEqual(await findings(report.id, token), result);
  assert.equal((await post({ ...report, token_sha256: 'a'.repeat(64) })).status, 409);
  for (const invalidToken of ['', 'b'.repeat(64)]) {
    assert.equal((await fetch(`${base}/api/reports/${report.id}/findings`, {
      headers: { authorization: `Bearer ${invalidToken}` }
    })).status, 404);
  }
});

test('point outside every obwód is explicit context', async () => {
  const { report, token } = capture(points.obwod_outside.point);
  assert.equal((await post(report)).status, 201);
  const result = await findings(report.id, token);
  assert.equal(result.status, 'computed', JSON.stringify(result));
  if (result.status !== 'computed') return;
  assert.equal(result.obwod_lowiecki.status, 'outside');
  assert.ok(result.obwod_lowiecki.status === 'outside');
  assert.match(result.obwod_lowiecki.disclaimer, /charakter poglądowy/);
  assert.equal(result.obwod_lowiecki.source_name, 'Bank Danych o Lasach');
});

test('home areas accept rounded grid cells and refuse translated boxes of the same size', async () => {
  for (const size of [4, 8] as const) {
    const { report } = capture(points.barn.point);
    const area = homeArea(report.device_fix!, size);
    report.device_fix = null;
    report.incident_location = area;
    assert.equal((await post(report)).status, 201, `${size} km grid cell`);
    const translated = { ...report, id: randomUUID(), incident_location: {
      ...area, bounds: area.bounds.map(value => Number((value + 0.001).toFixed(6)))
    } };
    assert.equal((await post(translated)).status, 400, `${size} km translated box`);
  }
});

test('home area stores no device fix and produces no point-based claims', async () => {
  const { report, token } = capture(points.barn.point);
  const fix = report.device_fix!;
  report.device_fix = null;
  report.incident_location = homeArea(fix, 4);
  assert.equal((await post(report)).status, 201);
  const database = new Client({ connectionString: testDatabaseUrl() });
  await database.connect();
  try {
    const stored = await database.query('SELECT device_lat, device_lon, accuracy_m, device_fix_at, incident_lat, incident_lon, incident_bounds, area_basis, precise_fix_withheld FROM report WHERE id = $1', [report.id]);
    assert.equal(stored.rows[0].device_lat, null);
    assert.equal(stored.rows[0].device_lon, null);
    assert.equal(stored.rows[0].accuracy_m, null);
    assert.equal(stored.rows[0].device_fix_at, null);
    assert.deepEqual(stored.rows[0].incident_bounds, report.incident_location.bounds);
    assert.equal(stored.rows[0].incident_lat, (report.incident_location.bounds[1] + report.incident_location.bounds[3]) / 2);
    assert.equal(stored.rows[0].incident_lon, (report.incident_location.bounds[0] + report.incident_location.bounds[2]) / 2);
    assert.equal(stored.rows[0].area_basis, 'reporter_selected_area');
    assert.equal(stored.rows[0].precise_fix_withheld, 'home_privacy');
  } finally { await database.end(); }
  const result = await findings(report.id, token);
  assert.equal(result.status, 'computed', JSON.stringify(result));
  if (result.status !== 'computed') return;
  // The OGR fixture states whether coverage includes the entire genuine home cell.
  const expected = areaCases.home_cell_4km_ne;
  if (expected.full_coverage) {
    assert.ok(result.dwelling_distance.status === 'area_measured');
    assert.equal(result.dwelling_distance.class, expected.dwelling.class);
    assert.ok(result.obwod_lowiecki.status === 'area');
    assert.deepEqual(result.obwod_lowiecki.obwody.map(item => item.number), expected.obwody.map((item: { number: string }) => item.number));
  } else {
    assert.deepEqual(result.dwelling_distance,
      { status: 'not_computed', value_m: null, search_radius_m: null, reason: 'outside_coverage' });
    for (const field of ['obwod_lowiecki', 'protected_areas', 'nearest_ambona'] as const) {
      assert.deepEqual(result[field], { status: 'not_computed', reason: 'outside_coverage' });
    }
  }
  assert.equal(result.accuracy_m, null);
  assert.equal(result.noc?.status, 'computed');
  if (result.noc?.status === 'computed') {
    assert.equal(result.noc.spatial_basis, 'incident_area');
    assert.equal(result.noc.at_night, false, '10:00 in September is daytime throughout this area');
  }
  if (expected.full_coverage) {
    assert.ok(result.nearest_ambona?.status === 'mapped');
    assert.equal(result.nearest_ambona.osm_id, stands.area.osm_id);
    // From the cell's edge, not its centre (10762.8 m away).
    assert.ok(Math.abs(result.nearest_ambona.distance_m - expected.ambona.edge_m) < 0.5);
  }
});

test('heard estimate near a house and uncertain threshold store area without point measurement', async () => {
  const thresholdPoint = { lat: 53.43330564690765, lon: 22.799696160463718 };
  for (const point of [thresholdPoint, points.barn.point]) {
    if (point === thresholdPoint) {
      const baseline = capture(point, 12);
      assert.equal((await post(baseline.report)).status, 201);
      const pointFinding = await findings(baseline.report.id, baseline.token);
      assert.equal(pointFinding.status, 'computed');
      if (pointFinding.status === 'computed') {
        assert.equal(pointFinding.dwelling_distance.status, 'measured');
        if (pointFinding.dwelling_distance.status === 'measured') {
          assert.ok(pointFinding.dwelling_distance.value_m - pointFinding.accuracy_m! < 150);
          assert.ok(pointFinding.dwelling_distance.value_m + pointFinding.accuracy_m! > 150);
        }
      }
    }
    for (const fromHome of [false, true]) {
      const { report, token } = capture(point);
      const fix = report.device_fix!;
      report.device_fix = null;
      report.incident_location = outgoingArea({ eventType: 0, fix, fromHome, hearingBearing: 70, hearingDistanceM: 300 })!;
      assert.equal((await post(report)).status, 201);
      const database = new Client({ connectionString: testDatabaseUrl() });
      await database.connect();
      try {
        const { rows: [stored] } = await database.query(`SELECT device_lat, device_lon, accuracy_m,
          incident_bounds, area_basis, precise_fix_withheld, hearing_bearing_deg, hearing_distance_band, hearing_distance_m
          FROM report WHERE id = $1`, [report.id]);
        assert.equal(stored.device_lat, null);
        assert.equal(stored.device_lon, null);
        assert.equal(stored.accuracy_m, null);
        assert.deepEqual(stored.incident_bounds, report.incident_location.bounds);
        assert.equal(stored.area_basis, 'estimated_from_hearing');
        assert.equal(stored.hearing_distance_band, null);
        // From home the direction and distance stay on the phone.
        assert.equal(stored.precise_fix_withheld, fromHome ? 'home_privacy' : null);
        assert.equal(stored.hearing_bearing_deg, fromHome ? null : 70);
        assert.equal(stored.hearing_distance_m, fromHome ? null : 300);
      } finally { await database.end(); }
      const result = await findings(report.id, token);
      assert.equal(result.status, 'computed');
      if (result.status !== 'computed') continue;
      if (fromHome) {
        const bounds = report.incident_location.bounds;
        const expected = Object.values(areaCases).find((item: unknown) =>
          !!item && typeof item === 'object' && 'bounds' in item &&
          JSON.stringify(item.bounds) === JSON.stringify(bounds));
        assert.ok(expected && typeof expected === 'object' && 'full_coverage' in expected, 'home cell has an independent coverage expectation');
        if (!expected.full_coverage) {
          assert.deepEqual(result.dwelling_distance,
            { status: 'not_computed', value_m: null, search_radius_m: null, reason: 'outside_coverage' });
          for (const field of ['obwod_lowiecki', 'protected_areas', 'nearest_ambona'] as const) {
            assert.deepEqual(result[field], { status: 'not_computed', reason: 'outside_coverage' });
          }
        } else {
          assert.ok(result.dwelling_distance.status === 'area_measured');
          assert.equal(result.dwelling_distance.basis, 'area');
        }
      } else {
        assert.ok(result.dwelling_distance.status === 'area_measured');
        assert.equal(result.dwelling_distance.basis, 'area');
      }
      assert.equal(result.accuracy_m, null);
    }
  }
});


test('a heard estimate 5 km away is stored with its distance, and anything further is refused', async () => {
  const { report } = capture(points.barn.point);
  const fix = report.device_fix!;
  report.device_fix = null;
  report.incident_location = outgoingArea({ eventType: 0, fix, fromHome: false, hearingBearing: 90, hearingDistanceM: 5000 })!;
  assert.equal((await post(report)).status, 201);
  const database = new Client({ connectionString: testDatabaseUrl() });
  await database.connect();
  try {
    const { rows: [stored] } = await database.query('SELECT hearing_distance_m FROM report WHERE id = $1', [report.id]);
    assert.equal(stored.hearing_distance_m, 5000);
  } finally { await database.end(); }
  const further = capture(points.barn.point).report;
  further.device_fix = null;
  further.incident_location = { ...outgoingArea({ eventType: 0, fix, fromHome: false, hearingBearing: 90, hearingDistanceM: 5000 })!, hearing_distance_m: 5100 };
  assert.equal((await post(further)).status, 400);
});
test('an area drawn around a chosen point is accepted for any Event; a home area never carries the estimate', async () => {
  const { report } = capture(points.barn.point);
  const drawn = { ...report, event_type: 'person_with_gun', device_fix: null, photo_sha256: [],
    incident_location: outgoingArea({ eventType: 1, occurredMode: 'within_hours', fromHome: false,
      manualLat: String(points.barn.point.lat), manualLon: String(points.barn.point.lon), pointRadiusM: 300 })! };
  assert.equal((await post(drawn)).status, 201);
  const database = new Client({ connectionString: testDatabaseUrl() });
  await database.connect();
  try {
    const { rows: [stored] } = await database.query(`SELECT incident_source, area_basis, precise_fix_withheld, incident_bounds
      FROM report WHERE id = $1`, [drawn.id]);
    assert.deepEqual(stored, { incident_source: 'area', area_basis: 'reporter_selected_area', precise_fix_withheld: null,
      incident_bounds: drawn.incident_location.bounds });
  } finally { await database.end(); }
  const fix = report.device_fix!;
  const leaky = { ...capture(points.barn.point).report, device_fix: null,
    incident_location: { ...homeArea(fix, 4), basis: 'estimated_from_hearing', hearing_bearing_deg: 70, hearing_distance_m: 300 } };
  assert.equal((await post(leaky)).status, 400);
  const legacy = { ...capture(points.barn.point).report, device_fix: null,
    incident_location: { ...outgoingArea({ eventType: 0, fix, fromHome: false, hearingBearing: 70 })!, hearing_distance_band: 'under_500m' } };
  assert.equal((await post(legacy)).status, 201, 'a Report queued by an older build still syncs');
});

test('a seen Event placed by direction and distance stores its area, checked against PostGIS', async () => {
  const types = [['person_with_gun', 1], ['injured_animal', 3], ['poaching', 4]] as const;
  for (const [event_type, eventType] of types) {
    for (const fromHome of [false, true]) {
      const { report, token } = capture(points.barn.point);
      const fix = report.device_fix!;
      const seen = { ...report, event_type, photo_sha256: [], device_fix: null,
        incident_location: outgoingArea({ eventType, fix, fromHome, hearingBearing: 180, hearingDistanceM: 500 })! };
      assert.equal((await post(seen)).status, 201, `${event_type} from home: ${fromHome}`);
      const database = new Client({ connectionString: testDatabaseUrl() });
      await database.connect();
      try {
        // PostGIS measures the stored centre against the fix independently of the client's flat-earth offset.
        const { rows: [stored] } = await database.query(`SELECT area_basis, precise_fix_withheld, hearing_bearing_deg,
            hearing_distance_m, device_lat,
            ST_Distance(ST_Centroid(b)::geography, ST_SetSRID(ST_MakePoint($2, $3), 4326)::geography) AS centre_m,
            degrees(ST_Azimuth(ST_SetSRID(ST_MakePoint($2, $3), 4326)::geography, ST_Centroid(b)::geography)) AS azimuth,
            ST_Distance(ST_SetSRID(ST_MakePoint((incident_bounds->>0)::float8, (incident_bounds->>1)::float8), 4326)::geography,
              ST_SetSRID(ST_MakePoint((incident_bounds->>0)::float8, (incident_bounds->>3)::float8), 4326)::geography) AS height_m
          FROM report, LATERAL (SELECT ST_MakeEnvelope((incident_bounds->>0)::float8, (incident_bounds->>1)::float8,
            (incident_bounds->>2)::float8, (incident_bounds->>3)::float8, 4326) AS b) envelope
          WHERE id = $1`, [seen.id, fix.lon, fix.lat]);
        assert.equal(stored.area_basis, 'estimated_from_sighting');
        assert.equal(stored.device_lat, null);
        if (fromHome) {
          // The table refuses a home bearing as the transport schema does, whoever writes it.
          await assert.rejects(database.query('UPDATE report SET hearing_bearing_deg = 90 WHERE id = $1', [seen.id]),
            (error: Error & { code?: string }) => error.code === '23514');
          assert.equal(stored.precise_fix_withheld, 'home_privacy');
          assert.equal(stored.hearing_bearing_deg, null);
          assert.equal(stored.hearing_distance_m, null);
          // The fixed 4 km grid: about 4 km north to south whatever the estimate.
          assert.ok(Math.abs(stored.height_m - 4000) < 50, `${stored.height_m}`);
        } else {
          assert.equal(stored.precise_fix_withheld, null);
          assert.equal(stored.hearing_bearing_deg, 180);
          assert.equal(stored.hearing_distance_m, 500);
          assert.ok(Math.abs(stored.centre_m - 500) < 5, `${stored.centre_m}`);
          assert.ok(Math.abs(stored.azimuth - 180) < 0.5, `${stored.azimuth}`);
          // r = max(250 m, 250 m), so 500 m north to south.
          assert.ok(Math.abs(stored.height_m - 500) < 5, `${stored.height_m}`);
        }
      } finally { await database.end(); }
      const result = await findings(seen.id, token);
      assert.equal(result.status, 'computed');
      if (result.status === 'computed') {
        if (fromHome && !areaCases.home_cell_4km_ne.full_coverage) {
          assert.deepEqual(result.dwelling_distance,
            { status: 'not_computed', value_m: null, search_radius_m: null, reason: 'outside_coverage' });
        } else {
          assert.ok(result.dwelling_distance.status === 'area_measured');
          assert.equal(result.dwelling_distance.basis, 'area');
        }
      }
    }
  }
  const { report } = capture(points.barn.point);
  const sighting = outgoingArea({ eventType: 1, fix: report.device_fix!, fromHome: false, hearingBearing: 90, hearingDistanceM: 300 })!;
  assert.equal((await post({ ...report, device_fix: null, incident_location: sighting })).status, 400, 'a shot is heard, not seen');
  assert.equal((await post({ ...capture(points.barn.point).report, event_type: 'remains', photo_sha256: ['a'.repeat(64)],
    device_fix: null, incident_location: sighting })).status, 400, 'remains are never placed from afar');
});

test('a hand-placed point omits capture fix and has no GPS Accuracy', async () => {
  const { report, token } = capture(points.barn.point);
  report.device_fix = null;
  report.incident_location = {
    lat: points.barn.point.lat + 0.002, lon: points.barn.point.lon, source: 'moved_by_reporter'
  };
  assert.equal((await post(report)).status, 201);
  const database = new Client({ connectionString: testDatabaseUrl() });
  await database.connect();
  try {
    const stored = await database.query('SELECT device_lat, device_lon, accuracy_m, incident_source FROM report WHERE id = $1', [report.id]);
    assert.deepEqual(stored.rows[0], { device_lat: null, device_lon: null, accuracy_m: null, incident_source: 'moved_by_reporter' });
  } finally { await database.end(); }
  const result = await findings(report.id, token);
  assert.equal(result.status, 'computed');
  if (result.status === 'computed') assert.equal(result.accuracy_m, null);
});

test('a barn is excluded and no dwelling within 1000 m is an explicit measurement state', async () => {
  for (const name of ['barn', 'empty']) {
    const { report, token } = capture(points[name].point);
    assert.equal((await post(report)).status, 201);
    const result = await findings(report.id, token);
    assert.equal(result.status, 'computed');
    if (result.status !== 'computed') continue;
    if (name === 'empty') {
      assert.deepEqual(result.dwelling_distance, { status: 'none_within_radius', value_m: null, search_radius_m: 1000 });
    } else {
      assert.equal(result.dwelling_distance.status, 'measured');
      assert.ok(result.dwelling_distance.status === 'measured');
      assert.ok(result.dwelling_distance.value_m !== null);
      assert.ok(Math.abs(result.dwelling_distance.value_m - points.barn.expected_m) <= 0.5);
    }
  }
});

test('transport refuses private, unexpected and malformed fields before storage', async () => {
  const { report } = capture(points.edge.point);
  for (const extra of [
    { name: 'Private Reporter' }, { note: 'Private note' }, { device_id: 'device' },
    { photo_sha256: [] }, { token: 'secret' }, { contact: 'private@example.org' },
    { device_fix: { ...report.device_fix, device_model: 'private' } },
    { device_fix: { ...report.device_fix, accuracy_m: -1 } },
    { incident_location: { ...report.incident_location, lat: 91 } },
    { captured_at: 'yesterday' }, { event_type: 'unknown' },
    { event_type: 'remains' }
  ]) {
    assert.equal((await post({ ...report, ...extra })).status, 400);
  }
  const { incident_location: _location, ...missingLocation } = report;
  assert.equal((await post(missingLocation)).status, 400);
  assert.equal((await post(report)).status, 201);
});

test('photo cardinality and note flag are enforced at the API boundary', async () => {
  const hash = 'a'.repeat(64);
  const { report: shot } = capture(points.edge.point);
  assert.equal((await post({ ...shot, photo_sha256: [hash] })).status, 400);

  const { report: remains } = capture(points.edge.point);
  remains.event_type = 'remains';
  assert.equal((await post(remains)).status, 400);
  assert.equal((await post({ ...remains, photo_sha256: [] })).status, 400);
  assert.equal((await post({ ...remains, photo_sha256: [hash, hash, hash, hash] })).status, 400);
  assert.equal((await post({ ...remains, photo_sha256: [hash], note: 'private' })).status, 400);
  assert.equal((await post({ ...remains, photo_sha256: [hash], has_note: true })).status, 201);
  const { report: injured } = capture(points.edge.point);
  injured.event_type = 'injured_animal';
  assert.equal((await post(injured)).status, 400);
  assert.equal((await post({ ...injured, photo_sha256: [] })).status, 201);

  const database = new Client({ connectionString: testDatabaseUrl() });
  await database.connect();
  try {
    const stored = await database.query('SELECT photo_sha256, has_note FROM report WHERE id = $1', [remains.id]);
    assert.deepEqual(stored.rows[0], { photo_sha256: [hash], has_note: true });
  } finally { await database.end(); }
});

test('unsupported date fails explicitly without refusing the Report', async () => {
  const { report, token } = capture(points.edge.point);
  report.occurred_at.at = '2018-03-31T12:00:00Z';
  assert.equal((await post(report)).status, 201);
  assert.deepEqual(await findings(report.id, token), { status: 'failed', reason: 'before_earliest_rule_set' });
});

// The fixture's coverage ends at lon 22.644-22.653; west of it stands in for the sea or a state border.
const night = '2026-03-14T23:30:00+01:00';

test('a border point outside geodata coverage keeps noc and okres ochronny', async () => {
  const { report, token } = capture({ lat: 53.42, lon: 22.63 });
  report.occurred_at.at = night;
  report.species = 'sarna';
  assert.equal((await post(report)).status, 201);
  const result = await findings(report.id, token);
  assert.equal(result.status, 'computed', JSON.stringify(result));
  if (result.status !== 'computed') return;
  assert.equal(result.noc?.status, 'computed');
  if (result.noc?.status === 'computed') assert.equal(result.noc.at_night, true);
  assert.equal(result.okres_ochronny?.status, 'in_closed_season');
  assert.deepEqual(result.dwelling_distance, { status: 'not_computed', value_m: null, search_radius_m: null, reason: 'outside_coverage' });
  assert.deepEqual(result.obwod_lowiecki, { status: 'not_computed', reason: 'outside_coverage' });
  assert.deepEqual(result.protected_areas, { status: 'not_computed', reason: 'outside_coverage' });
  assert.deepEqual(result.nearest_ambona, { status: 'not_computed', reason: 'outside_coverage' });
});

test('a coastal area that reaches past geodata coverage keeps noc and okres ochronny', async () => {
  const { report, token } = capture(points.edge.point);
  report.occurred_at.at = night;
  report.species = 'sarna';
  report.device_fix = null;
  report.incident_location = { type: 'area', bounds: [22.635, 53.42, 22.66, 53.435],
    basis: 'reporter_selected_area', precise_fix_withheld: null };
  assert.equal((await post(report)).status, 201);
  const result = await findings(report.id, token);
  assert.equal(result.status, 'computed', JSON.stringify(result));
  if (result.status !== 'computed') return;
  assert.equal(result.okres_ochronny?.status, 'in_closed_season');
  assert.equal(result.noc?.status, 'computed');
  if (result.noc?.status === 'computed') {
    assert.equal(result.noc.at_night, true);
    assert.equal(result.noc.spatial_basis, 'incident_area');
    assert.equal('sunrise' in result.noc, false);
    assert.equal('sunset' in result.noc, false);
  }
  assert.deepEqual(result.dwelling_distance,
    { status: 'not_computed', value_m: null, search_radius_m: null, reason: 'outside_coverage' });
  for (const field of ['obwod_lowiecki', 'protected_areas', 'nearest_ambona'] as const) {
    assert.deepEqual(result[field], { status: 'not_computed', reason: 'outside_coverage' });
  }
});
