import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { once } from 'node:events';
import type { Server } from 'node:http';
import pg from 'pg';
import { z } from 'zod';
import { postReport } from './helpers/reports.ts';
import { protectedAreaBan } from '../src/lib/findings-reading.ts';
import type { Findings, IncidentArea, Report } from '../src/lib/report.ts';

// Each snapshot has its own schema in a fresh database. No runtime data, views, coverage,
// current snapshot, rate counters, or Reports in the caller's database are changed.
// Generate the inputs and expected values with scripts/measure-area-fixture.py first.
const kinds = ['park_narodowy', 'rezerwat', 'otulina', 'park_krajobrazowy', 'natura_2000_oso', 'natura_2000_soo'] as const;
const fixtureSchema = z.object({
  method: z.string(), threshold_m: z.number(), cases: z.record(z.string(), z.object({
    coverage_wkt: z.string(), dwellings_wkt: z.array(z.string()),
    obwody: z.array(z.object({ number: z.string(), source_year: z.number().int(), wkt: z.string() })),
    protected: z.array(z.object({ kind: z.enum(kinds), inspire_id: z.string(), wkt: z.string(),
      document_state: z.enum(['neither', 'plan_ochrony', 'zadania_ochronne', 'not_in_crfop_snapshot']).nullable() })),
    stands: z.array(z.object({ osm_id: z.string(), wkt: z.string() })),
    expected: z.object({
      bounds: z.tuple([z.number(), z.number(), z.number(), z.number()]), full_coverage: z.boolean(),
      dwelling: z.object({ min_m: z.number().nullable(), within_threshold_share: z.number().min(0).max(1),
        contains_dwelling: z.boolean(), class: z.enum(['beyond_threshold', 'partly_within_threshold', 'contains_dwelling']) }),
      obwody: z.array(z.object({ number: z.string(), source_year: z.number().int(), share: z.number().min(0).max(1) })),
      obwody_outside_share: z.number().min(0).max(1),
      protected: z.array(z.object({ kind: z.enum(kinds), inspire_id: z.string(),
        coverage: z.enum(['wholly_inside', 'partly_inside']), share: z.number().min(0).max(1), margin_m: z.number().optional() })),
      ambona: z.object({ osm_id: z.string(), edge_m: z.number() }),
      individual_dwelling_shares: z.array(z.number()).optional()
    })
  }))
});
const fixture = fixtureSchema.parse(JSON.parse(await readFile(new URL('../data/fixtures/area-synthetic.json', import.meta.url), 'utf8')));
type Basis = 'hearing' | 'sighting' | 'chosen' | 'home';
const databaseName = `area_geometry_${randomUUID().replaceAll('-', '')}`;
const databaseUrl = new URL(process.env.TEST_DATABASE_URL!);
const runtimeUrl = new URL(process.env.TEST_RUNTIME_DATABASE_URL ?? process.env.DATABASE_URL!);
assert.equal(runtimeUrl.username, 'app_runtime', 'run HTTP and worker under the real restricted runtime role');
assert.equal(databaseUrl.host, runtimeUrl.host, 'admin and runtime must use the same disposable PostGIS cluster');
const admin = new pg.Client({ connectionString: databaseUrl.href });
databaseUrl.pathname = `/${databaseName}`;
runtimeUrl.pathname = `/${databaseName}`;
let owner: pg.Client;
let server: Server;
let base: string;
let runtimePool: pg.Pool;
let runNextFindingsJob: () => Promise<boolean>;
let createApiServer: (now?: () => number) => Server;
let created = false;
const snapshots = new Map<string, string>();
const fullTime = new Map<Basis, { noc: Findings['noc']; okres_ochronny: Findings['okres_ochronny'] }>();

