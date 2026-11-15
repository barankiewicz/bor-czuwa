import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const base = process.env.TEST_BASE_URL ?? 'http://127.0.0.1:3001';
const points = JSON.parse(await readFile(new URL('../data/fixtures/acceptance.json', import.meta.url), 'utf8'));
const jurisdictionAreas = JSON.parse(await readFile(new URL('../data/fixtures/recipients/jurisdiction-areas.json', import.meta.url), 'utf8'));

async function recipients(point: unknown) {
  return fetch(`${base}/api/recipients`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(point)
  });
}

test('recipient lookup refuses malformed points and areas before querying jurisdiction', async () => {
  for (const point of [
    { lat: 91, lon: 22 }, { lat: 53, lon: 181 }, { lat: '53', lon: 22 },
    { lat: 53, lon: 22, name: 'private' }, { lat: 53 }, null,
    { type: 'area', bounds: [22, 53, 22.05, 53.04] },
    { type: 'area', bounds: [22, 53, 23, 54], basis: 'reporter_selected_area', precise_fix_withheld: null },
    { type: 'area', bounds: [22, 53, 22.05, 53.04], basis: 'reporter_selected_area',
      precise_fix_withheld: null, private_fix: { lat: 53, lon: 22 } }
  ]) {
    const response = await recipients(point);
    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), { error: 'invalid_point' });
  }
});

test('fixture point resolves police, PSŁ, gmina and place names', async () => {
  const response = await recipients(points.edge.point);
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.deepEqual(result.units, [
    { kind: 'gmina', id: '2008063' },
    { kind: 'police', id: 'c753fb0c-78e2-419d-ad48-d7bf3b5218ac' },
    { kind: 'psl', id: '20' }
  ]);
  assert.deepEqual(result.inside, { nationalPark: false, reserve: false });
  assert.deepEqual(result.places, { gmina: 'Mońki', powiat: 'powiat moniecki', nadlesnictwo: 'NADLEŚNICTWO KNYSZYN' });
  assert.deepEqual(result.ambiguity, { ambiguous: false, roles: [], unresolved: [] });
  assert.equal(result.provenance.snapshot_id, 'moniecki-2026-09-25-osm-v1');
  assert.equal(result.provenance.directory_version, '2026-09-26');
  assert.ok(result.candidates.every((candidate: { catalog: string }) => candidate.catalog === 'matched'));
});

function area(bounds: number[]) {
  return { type: 'area', bounds, basis: 'reporter_selected_area', precise_fix_withheld: null };
}

test('area inside one gmina returns candidates with provenance', async () => {
  const fixture = jurisdictionAreas.insideOneGmina;
  const response = await recipients(area(fixture.bounds));
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.deepEqual(result.candidates.filter((candidate: { kind: string }) => candidate.kind === 'gmina')
    .map((candidate: { id: string }) => candidate.id), fixture.gminaIds);
  assert.deepEqual(result.ambiguity, { ambiguous: false, roles: [], unresolved: [] });
  assert.equal(result.provenance.snapshot_id, 'moniecki-2026-09-25-osm-v1');
  assert.equal('units' in result, false);
  assert.equal('places' in result, false);
});

test('area crossing gminy returns both as ambiguous candidates, without legacy selection', async () => {
  const fixture = jurisdictionAreas.crossingTwoGminy;
  const response = await recipients(area(fixture.bounds));
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.deepEqual(result.candidates.filter((candidate: { kind: string }) => candidate.kind === 'gmina')
    .map((candidate: { id: string }) => candidate.id).sort(), fixture.gminaIds);
  assert.equal(result.ambiguity.ambiguous, true);
  assert.ok(result.ambiguity.roles.includes('gmina'));
  assert.equal('units' in result, false);
});

test('area candidates use police and protected area geometry independently', async () => {
  const fixture = jurisdictionAreas.policeAndProtection;
  const response = await recipients(area(fixture.bounds));
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.ok(result.candidates.some((candidate: { kind: string; id: string }) =>
    candidate.kind === 'police' && candidate.id === fixture.policeId));
  assert.ok(result.candidates.some((candidate: { kind: string; id: string }) =>
    candidate.kind === 'nationalPark' && candidate.id === fixture.nationalParkId));
});

