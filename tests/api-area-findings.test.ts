import { test, after, before } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createApiServer } from '../server/api.ts';
import { pool } from '../server/db.ts';
import { postReport } from './helpers/reports.ts';
import { protectedAreaBan } from '../src/lib/findings-reading.ts';
import type { Findings, IncidentArea, Report } from '../src/lib/report.ts';

// Expected values were measured with GDAL/OGR, never with the application's SQL; see
// scripts/measure-area-fixture.py and data/fixtures/README.md.
type Expected = {
  bounds: [number, number, number, number];
  full_coverage: boolean;
  dwelling: { min_m: number | null; within_threshold_share: number; contains_dwelling: boolean; class: string };
  obwody: { number: string; share: number }[];
  obwody_outside_share: number;
  protected: { kind: string; inspire_id: string; coverage: string; share: number; margin_m?: number }[];
  ambona: { osm_id: string; edge_m: number; centre_m: number; centre_nearest_osm_id: string };
};
const fixture = JSON.parse(await readFile(new URL('../data/fixtures/area-acceptance.json', import.meta.url), 'utf8')) as
  { threshold_m: number; cases: Record<string, Expected> };
const protectedDocs = new Map([['fixture.3', 'neither'], ['fixture.4', 'zadania_ochronne']]);

const server = createApiServer();
let base: string;
before(async () => {
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
after(async () => {
  try { await new Promise<void>(resolve => server.close(() => resolve())); } finally { await pool.end(); }
});

type Basis = 'hearing' | 'sighting' | 'chosen' | 'home';
function areaReport(basis: Basis, bounds: Expected['bounds']) {
  const token = randomBytes(32).toString('hex');
  const at = '2026-09-24T10:00:00+02:00';
  const location: IncidentArea = basis === 'hearing'
    ? { type: 'area', bounds, basis: 'estimated_from_hearing', precise_fix_withheld: null, hearing_bearing_deg: 70, hearing_distance_m: 300 }
    : basis === 'sighting'
      ? { type: 'area', bounds, basis: 'estimated_from_sighting', precise_fix_withheld: null, hearing_bearing_deg: 70, hearing_distance_m: 300 }
      : { type: 'area', bounds, basis: 'reporter_selected_area', precise_fix_withheld: basis === 'home' ? 'home_privacy' : null };
  const report: Report = {
    id: randomUUID(), event_type: basis === 'sighting' ? 'person_with_gun' : 'shot', captured_at: at,
    occurred_at: { at, source: 'device_clock', coarseness: 'exact' }, device_fix: null,
    incident_location: location, species: null, has_note: false, app_version: '0.1.0',
    privacy_policy_version: 'internal-fixture', terms_of_use_version: 'internal-fixture',
    token_sha256: createHash('sha256').update(token).digest('hex'),
    ...(basis === 'sighting' ? { photo_sha256: [] } : {})
  };
  return { report, token };
}

const results = new Map<string, Promise<Findings>>();
function findingsFor(basis: Basis, bounds: Expected['bounds']) {
  const key = JSON.stringify([basis, bounds]);
  if (!results.has(key)) results.set(key, computeFindings(basis, bounds));
  return results.get(key)!;
}

async function computeFindings(basis: Basis, bounds: Expected['bounds']): Promise<Findings> {
  const { report, token } = areaReport(basis, bounds);
  const response = await postReport(base, report);
  assert.equal(response.status, 201, await response.clone().text());
  for (let attempt = 0; attempt < 100; attempt++) {
    const read = await fetch(`${base}/api/reports/${report.id}/findings`, { headers: { authorization: `Bearer ${token}` } });
    assert.equal(read.status, 200);
    const result = await read.json();
    if (result.status !== 'pending') { assert.equal(result.status, 'computed', JSON.stringify(result)); return result; }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('Findings did not complete');
}

const near = (actual: number, expected: number, tolerance = 0.5, label = '') =>
  assert.ok(Math.abs(actual - expected) <= tolerance, `${label} ${actual} vs ${expected}`);
const fraction = (value: number) => assert.ok(Number.isFinite(value) && value >= 0 && value <= 1, `fraction ${value}`);

function assertOutsideCoverage(result: Findings) {
  assert.deepEqual(result.dwelling_distance,
    { status: 'not_computed', value_m: null, search_radius_m: null, reason: 'outside_coverage' });
  for (const field of ['obwod_lowiecki', 'protected_areas', 'nearest_ambona'] as const) {
    assert.deepEqual(result[field], { status: 'not_computed', reason: 'outside_coverage' });
  }
  assert.ok(result.noc?.status === 'computed');
  assert.equal(result.noc.spatial_basis, 'incident_area');
  assert.equal(result.okres_ochronny?.status, 'not_applicable_species_unset');
}

function assertMeasuredOverArea(result: Findings, expected: Expected) {
  assert.equal(result.rule_set_id, 'pl-2026-09-24-v2-protected-v1');
  assert.ok(result.geodata_snapshot_id, 'names its geodata snapshot');
  assert.equal(typeof expected.full_coverage, 'boolean', 'regenerate the independent OGR fixture');
  if (!expected.full_coverage) {
    assertOutsideCoverage(result);
    return [];
  }
  const dwelling = result.dwelling_distance;
  assert.ok(dwelling.status === 'area_measured' || dwelling.status === 'area_none_within_radius');
  assert.equal(dwelling.basis, 'area');
  assert.equal(dwelling.threshold_m, fixture.threshold_m);
  assert.equal(dwelling.search_radius_m, 1000);
  assert.equal(dwelling.class, expected.dwelling.class);
  assert.equal(dwelling.contains_dwelling, expected.dwelling.contains_dwelling);
  if (expected.dwelling.min_m === null) {
    assert.equal(dwelling.status, 'area_none_within_radius');
    assert.equal(dwelling.min_m, null);
  } else {
    assert.equal(dwelling.status, 'area_measured');
    assert.ok(dwelling.status === 'area_measured');
    near(dwelling.min_m, expected.dwelling.min_m, 0.5, 'min');
  }
  // Exact share of the area within the threshold of homes (OGR Buffer, Intersection, Area); 0 when beyond.
  near(dwelling.within_threshold_share, expected.dwelling.within_threshold_share, 1e-4, 'within_threshold_share');
  fraction(dwelling.within_threshold_share);
  assert.equal('max_m' in dwelling, false);
  const obwod = result.obwod_lowiecki;
  assert.equal(obwod.status, 'area');
  assert.ok(obwod.status === 'area');
  assert.deepEqual(obwod.obwody.map((item: { number: string }) => item.number), expected.obwody.map(item => item.number));
  for (const [index, item] of expected.obwody.entries()) {
    near(obwod.obwody[index].share, item.share, 1e-4, `obwod ${item.number}`);
    fraction(obwod.obwody[index].share);
    assert.equal(obwod.obwody[index].source_year, 2025);
  }
  near(obwod.outside_share, expected.obwody_outside_share, 1e-4, 'outside obwody');
  fraction(obwod.outside_share);
  assert.ok(obwod.disclaimer && obwod.source_url);
  const areas = result.protected_areas;
  assert.ok(areas?.status === 'computed');
  const kinds = ['park_narodowy', 'rezerwat', 'otulina', 'park_krajobrazowy', 'natura_2000_oso', 'natura_2000_soo'] as const;
  const entries = kinds.flatMap(kind => areas[kind].map(entry => ({ kind, ...entry })));
  const expectedEntries = expected.protected;
  const actualEntries = entries;
  assert.deepEqual(actualEntries.map(item => `${item.kind}/${item.inspire_id}/${item.coverage}`).sort(),
    expectedEntries.map(item => `${item.kind}/${item.inspire_id}/${item.coverage}`).sort());
  for (const item of expectedEntries) {
    const actual = actualEntries.find(entry => entry.inspire_id === item.inspire_id)!;
    assert.ok(actual.area_share !== undefined);
    near(actual.area_share, item.share, 1e-4, `share ${item.inspire_id}`);
    fraction(actual.area_share);
    // Only the two kinds that can carry a ban store a boundary distance, as for a point.
    if (item.margin_m !== undefined && ['park_narodowy', 'rezerwat'].includes(item.kind)) {
      assert.ok(actual.boundary_distance);
      near(actual.boundary_distance.value_m, item.margin_m, 0.5, `margin ${item.inspire_id}`);
    } else assert.equal(actual.boundary_distance, undefined, 'a partial overlap or context area has no margin');
  }
  const ambona = result.nearest_ambona;
  assert.ok(ambona?.status === 'mapped');
  assert.equal(ambona.measured_from, 'area_edge');
  assert.equal(ambona.osm_id, expected.ambona.osm_id);
  near(ambona.distance_m, expected.ambona.edge_m, 0.5, 'ambona from the edge');
  return actualEntries;
}

const placed = Object.entries(fixture.cases).filter(([name]) => !name.startsWith('home_'));
for (const basis of ['hearing', 'sighting', 'chosen'] as const) {
  for (const [name, expected] of placed) {
    test(`${basis} area: ${name} is measured over the whole area`, async () => {
      const result = await findingsFor(basis, expected.bounds);
      const entries = assertMeasuredOverArea(result, expected);
      // The ban follows the whole-area rule: wholly inside, positive margin, kind rule.
      const rules = result.protected_areas?.status === 'computed' ? result.protected_areas.rules : null;
      for (const entry of entries) {
        const ban = protectedAreaBan(entry.kind, entry, rules, 'area', null);
        const wanted = entry.coverage === 'wholly_inside' && (entry.boundary_distance?.value_m ?? 0) > 0 && (entry.kind === 'park_narodowy' ||
          (entry.kind === 'rezerwat' && protectedDocs.get(entry.inspire_id) === 'neither'));
        assert.equal(ban, wanted, `${name} ${entry.inspire_id}`);
      }
      assert.equal(result.accuracy_m, null);
      if (name === 'ambona_inside') {
        assert.ok(result.nearest_ambona?.status === 'mapped');
        assert.equal(result.nearest_ambona.distance_m, 0);
      }
    });
  }
}

for (const [name, expected] of Object.entries(fixture.cases).filter(([name]) => name.startsWith('home_'))) {
  test(`home cell: ${name} is measured over the whole cell`, async () => {
    const result = await findingsFor('home', expected.bounds);
    const entries = assertMeasuredOverArea(result, expected);
    // A grid cell is far larger than any fixture protected area, so none can hold it wholly.
    for (const entry of entries) {
      const rules = result.protected_areas?.status === 'computed' ? result.protected_areas.rules : null;
      assert.equal(protectedAreaBan(entry.kind, entry, rules, 'area', null), false);
    }
  });
}

test('the nearest ambona is measured from the area edge, never from its centre', async () => {
  const expected = fixture.cases.ambona_edge_near;
  for (const basis of ['hearing', 'chosen'] as const) {
    const result = await findingsFor(basis, expected.bounds);
    assert.ok(result.nearest_ambona?.status === 'mapped');
    near(result.nearest_ambona.distance_m, expected.ambona.edge_m, 0.5, 'edge');
    assert.ok(expected.ambona.centre_m - result.nearest_ambona.distance_m > 1000, 'the centre is 1.5 km farther than the edge');
    assert.ok(Math.abs(result.nearest_ambona.distance_m - expected.ambona.centre_m) > 1000);
  }
});

test('a ban is asserted for a wholly contained park and neither-document rezerwat, and not for a partial overlap', async () => {
  const park = await findingsFor('chosen', fixture.cases.protected_park_wholly.bounds);
  assert.ok(park.protected_areas?.status === 'computed');
  const [wholly] = park.protected_areas.park_narodowy;
  assert.equal(wholly.coverage, 'wholly_inside');
  assert.ok(wholly.boundary_distance && wholly.boundary_distance.value_m > 0);
  assert.equal(protectedAreaBan('park_narodowy', wholly, park.protected_areas.rules, 'area', null), true);
  const reserve = await findingsFor('chosen', fixture.cases.protected_rezerwat_neither_wholly.bounds);
  assert.ok(reserve.protected_areas?.status === 'computed');
  const [neither] = reserve.protected_areas.rezerwat;
  assert.equal(neither.document_state, 'neither');
  assert.equal(protectedAreaBan('rezerwat', neither, reserve.protected_areas.rules, 'area', null), true);
  const partial = await findingsFor('chosen', fixture.cases.protected_park_partly.bounds);
  assert.ok(partial.protected_areas?.status === 'computed');
  const [straddled] = partial.protected_areas.park_narodowy;
  assert.equal(straddled.coverage, 'partly_inside');
  assert.equal(protectedAreaBan('park_narodowy', straddled, partial.protected_areas.rules, 'area', null), false);
});

for (const basis of ['hearing', 'sighting', 'chosen', 'home'] as const) {
  test(`${basis}: incomplete coverage does not claim whole-area spatial measurements`, async () => {
    const expected = fixture.cases.home_cell_4km_with_park;
    assert.equal(expected.full_coverage, false, 'this genuine home grid cell crosses the fixture coverage edge');
    const result = await findingsFor(basis, expected.bounds);
    assertOutsideCoverage(result);
    assert.ok(result.rule_set_id && result.geodata_snapshot_id);
  });
}