before(async () => {
  await admin.connect();
  await admin.query(`CREATE DATABASE ${databaseName}`);
  created = true;
  process.env.DATABASE_URL = runtimeUrl.href;
  // Static imports would bind db.ts to the caller's database before this isolated URL exists.
  const { migrateDatabase } = await import('../server/migrations.ts');
  await migrateDatabase(databaseUrl.href, decodeURIComponent(runtimeUrl.password), 'app_runtime');
  owner = new pg.Client({ connectionString: databaseUrl.href });
  await owner.connect();
  const datasets = ['BDOT10k BUBD', 'Bank Danych o Lasach', 'GDOS:ParkiNarodowe', 'GDOS:Rezerwaty',
    'GDOS:ParkiKrajobrazowe', 'GDOS:ObszarySpecjalnejOchrony', 'GDOS:SpecjalneObszaryOchrony', 'CRFOP',
    'PRG', 'OpenStreetMap hunting stands'].map(name => ({ name, source_url: 'https://example.invalid/isolated-geometry',
      retrieved_at: '2026-09-24T00:00:00Z', sha256: createHash('sha256').update(`${fixture.method}/${name}`).digest('hex'),
      disclaimer: 'Synthetic geometry acceptance only. Not field data.' }));
  for (const [name, spec] of Object.entries(fixture.cases)) {
    const snapshot = `isolated-area-${name}`;
    const schema = `geo_${createHash('sha256').update(snapshot).digest('hex').slice(0, 20)}`;
    snapshots.set(name, snapshot);
    await owner.query(`CREATE SCHEMA ${schema}`);
    // Reuse the migrated geodata table definitions, rather than inventing worker-shaped fake tables.
    for (const table of ['dwelling', 'obwod_lowiecki', 'protected_area']) {
      await owner.query(`CREATE TABLE ${schema}.${table} (LIKE public.${table} INCLUDING ALL)`);
    }
    // ambona is an ingestion table, not a migration placeholder; use its ingestion definition.
    await owner.query(`CREATE TABLE ${schema}.ambona (osm_id text PRIMARY KEY, geom geometry(Point,2180) NOT NULL)`);
    for (const [index, wkt] of spec.dwellings_wkt.entries()) {
      await owner.query(`INSERT INTO ${schema}.dwelling (lokalnyid, geom) VALUES ($1,ST_Multi(ST_GeomFromText($2,2180)))`, [String(index), wkt]);
    }
    for (const [index, district] of spec.obwody.entries()) {
      await owner.query(`INSERT INTO ${schema}.obwod_lowiecki (objectid, number, source_year, geom)
        VALUES ($1,$2,$3,ST_Multi(ST_GeomFromText($4,2180)))`, [index, district.number, district.source_year, district.wkt]);
    }
    for (const shape of spec.protected) {
      const documentKinds = shape.document_state === 'plan_ochrony' ? ['plan_ochrony']
        : shape.document_state === 'zadania_ochronne' ? ['zadania_ochronne'] : [];
      const documents = documentKinds.map(kind => ({ kind, url: `https://example.invalid/${shape.inspire_id}` }));
      await owner.query(`INSERT INTO ${schema}.protected_area (kind, inspire_id, name, parent_kind, document_state, documents, geom)
        VALUES ($1,$2,$2,$3,$4,$5,ST_Multi(ST_GeomFromText($6,2180)))`,
      [shape.kind, shape.inspire_id, shape.kind === 'otulina' ? 'park_narodowy' : null, shape.document_state, JSON.stringify(documents), shape.wkt]);
    }
    for (const stand of spec.stands) {
      await owner.query(`INSERT INTO ${schema}.ambona VALUES ($1,ST_GeomFromText($2,2180))`, [stand.osm_id, stand.wkt]);
    }
    await owner.query(`GRANT USAGE ON SCHEMA ${schema} TO app_runtime`);
    await owner.query(`GRANT SELECT ON ALL TABLES IN SCHEMA ${schema} TO app_runtime`);
    await owner.query(`INSERT INTO geodata_snapshot (id, created_at, datasets, coverage, storage_schema)
      VALUES ($1,'2026-09-24T00:00:00Z',$2,ST_Multi(ST_GeomFromText($3,2180)),$4)`,
    [snapshot, JSON.stringify(datasets), spec.coverage_wkt, schema]);
  }
  const { pool } = await import('../server/db.ts');
  runtimePool = pool;
  const role = (await pool.query('SELECT current_user AS name')).rows[0];
  assert.equal(role.name, 'app_runtime');
  ({ runNextFindingsJob } = await import('../server/findings.ts'));
  ({ createApiServer } = await import('../server/api.ts'));
});

after(async () => {
  try {
    if (runtimePool) await runtimePool.end();
    if (owner) await owner.end();
  } finally {
    if (created) await admin.query(`DROP DATABASE ${databaseName} WITH (FORCE)`);
    await admin.end();
  }
});

