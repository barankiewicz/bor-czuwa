import { postReport } from './helpers/reports.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { reportSchema, type Report, type FindingsResult } from '../src/lib/report.ts';

const base = process.env.TEST_BASE_URL ?? 'http://127.0.0.1:3001';
const points = JSON.parse(await readFile(new URL('../data/fixtures/acceptance.json', import.meta.url), 'utf8'));

async function submit(occurred_at: Report['occurred_at'], species: Report['species'], captured_at = '2026-09-24T10:00:00+02:00') {
  const token = randomBytes(32).toString('hex');
  const report: Report = {
    id: randomUUID(), event_type: 'shot', captured_at, occurred_at,
    device_fix: { ...points.edge.point, accuracy_m: 8, at: captured_at },
    incident_location: { ...points.edge.point, source: 'device_fix' },
    species, has_note: false, app_version: '0.1.0',
    privacy_policy_version: 'internal-fixture', terms_of_use_version: 'internal-fixture',
    token_sha256: createHash('sha256').update(token).digest('hex')
  };
  const response = await postReport(base, report);
  assert.equal(response.status, 201);
  for (let attempt = 0; attempt < 80; attempt++) {
    const result = await fetch(`${base}/api/reports/${report.id}/findings`, {
      headers: { authorization: `Bearer ${token}` }
    });
    assert.equal(result.status, 200);
    const findings = await result.json() as FindingsResult;
    if (findings.status !== 'pending') return findings;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('Findings did not complete');
}

test('Monday capture uses Saturday occurrence for Rule set and time Findings', async () => {
  const result = await submit({ at: '2026-03-14T23:30:00+01:00', source: 'entered_by_reporter', coarseness: 'exact' },
    'sarna', '2026-03-16T10:00:00+01:00');
  assert.equal(result.status, 'computed', JSON.stringify(result));
  if (result.status !== 'computed') return;
  assert.equal(result.rule_set_id, 'pl-2026-09-24-v2-protected-v1');
  assert.equal(result.noc?.status, 'computed');
  assert.equal(result.okres_ochronny?.status, 'in_closed_season');
});

test('earliest supported date is inclusive', async () => {
  const before = await submit({ at: '2018-03-31T12:00:00+02:00', source: 'entered_by_reporter', coarseness: 'exact' }, null);
  assert.deepEqual(before, { status: 'failed', reason: 'before_earliest_rule_set' });
  const first = await submit({ at: '2018-04-01T12:00:00+02:00', source: 'entered_by_reporter', coarseness: 'exact' }, null);
  assert.equal(first.status, 'computed', JSON.stringify(first));
  if (first.status === 'computed') {
    assert.equal(first.rule_set_id, 'pl-2018-04-01-v2-protected-v1');
    assert.equal(first.noc?.status, 'computed');
  }
});

test('historical dates select each effective Rule set', async () => {
  for (const [at, id] of [
    ['2019-03-01T12:00:00+01:00', 'pl-2019-03-01-protected-v1'],
    ['2021-07-23T12:00:00+02:00', 'pl-2021-07-23-protected-v1'],
    ['2022-04-01T12:00:00+02:00', 'pl-2022-04-01-protected-v1'],
    ['2022-07-02T12:00:00+02:00', 'pl-2022-07-02-protected-v1'],
    ['2022-11-16T12:00:00+01:00', 'pl-2022-11-16-protected-v1']
  ]) {
    const result = await submit({ at, source: 'entered_by_reporter', coarseness: 'exact' }, null);
    assert.equal(result.status, 'computed', JSON.stringify(result));
    if (result.status === 'computed') {
      assert.equal(result.rule_set_id, id);
      assert.equal(result.dwelling_distance.status, 'measured');
      assert.notEqual(result.dwelling_distance.value_m, null);
      if (result.dwelling_distance.value_m !== null)
        assert.ok(Math.abs(result.dwelling_distance.value_m - points.edge.expected_m) <= 0.5);
    }
  }
});

test('unlisted Species remains Report data for explicit Findings failure', async () => {
  const baseReport = {
    id: randomUUID(), event_type: 'shot', captured_at: '2026-09-24T10:00:00+02:00',
    occurred_at: { at: '2026-09-24T10:00:00+02:00', source: 'device_clock', coarseness: 'exact' },
    device_fix: { ...points.edge.point, accuracy_m: 8, at: '2026-09-24T10:00:00+02:00' },
    incident_location: { ...points.edge.point, source: 'device_fix' },
    species: 'unlisted-species', has_note: false, app_version: '0.1.0',
    privacy_policy_version: 'internal-fixture', terms_of_use_version: 'internal-fixture',
    token_sha256: 'a'.repeat(64)
  };
  assert.equal(reportSchema.safeParse(baseReport).success, true);
  assert.equal(reportSchema.safeParse({ ...baseReport, species: 'unknown' }).success, true);
  assert.equal(reportSchema.safeParse({ ...baseReport, species: 'slonka' }).success, true);
  assert.deepEqual(await submit(baseReport.occurred_at as Report['occurred_at'], 'unlisted-species'),
    { status: 'failed', reason: 'unknown_species' });
});

test('a species missing from an older Rule set leaves okres ochronny not computed', async () => {
  const { Client } = (await import('pg')).default;
  const { testDatabaseUrl } = await import('./helpers/test-database.ts');
  const token = randomBytes(32).toString('hex');
  const id = randomUUID();
  const at = '2026-03-14T23:30:00+01:00';
  const database = new Client({ connectionString: testDatabaseUrl() });
  await database.connect();
  try {
    // pl-2026-09-24 predates jenot's listing; the current Rule set lists it.
    await database.query(`INSERT INTO report (id, token_sha256, event_type, captured_at, occurred_at,
      occurred_source, occurred_coarseness, device_lat, device_lon, accuracy_m, device_fix_at,
      incident_lat, incident_lon, incident_source, has_note, species, app_version,
      privacy_policy_version, terms_of_use_version)
      VALUES ($1,$2,'shot',$3,$3,'device_clock','exact',$4,$5,8,$3,$4,$5,'device_fix',false,'jenot',
        '0.1.0','internal-fixture','internal-fixture')`,
    [id, createHash('sha256').update(token).digest('hex'), at, points.edge.point.lat, points.edge.point.lon]);
    await database.query(`INSERT INTO findings_job (report_id, rule_set_id) VALUES ($1, 'pl-2026-09-24')`, [id]);
  } finally { await database.end(); }
  let result: FindingsResult = { status: 'pending' };
  for (let attempt = 0; attempt < 80 && result.status === 'pending'; attempt++) {
    await new Promise(resolve => setTimeout(resolve, 100));
    result = await (await fetch(`${base}/api/reports/${id}/findings`, { headers: { authorization: `Bearer ${token}` } })).json();
  }
  assert.equal(result.status, 'computed', JSON.stringify(result));
  if (result.status !== 'computed') return;
  assert.equal(result.rule_set_id, 'pl-2026-09-24');
  assert.deepEqual(result.okres_ochronny, { status: 'not_computed', reason: 'species_not_in_rule_set' });
  assert.equal(result.noc?.status, 'computed');
  assert.equal(result.dwelling_distance.status, 'measured');
});
