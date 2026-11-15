import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { postReport } from './helpers/reports.ts';

const base = process.env.TEST_BASE_URL ?? 'http://127.0.0.1:3001';
const points = JSON.parse(await readFile(new URL('../data/fixtures/protected/acceptance.json', import.meta.url), 'utf8'));

async function capture(name: string, accuracy = 15, manual = false) {
  const token = randomBytes(32).toString('hex');
  const at = '2026-09-24T10:00:00+02:00';
  const id = randomUUID();
  const point = points[name].point;
  const response = await postReport(base, {
      id, event_type: 'shot', captured_at: at,
      occurred_at: { at, source: 'device_clock', coarseness: 'exact' },
      device_fix: manual ? null : { ...point, accuracy_m: accuracy, at },
      incident_location: { ...point, source: manual ? 'moved_by_reporter' : 'device_fix' },
      species: null, has_note: false, app_version: '0.1.0',
      privacy_policy_version: 'internal-fixture', terms_of_use_version: 'internal-fixture',
      token_sha256: createHash('sha256').update(token).digest('hex')
  });
  assert.equal(response.status, 201);
  for (let attempt = 0; attempt < 80; attempt++) {
    const response = await fetch(`${base}/api/reports/${id}/findings`, { headers: { authorization: `Bearer ${token}` } });
    assert.equal(response.status, 200);
    const result = await response.json();
    if (result.status !== 'pending') {
      assert.equal(result.status, 'computed');
      return result;
    }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('Findings did not complete');
}

test('park membership records independently measured boundary distances without a stored ban band', async () => {
  for (const name of ['park_margin', 'park_inside']) {
    const result = await capture(name);
    assert.equal(result.protected_areas.status, 'computed');
    assert.equal(result.rule_set_id, 'pl-2026-09-24-v2-protected-v1');
    assert.equal(result.protected_areas.rules.treatment.park_narodowy, 'ban');
    assert.equal(result.protected_areas.rules.treatment.rezerwat, 'ban_without_documents');
    assert.match(result.protected_areas.rules.citation, /Art\. 15 ust\. 1 pkt 4/);
    const [park] = result.protected_areas.park_narodowy;
    assert.equal(park.name, 'Testowy Park Narodowy');
    assert.equal(park.boundary_distance.status, 'measured');
    assert.ok(Math.abs(park.boundary_distance.value_m - points[name].boundary_m) < 0.01);
    assert.equal(park.boundary_distance.search_radius_m, null);
    assert.equal(result.accuracy_m, 15);
    assert.equal('ban_asserted' in park, false);
    assert.equal('band' in park, false);
    assert.equal(result.datasets.filter((dataset: { name: string }) => dataset.name.startsWith('GDOS:') || dataset.name === 'CRFOP').length, 6);
  }
});

test('reserve documents join by INSPIRE id, including duplicate names and absent records', async () => {
  for (const [name, id, state, kinds] of [
    ['reserve_neither', 'fixture.3', 'neither', []],
    ['reserve_tasks', 'fixture.4', 'zadania_ochronne', ['zadania_ochronne']],
    ['reserve_missing', 'fixture.5', 'not_in_crfop_snapshot', []],
    ['reserve_plan', 'fixture.6', 'plan_ochrony', ['plan_ochrony', 'zadania_ochronne']]
  ] as const) {
    const result = await capture(name);
    const [reserve] = result.protected_areas.rezerwat;
    assert.equal(reserve.inspire_id, id);
    assert.equal(reserve.document_state, state);
    assert.ok(Math.abs(reserve.boundary_distance.value_m - points[name].boundary_m) < 0.01);
    assert.deepEqual(reserve.documents.map((document: { kind: string }) => document.kind), kinds);
    for (const document of reserve.documents) assert.equal(new URL(document.url).searchParams.get('fop'), id);
  }
});

test('otulina, landscape parks and overlapping designated Natura areas are context only', async () => {
  const otulina = (await capture('otulina')).protected_areas;
  assert.deepEqual(otulina.park_narodowy, []);
  assert.equal(otulina.otulina[0].name, 'Testowy Park Narodowy');
  assert.equal(otulina.otulina[0].parent_kind, 'park_narodowy');
  const context = (await capture('context')).protected_areas;
  assert.deepEqual(context.park_narodowy, []);
  assert.deepEqual(context.rezerwat, []);
  assert.equal(context.park_krajobrazowy[0].name, 'Testowy Park Krajobrazowy');
  assert.equal(context.natura_2000_oso.length, 2);
  assert.equal(context.natura_2000_soo[0].name, 'Testowy obszar siedliskowy');
  const outside = (await capture('outside')).protected_areas;
  assert.ok(Object.entries(outside).filter(([key]) => key !== 'status' && key !== 'rules').every(([, value]) => Array.isArray(value) && value.length === 0));
});

test('hand-placed point inside a park has no Findings Accuracy', async () => {
  const result = await capture('park_inside', 15, true);
  assert.equal(result.accuracy_m, null);
  assert.equal(result.protected_areas.park_narodowy[0].name, 'Testowy Park Narodowy');
});