async function findingsFor(basis: Basis, name: string): Promise<Findings> {
  const expected = fixture.cases[name].expected;
  await owner.query(`INSERT INTO current_geodata (singleton, snapshot_id) VALUES (true,$1)
    ON CONFLICT (singleton) DO UPDATE SET snapshot_id=excluded.snapshot_id`, [snapshots.get(name)]);
  const token = randomBytes(32).toString('hex');
  const at = '2026-09-24T10:00:00+02:00';
  const incident: IncidentArea = basis === 'hearing' || basis === 'sighting'
    ? { type: 'area', bounds: expected.bounds, basis: basis === 'hearing' ? 'estimated_from_hearing' : 'estimated_from_sighting',
        precise_fix_withheld: null, hearing_bearing_deg: 70, hearing_distance_m: 300 }
    : { type: 'area', bounds: expected.bounds, basis: 'reporter_selected_area', precise_fix_withheld: basis === 'home' ? 'home_privacy' : null };
  const report: Report = { id: randomUUID(), token_sha256: createHash('sha256').update(token).digest('hex'),
    event_type: basis === 'sighting' ? 'person_with_gun' : 'shot', captured_at: at,
    occurred_at: { at, source: 'device_clock', coarseness: 'exact' }, device_fix: null, incident_location: incident,
    species: null, has_note: false, app_version: '0.1.0', privacy_policy_version: 'internal-fixture', terms_of_use_version: 'internal-fixture',
    ...(basis === 'sighting' ? { photo_sha256: [] } : {}) };
  const response = await postReport(base, report);
  assert.equal(response.status, 201, await response.clone().text());
  for (let attempt = 0; attempt < 100; attempt++) {
    await runNextFindingsJob();
    const response = await fetch(`${base}/api/reports/${report.id}/findings`, { headers: { authorization: `Bearer ${token}` } });
    assert.equal(response.status, 200);
    const result = await response.json();
    if (result.status !== 'pending') {
      assert.equal(result.status, 'computed', JSON.stringify(result));
      assert.equal(result.geodata_snapshot_id, snapshots.get(name));
      assert.equal(result.rule_set_id, 'pl-2026-09-24-v2-protected-v1');
      return result;
    }
  }
  throw new Error('Findings did not complete');
}

function near(actual: number, expected: number, tolerance: number, label: string) {
  assert.ok(Number.isFinite(actual) && Math.abs(actual - expected) <= tolerance, `${label}: ${actual} vs ${expected}`);
}
function fraction(value: number) {
  assert.ok(Number.isFinite(value) && value >= 0 && value <= 1, `unbounded fraction ${value}`);
}

