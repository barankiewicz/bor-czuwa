import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { setTimeout as sleep } from 'node:timers/promises';
import { Client } from 'pg';
import type { Report } from '../src/lib/report.ts';
import type { NoticeEvent, NoticeOutcome } from '../src/lib/notice-event.ts';
import { privacyPolicyVersion, termsOfUseVersion } from '../src/lib/legal/versions.ts';
import { postReport } from './helpers/reports.ts';
import { testDatabaseUrl } from './helpers/test-database.ts';
import { loseReports } from './helpers/server-loss.ts';

// The server side of recovering a Report that a restored database no longer holds:
// the phone's copy is the only source, and only what it sent can come back.
const base = process.env.TEST_BASE_URL ?? 'http://127.0.0.1:3001';
const points = JSON.parse(await readFile(new URL('../data/fixtures/acceptance.json', import.meta.url), 'utf8'));
const database = new Client({ connectionString: testDatabaseUrl() });
await database.connect();
const ids: string[] = [];
after(async () => {
  await lose(...ids);
  await database.end();
});

function report(): { report: Report; token: string } {
  const token = randomBytes(32).toString('hex');
  const at = '2026-10-05T10:00:00+02:00';
  const value: Report = {
    id: randomUUID(), event_type: 'person_with_gun', captured_at: at,
    occurred_at: { at, source: 'device_clock', coarseness: 'exact' },
    device_fix: { ...points.edge.point, accuracy_m: 8, at },
    incident_location: { ...points.edge.point, source: 'device_fix' },
    species: null, photo_sha256: [], has_note: false, app_version: '0.1.0',
    privacy_policy_version: privacyPolicyVersion, terms_of_use_version: termsOfUseVersion,
    token_sha256: createHash('sha256').update(token).digest('hex')
  };
  ids.push(value.id);
  return { report: value, token };
}

const lose = (...lost: string[]) => loseReports(database, lost);

const findings = (id: string, token: string) => fetch(`${base}/api/reports/${id}/findings`, { headers: { authorization: `Bearer ${token}` } });
const send = (id: string, token: string, body: NoticeEvent | NoticeOutcome) => fetch(`${base}/api/reports/${id}/events`, {
  method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: JSON.stringify(body)
});
const withdraw = (id: string, token: string) => fetch(`${base}/api/reports/${id}`, {
  method: 'DELETE', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }
});

async function computed(id: string, token: string) {
  for (let attempt = 0; attempt < 120; attempt++) {
    const body = await (await findings(id, token)).json() as { status: string };
    if (body.status !== 'pending') return body;
    await sleep(250);
  }
  throw new Error('Findings stayed pending');
}

function notice(): (NoticeEvent | NoticeOutcome)[] {
  const notice_id = randomUUID();
  const common = { notice_id, recipient_kind: 'police' as const, unit_id: 'e7ffa23f-0186-4570-bbe4-91203d78864b',
    template_version: 'placeholder-2026-09-25', directory_version: '2026-09-24', at: '2026-10-05T10:05:00+02:00' };
  return [
    { ...common, id: randomUUID(), kind: 'notice_composed' },
    { ...common, id: randomUUID(), kind: 'handed_to_mail_client' },
    { ...common, id: randomUUID(), kind: 'confirmed_by_reporter' },
    { id: randomUUID(), kind: 'outcome_reported', notice_id, recipient_kind: 'police', unit_id: common.unit_id,
      outcome: 'no_answer_yet', observed_on: '2026-10-05', at: '2026-10-05T10:06:00+02:00' }
  ];
}

async function history(id: string) {
  return (await database.query(`SELECT kind, event_id FROM report_event WHERE report_id = $1 ORDER BY id`, [id])).rows;
}

test('a lost measured Report reads as missing, then comes back under its ID and token with its Notice events once each', async () => {
  const { report: value, token } = report();
  assert.equal((await postReport(base, value)).status, 201);
  assert.equal((await computed(value.id, token)).status, 'computed');
  const events = notice();
  for (const item of events) assert.equal((await send(value.id, token, item)).status, 201);

  await lose(value.id);
  // The presence check the phone sends, and the event path, both report the loss.
  assert.equal((await findings(value.id, token)).status, 404);
  assert.equal((await send(value.id, token, events[0])).status, 404);

  assert.equal((await postReport(base, value)).status, 201);
  // An interrupted phone that uploads again before recording success is answered as a replay.
  assert.equal((await postReport(base, value)).status, 200);
  const stored = await database.query('SELECT token_sha256, device_lat, incident_lat FROM report WHERE id = $1', [value.id]);
  assert.equal(stored.rows[0].token_sha256, value.token_sha256);
  for (const item of events) assert.equal((await send(value.id, token, item)).status, 201);
  for (const item of events) assert.equal((await send(value.id, token, item)).status, 200);
  assert.deepEqual(await history(value.id), [
    { kind: 'created', event_id: null }, { kind: 'synced', event_id: null },
    ...events.map(item => ({ kind: item.kind, event_id: item.id }))
  ]);
  assert.equal((await computed(value.id, token)).status, 'computed');
  // Another token cannot read or extend the recovered Report.
  assert.equal((await findings(value.id, randomBytes(32).toString('hex'))).status, 404);
});

test('a confirmed Withdrawal survives losing the Report, so recovery is refused', async () => {
  const { report: value, token } = report();
  assert.equal((await postReport(base, value)).status, 201);
  assert.equal((await withdraw(value.id, token)).status, 204);
  await lose(value.id);
  assert.equal((await postReport(base, value)).status, 410);
  assert.equal((await database.query('SELECT 1 FROM report WHERE id = $1', [value.id])).rowCount, 0);
});

test('a Withdrawal of a Report the server already lost leaves it absent and refuses a later upload', async () => {
  const { report: value, token } = report();
  assert.equal((await postReport(base, value)).status, 201);
  await lose(value.id);
  assert.equal((await withdraw(value.id, token)).status, 204);
  assert.equal((await postReport(base, value)).status, 410);
  assert.equal((await database.query('SELECT 1 FROM report WHERE id = $1', [value.id])).rowCount, 0);
});