test('park and reserve fixture points add only their competent authorities', async () => {
  const cases = [
    [{ lat: 53.392923976390065, lon: 22.67554098989986 },
      { kind: 'nationalPark', id: 'PL.ZIPOP.1393.PN.22' }, { nationalPark: true, reserve: false }],
    [{ lat: 53.39152735641445, lon: 22.72057286020276 },
      { kind: 'rdos', id: '20' }, { nationalPark: false, reserve: true }]
  ] as const;
  for (const [point, unit, inside] of cases) {
    const response = await recipients(point);
    assert.equal(response.status, 200);
    const result = await response.json();
    assert.deepEqual(result.inside, inside);
    assert.ok(result.units.some((candidate: unknown) =>
      JSON.stringify(candidate) === JSON.stringify(unit)));
    assert.ok(result.units.some((candidate: { kind: string }) => candidate.kind === 'police'));
    assert.ok(result.units.some((candidate: { kind: string }) => candidate.kind === 'psl'));
  }
});

test('point outside every gmina returns unresolved roles instead of an outage', async () => {
  const response = await recipients({ lat: 52, lon: 13 });
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.deepEqual(result.candidates, []);
  assert.deepEqual(result.ambiguity, { ambiguous: false, roles: [], unresolved: ['gmina', 'police', 'psl'] });
  assert.equal(result.provenance.snapshot_id, 'moniecki-2026-09-25-osm-v1');
});

async function areaPlaces(value: unknown) {
  return fetch(`${base}/api/area-places`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(value)
  });
}

test('area preview names the gminy an outgoing area touches', async () => {
  const inside = await areaPlaces(area(jurisdictionAreas.insideOneGmina.bounds));
  assert.equal(inside.status, 200);
  assert.deepEqual(await inside.json(), { gminy: ['Trzcianne'] });
  const crossing = await areaPlaces(area(jurisdictionAreas.crossingTwoGminy.bounds));
  assert.equal(crossing.status, 200);
  assert.deepEqual((await crossing.json()).gminy.sort(), ['Jaświły', 'Mońki']);
  const outside = await areaPlaces(area([13, 52, 13.05, 52.035]));
  assert.deepEqual(await outside.json(), { gminy: [] });
});

test('area preview names the gminy of an area sized by the Reporter, down to a few hundred metres', async () => {
  const [west, south, east, north] = jurisdictionAreas.insideOneGmina.bounds;
  const middle = { lat: (south + north) / 2, lon: (west + east) / 2 };
  // 600 m a side, the smallest area a shot heard now can send.
  const small = area([middle.lon - 0.0045, middle.lat - 0.0027, middle.lon + 0.0045, middle.lat + 0.0027]);
  const response = await areaPlaces({ ...small, basis: 'estimated_from_hearing', hearing_bearing_deg: 90, hearing_distance_m: 300 });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { gminy: ['Trzcianne'] });
  const seen = await areaPlaces({ ...small, basis: 'estimated_from_sighting', hearing_bearing_deg: 90, hearing_distance_m: 300 });
  assert.equal(seen.status, 200);
  assert.deepEqual(await seen.json(), { gminy: ['Trzcianne'] });
  const tiny = await areaPlaces(area([middle.lon - 0.0005, middle.lat - 0.0005, middle.lon + 0.0005, middle.lat + 0.0005]));
  assert.equal(tiny.status, 400, 'under 150 m a side is not an area');
});

test('area preview accepts only an outgoing area, never a point or private fix', async () => {
  for (const value of [
    points.edge.point, { type: 'area', bounds: [22, 53, 22.05, 53.04] },
    area([22, 53, 23, 54]), { ...area([22, 53, 22.05, 53.04]), private_fix: { lat: 53, lon: 22 } }, null
  ]) {
    const response = await areaPlaces(value);
    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), { error: 'invalid_area' });
  }
});