// Each basis owns a serial fixed-clock API group and its independent rate salt.
// These fixture cohorts share only the dedicated database; no counter is reset and no case restarts an API.
for (const basis of ['hearing', 'sighting', 'chosen', 'home'] as const) {
  describe(`${basis} isolated API group`, { concurrency: false }, () => {
    before(async () => {
      server = createApiServer(() => Date.UTC(2026, 10, 8, 12));
      const listening = once(server, 'listening');
      server.listen(0, '127.0.0.1');
      await listening;
      const address = server.address();
      assert.ok(address && typeof address !== 'string');
      base = `http://127.0.0.1:${address.port}`;
    });
    after(async () => {
      const closed = once(server, 'close');
      server.close();
      await closed;
    });
  for (const [name, spec] of Object.entries(fixture.cases)) {
    if (name === 'same_district_overlap' && basis !== 'chosen') continue;
    test(`${basis}: independent synthetic ${name}`, async () => {
      const result = await findingsFor(basis, name);
      const expected = spec.expected;
      assert.equal(result.accuracy_m, null);
      assert.deepEqual(result.area_bounds, expected.bounds);
      if (!expected.full_coverage) {
        assert.deepEqual(result.dwelling_distance,
          { status: 'not_computed', value_m: null, search_radius_m: null, reason: 'outside_coverage' });
        for (const field of ['obwod_lowiecki', 'protected_areas', 'nearest_ambona'] as const) {
          assert.deepEqual(result[field], { status: 'not_computed', reason: 'outside_coverage' });
        }
        assert.deepEqual({ noc: result.noc, okres_ochronny: result.okres_ochronny }, fullTime.get(basis),
          'coverage changes no time Finding for the identical Incident bounds and time');
        return;
      }
      fullTime.set(basis, { noc: result.noc, okres_ochronny: result.okres_ochronny });
      const dwelling = result.dwelling_distance;
      assert.ok(dwelling.status === 'area_measured' || dwelling.status === 'area_none_within_radius');
      assert.equal(dwelling.basis, 'area');
      assert.equal(dwelling.class, expected.dwelling.class);
      assert.equal(dwelling.contains_dwelling, expected.dwelling.contains_dwelling);
      assert.equal(dwelling.threshold_m, fixture.threshold_m);
      assert.equal(dwelling.search_radius_m, 1000);
      assert.equal('max_m' in dwelling, false);
      assert.ok(dwelling.min_m !== null && expected.dwelling.min_m !== null);
      near(dwelling.min_m, expected.dwelling.min_m, 0.5, 'nearest footprint');
      near(dwelling.within_threshold_share, expected.dwelling.within_threshold_share, 1e-4, 'union threshold share');
      fraction(dwelling.within_threshold_share);
      if (name === 'touch_dwelling') {
        assert.equal(dwelling.min_m, 0);
        assert.equal(dwelling.contains_dwelling, false, 'mere boundary touch has no footprint interior inside');
      }
      if (name === 'threshold_equal') {
        near(dwelling.min_m, 150, 1e-7, 'threshold equality');
        assert.equal(dwelling.class, 'partly_within_threshold');
        near(dwelling.within_threshold_share, 0, 1e-10, 'threshold-only touch has zero positive area');
      }
      if (name === 'near_whole_threshold') assert.ok(dwelling.within_threshold_share > 0.99 && dwelling.within_threshold_share < 1);
      if (name === 'whole_threshold') assert.equal(dwelling.within_threshold_share, 1);
      if (name === 'overlapping_dwellings') {
        const shares = expected.individual_dwelling_shares!;
        assert.ok(dwelling.within_threshold_share > Math.max(...shares));
        assert.ok(dwelling.within_threshold_share < shares.reduce((sum, value) => sum + value, 0));
      }
      const districts = result.obwod_lowiecki;
      assert.equal(districts.status, 'area');
      assert.ok(districts.status === 'area');
      assert.deepEqual(districts.obwody.map(item => item.number), expected.obwody.map(item => item.number));
      assert.deepEqual(districts.obwody.map(item => `${item.number}/${item.source_year}`).sort(),
        expected.obwody.map(item => `${item.number}/${item.source_year}`).sort());
      for (const district of districts.obwody) {
        const independent = expected.obwody.find(item => item.number === district.number && item.source_year === district.source_year)!;
        fraction(district.share);
        near(district.share, independent.share, 1e-4, `obwod ${district.number}/${district.source_year}`);
        if (name === 'tiny_positive_overlaps') {
          assert.ok(district.share > 0 && district.share < 1e-6, 'a genuine positive overlap is never a cutoff sliver');
          near(district.share, independent.share, 1e-10, 'tiny obwod overlap');
        }
      }
      fraction(districts.outside_share);
      near(districts.outside_share, expected.obwody_outside_share, 1e-4, 'outside obwody');
      if (name === 'tiny_positive_overlaps') {
        assert.ok(districts.outside_share < 1);
        near(districts.outside_share, expected.obwody_outside_share, 1e-10, 'tiny overlap leaves less than the whole area outside');
      }
      if (name === 'mixed_year_partition') {
        assert.equal(districts.outside_share, 0);
        near(districts.obwody.reduce((sum, item) => sum + item.share, 0), 1, 1e-10, 'newest-at-each-location partitions the whole area once');
      }
      const protectedAreas = result.protected_areas;
      assert.ok(protectedAreas?.status === 'computed');
      const entries = kinds.flatMap(kind => protectedAreas[kind].map(entry => ({ kind, ...entry })));
      assert.deepEqual(entries.map(item => `${item.kind}/${item.inspire_id}`).sort(),
        expected.protected.map(item => `${item.kind}/${item.inspire_id}`).sort());
      for (const entry of entries) {
        const independent = expected.protected.find(item => item.kind === entry.kind && item.inspire_id === entry.inspire_id)!;
        assert.equal(entry.coverage, independent.coverage);
        assert.ok(entry.area_share !== undefined);
        fraction(entry.area_share);
        near(entry.area_share, independent.share, 1e-4, entry.inspire_id);
        if (name === 'tiny_positive_overlaps') {
          assert.ok(entry.area_share > 0 && entry.area_share < 1e-6);
          near(entry.area_share, independent.share, 1e-10, 'tiny protected overlap');
          assert.equal(entry.coverage, 'partly_inside');
        }
        const margin = independent.margin_m;
        if (margin !== undefined && (entry.kind === 'park_narodowy' || entry.kind === 'rezerwat')) {
          assert.ok(entry.boundary_distance);
          near(entry.boundary_distance.value_m, margin, 0.5, 'boundary margin');
          if (name === 'zero_protected_margin') assert.equal(entry.boundary_distance.value_m, 0);
        } else assert.equal(entry.boundary_distance, undefined);
        const documentState = spec.protected.find(shape => shape.kind === entry.kind && shape.inspire_id === entry.inspire_id)!.document_state;
        if (entry.kind === 'rezerwat') assert.equal(entry.document_state, documentState);
        const wanted = independent.coverage === 'wholly_inside' && margin !== undefined && margin > 0 &&
          (entry.kind === 'park_narodowy' || (entry.kind === 'rezerwat' && documentState === 'neither'));
        assert.equal(protectedAreaBan(entry.kind, entry, protectedAreas.rules, 'area', null), wanted);
        assert.equal('ban_asserted' in entry, false);
      }
      assert.ok(result.nearest_ambona?.status === 'mapped');
      assert.equal(result.nearest_ambona.measured_from, 'area_edge');
      assert.equal(result.nearest_ambona.osm_id, expected.ambona.osm_id);
      near(result.nearest_ambona.distance_m, expected.ambona.edge_m, 0.5, 'ambona edge');
    });
  }
  });
}


// A dense built-up area: thousands of small footprints within the threshold of one Incident area.
// The share query once buffered one MultiPolygon of every footprint in a single GEOS call, which took
// 17 s and 2.6 GiB for 5,500 footprints. It must finish inside the real 10 s statement deadline.
describe('dense dwelling cluster', { concurrency: false }, () => {
  const snapshot = 'isolated-area-dense-cluster';
  const schema = `geo_${createHash('sha256').update(snapshot).digest('hex').slice(0, 20)}`;
  const pitch = 12, size = 8, columns = 60, rows = 90;
  // Footprints cover x -150..(columns-1)*pitch-150+size and y -150..940, so every side of the
  // 800 m box has dwellings beyond it and the 150 m buffers meet in a straight edge at the last column.
  const lastColumnRight = (columns - 1) * pitch - 150 + size;
  const origin = { x: 500_000, y: 500_000 };
  let dense: Server;
  let denseBase: string;
  before(async () => {
    await owner.query(`CREATE SCHEMA ${schema}`);
    for (const table of ['dwelling', 'obwod_lowiecki', 'protected_area']) {
      await owner.query(`CREATE TABLE ${schema}.${table} (LIKE public.${table} INCLUDING ALL)`);
    }
    await owner.query(`CREATE TABLE ${schema}.ambona (osm_id text PRIMARY KEY, geom geometry(Point,2180) NOT NULL)`);
    // A 12-vertex footprint, closer to a mapped building than a square.
    await owner.query(`INSERT INTO ${schema}.dwelling (lokalnyid, geom)
      SELECT (c * ${rows} + r)::text, ST_Multi(ST_Buffer(ST_SetSRID(ST_MakePoint(
        ${origin.x} - 150 + c * ${pitch} + ${size / 2}, ${origin.y} - 150 + r * ${pitch} + ${size / 2}), 2180), ${size / 2}, 'quad_segs=3'))
      FROM generate_series(0, ${columns - 1}) c, generate_series(0, ${rows - 1}) r`);
    await owner.query(`GRANT USAGE ON SCHEMA ${schema} TO app_runtime`);
    await owner.query(`GRANT SELECT ON ALL TABLES IN SCHEMA ${schema} TO app_runtime`);
    await owner.query(`INSERT INTO geodata_snapshot (id, created_at, datasets, coverage, storage_schema)
      VALUES ($1,'2026-09-24T00:00:00Z',$2,ST_Multi(ST_Expand(ST_MakeEnvelope($3::float,$4::float,$3::float,$4::float,2180), 20000)),$5)`,
    [snapshot, JSON.stringify(['BDOT10k BUBD', 'Bank Danych o Lasach', 'GDOS:ParkiNarodowe', 'GDOS:Rezerwaty',
      'GDOS:ParkiKrajobrazowe', 'GDOS:ObszarySpecjalnejOchrony', 'GDOS:SpecjalneObszaryOchrony', 'CRFOP', 'PRG',
      'OpenStreetMap hunting stands'].map(name => ({ name, source_url: 'https://example.invalid/isolated-geometry',
      retrieved_at: '2026-09-24T00:00:00Z', sha256: createHash('sha256').update(`dense/${name}`).digest('hex'),
      disclaimer: 'Synthetic geometry acceptance only. Not field data.' }))), origin.x, origin.y, schema]);
    dense = createApiServer(() => Date.UTC(2026, 10, 8, 12));
    const listening = once(dense, 'listening');
    dense.listen(0, '127.0.0.1');
    await listening;
    const address = dense.address();
    assert.ok(address && typeof address !== 'string');
    denseBase = `http://127.0.0.1:${address.port}`;
  });
  after(async () => {
    const closed = once(dense, 'close');
    dense.close();
    await closed;
  });

  test('the within-threshold share finishes inside the statement deadline and matches the closed form', async () => {
    const { rows: [{ bounds }] } = await owner.query(`SELECT ARRAY[ST_XMin(b), ST_YMin(b), ST_XMax(b), ST_YMax(b)] AS bounds
      FROM (SELECT ST_Envelope(ST_Transform(ST_MakeEnvelope($1::float,$2::float,$1::float+800,$2::float+800,2180),4326)) AS b) q`, [origin.x, origin.y]);
    const { rows: [{ count }] } = await owner.query(`SELECT count(*)::int AS count FROM ${schema}.dwelling
      WHERE ST_DWithin(geom, ST_MakeEnvelope($1::float,$2::float,$1::float+800,$2::float+800,2180), 150)`, [origin.x, origin.y]);
    assert.ok(count >= 3000, `dense cluster has ${count} footprints within the threshold`);
    await owner.query(`INSERT INTO current_geodata (singleton, snapshot_id) VALUES (true,$1)
      ON CONFLICT (singleton) DO UPDATE SET snapshot_id=excluded.snapshot_id`, [snapshot]);
    const token = randomBytes(32).toString('hex');
    const at = '2026-09-24T10:00:00+02:00';
    const report: Report = { id: randomUUID(), token_sha256: createHash('sha256').update(token).digest('hex'),
      event_type: 'shot', captured_at: at, occurred_at: { at, source: 'device_clock', coarseness: 'exact' }, device_fix: null,
      incident_location: { type: 'area', bounds: bounds.map(Number) as [number, number, number, number],
        basis: 'reporter_selected_area', precise_fix_withheld: null },
      species: null, has_note: false, app_version: '0.1.0', privacy_policy_version: 'internal-fixture', terms_of_use_version: 'internal-fixture' };
    const response = await postReport(denseBase, report);
    assert.equal(response.status, 201, await response.clone().text());
    const started = performance.now();
    await runNextFindingsJob();
    const seconds = (performance.now() - started) / 1000;
    const result = await (await fetch(`${denseBase}/api/reports/${report.id}/findings`, { headers: { authorization: `Bearer ${token}` } })).json();
    assert.equal(result.status, 'computed', `${seconds.toFixed(1)} s: ${JSON.stringify(result)}`);
    assert.ok(seconds < 10, `Findings job took ${seconds.toFixed(1)} s`);
    // Closed form: dwellings reach 150 m beyond every side except the right, where the buffers meet in a
    // straight edge at the last column plus the threshold. Take that half-plane share of the area the worker reads.
    const { rows: [{ share }] } = await owner.query(`SELECT ST_Area(ST_Intersection(a,
        ST_MakeEnvelope($2 - 1e6, $3 - 1e6, $4, $3 + 1e6, 2180))) / ST_Area(a) AS share
      FROM (SELECT ST_Transform(ST_MakeEnvelope($1::float, $5::float, $6::float, $7::float, 4326), 2180) AS a) q`,
    [bounds[0], origin.x, origin.y, origin.x + lastColumnRight + 150, bounds[1], bounds[2], bounds[3]]);
    const dwelling = result.dwelling_distance;
    assert.equal(dwelling.status, 'area_measured');
    near(dwelling.within_threshold_share, Number(share), 1e-4, 'dense union threshold share');
    assert.equal(dwelling.contains_dwelling, true);
  });
});
