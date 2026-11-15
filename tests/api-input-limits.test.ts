import { after, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { Client } from 'pg';
import { createApiServer } from '../server/api.ts';
import { pool } from '../server/db.ts';
import { homeArea } from '../src/lib/home-area.ts';
import type { FindingsResult, Report } from '../src/lib/report.ts';
import { reportAt, solve } from './helpers/reports.ts';
import { testDatabaseUrl } from './helpers/test-database.ts';

const liveBase = process.env.TEST_BASE_URL ?? 'http://127.0.0.1:3001';
const day = 86_400_000;
const nominatim: typeof fetch = async () => new Response(JSON.stringify([{ display_name: 'Białystok', lat: '53.13', lon: '23.17' }]));
const server = createApiServer(Date.now, nominatim);
server.listen(0, '127.0.0.1');
await once(server, 'listening');
const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
const ids: string[] = [];

beforeEach(async () => { await pool.query('DELETE FROM rate_counter'); });
after(async () => {
  server.close();
  await once(server, 'close');
  await pool.query('DELETE FROM rate_counter').catch(() => {});
  await pool.end();
});

function fresh(): Report {
  const report = reportAt();
  const at = new Date(Date.now() - day).toISOString();
  report.captured_at = at;
  report.occurred_at = { at, source: 'device_clock', coarseness: 'exact' };
  report.device_fix = { lat: 52, lon: 21, accuracy_m: 8, at };
  ids.push(report.id);
  return report;
}

async function post(report: unknown, to = base) {
  const challenge = await (await fetch(`${to}/api/challenge`)).json();
  return fetch(`${to}/api/reports`, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ...(report as object), solution: solve(challenge) }) });
}

const area = (bounds: [number, number, number, number], extra: Record<string, unknown> = {}) => ({
  type: 'area', bounds, basis: 'reporter_selected_area', precise_fix_withheld: null, ...extra });
// Side lengths in metres at 52 degrees north.
const boxMetres = (north: number, east: number): [number, number, number, number] =>
  [21, 52, 21 + east / (111_320 * Math.cos(52.05 * Math.PI / 180)), 52 + north / 111_320];
function areaReport(bounds: [number, number, number, number], extra: Record<string, unknown> = {}) {
  const report = fresh();
  return { ...report, device_fix: null, incident_location: area(bounds, extra) };
}

// Identity-shaped strings must not fit any version field; a short number is the residual risk (see the ticket).
test('version fields refuse names, canaries, phone numbers and e-mail', async () => {
  for (const field of ['app_version', 'privacy_policy_version', 'terms_of_use_version'] as const) {
    for (const bad of ['ZGLOS-CANARY-VER-7F3A', 'Jan_Kowalski', '+48600100200', '48600100200', 'alice@example.org',
      '600.100.2000', 'v', '1.2', 'a\u0000b', 'a'.repeat(81), '']) {
      const status = (await post({ ...fresh(), [field]: bad })).status;
      assert.equal(status, 400, `${field} ${JSON.stringify(bad)} gave ${status}`);
    }
  }
});

test('a NUL byte is a 400, not a 503 that counts as an outage', async () => {
  const before = (await (await fetch(`${base}/api/worker-status`)).json()).api_503_by_class;
  const response = await post({ ...fresh(), app_version: 'a\u0000b' });
  assert.equal(response.status, 400);
  assert.deepEqual((await (await fetch(`${base}/api/worker-status`)).json()).api_503_by_class, before);
});

test('every historic and future-shaped version value is accepted', async () => {
  for (const app of ['0.1.0', '0.1.1', '0.1.2', '0.1.3', '0.2.0', '12.0.101', 'internal-fixture']) {
    assert.equal((await post({ ...fresh(), app_version: app })).status, 201, `app ${app}`);
  }
  for (const policy of ['1', 'v1', 'v2', '12', 'internal-fixture', 'internal-workload', 'mixed-benchmark']) {
    const status = (await post({ ...fresh(), privacy_policy_version: policy, terms_of_use_version: policy })).status;
    assert.equal(status, 201, `policy ${policy}`);
  }
});

test('species keeps the shape of a Rule set key; canaries, names and addresses are refused', async () => {
  for (const bad of ['zglos-canary-species-7f3a', 'me-at-example-org@x', 'Jan Kowalski', 'jan_kowalski', 'dzik7', 'a-b-c-d-e',
    'a\u0000b', 'a'.repeat(81)]) {
    assert.equal((await post({ ...fresh(), species: bad })).status, 400, JSON.stringify(bad));
  }
  // Every real key, and a key-shaped one the Rule set lacks (the designed unknown_species outcome, api-time-species).
  for (const species of ['dzik', 'dziki-krolik', 'norka-amerykanska', 'unlisted-species', 'unknown', null]) {
    assert.equal((await post({ ...fresh(), species })).status, 201, String(species));
  }
});

async function reportWithToken() {
  const token = randomBytes(32).toString('hex');
  const report = { ...fresh(), token_sha256: createHash('sha256').update(token).digest('hex') };
  assert.equal((await post(report)).status, 201);
  return { id: report.id, token };
}

const policeUnit = 'e7ffa23f-0186-4570-bbe4-91203d78864b';
const event = (over: Record<string, unknown> = {}) => ({ id: randomUUID(), kind: 'notice_composed', recipient_kind: 'police',
  unit_id: policeUnit, template_version: 'placeholder-2026-09-25', directory_version: '2026-09-24',
  at: new Date().toISOString(), ...over });
const sendEvent = (id: string, token: string, body: unknown) => fetch(`${base}/api/reports/${id}/events`, {
  method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: JSON.stringify(body) });

test('Notice events take identity-free shapes, including a newer template, directory or unit', async () => {
  const { id, token } = await reportWithToken();
  for (const bad of [{ unit_id: 'someone-at-example-org' }, { unit_id: 'police' }, { unit_id: 'a\u0000b' }, { unit_id: '600100200' },
    { recipient_kind: 'gmina' }, { template_version: 'ZGLOS-CANARY-7F3A' }, { template_version: 'Jan Kowalski' },
    { directory_version: 'my-address-is-1' }, { directory_version: '2026-9-1' }, { directory_version: '2026-99-99' }, { directory_version: '2026-02-30' }, { template_version: '2026-13-01' }, { template_version: 'a\u0000b' }]) {
    const status = (await sendEvent(id, token, event(bad))).status;
    assert.equal(status, 400, JSON.stringify(bad));
  }
  const outcome = { id: randomUUID(), kind: 'outcome_reported', notice_id: randomUUID(), recipient_kind: 'police',
    unit_id: 'someone-at-example-org', outcome: 'reply', observed_on: '2026-09-25', at: new Date().toISOString() };
  assert.equal((await sendEvent(id, token, outcome)).status, 400);
  for (const good of [{}, { directory_version: '2026-09-26' }, { directory_version: '2027-03-01' }, { template_version: '2026-12-01' },
    { template_version: 'v2' }, { recipient_kind: 'gmina', unit_id: '1465011' }, { recipient_kind: 'psl', unit_id: '20' },
    { recipient_kind: 'nationalPark', unit_id: 'PL.ZIPOP.1393.PN.01' }, { unit_id: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee' },
    { template_version: 'internal-fixture', directory_version: 'internal-fixture' }]) {
    const status = (await sendEvent(id, token, event(good))).status;
    assert.equal(status, 201, JSON.stringify(good));
  }
});

test('the Withdrawal lock holds for an uppercase spelling of the id', async () => {
  // The tombstone names the Report's own token, so only that token's upload is stopped (ticket 48).
  const token = randomBytes(32).toString('hex');
  const report = { ...fresh(), token_sha256: createHash('sha256').update(token).digest('hex') };
  const upper = { ...report, id: report.id.toUpperCase() };
  const holder = new Client({ connectionString: testDatabaseUrl() });
  await holder.connect();
  try {
    await holder.query('BEGIN');
    await holder.query('SELECT pg_advisory_xact_lock(hashtextextended($1::text, 0))', [report.id]);
    let settled = false;
    const response = post(upper).then(value => { settled = true; return value; });
    // Wait until PostgreSQL shows a backend blocked on an advisory lock, instead of sleeping.
    let waiting = 0;
    for (let attempt = 0; attempt < 100 && !waiting; attempt++) {
      waiting = (await holder.query(`SELECT count(*)::int AS n FROM pg_locks WHERE locktype = 'advisory' AND NOT granted`)).rows[0].n;
      if (!waiting) await new Promise(resolve => setTimeout(resolve, 20));
    }
    assert.equal(waiting, 1, 'the uppercase POST did not wait for the lowercase lock');
    assert.equal(settled, false);
    await holder.query('SELECT public.withdraw_report($1, $2)', [report.id, token]);
    await holder.query('COMMIT');
    assert.equal((await response).status, 410);
    const rows = await holder.query('SELECT (SELECT count(*) FROM report WHERE id = $1)::int AS reports, (SELECT count(*) FROM report_withdrawal WHERE id = $1)::int AS tombstones', [report.id]);
    assert.deepEqual(rows.rows[0], { reports: 0, tombstones: 1 });
  } finally {
    await holder.query('ROLLBACK').catch(() => {});
    await holder.end();
  }
});

const postRoutes = {
  '/api/places': {},
  '/api/recipients': {},
  '/api/area-places': {},
  '/api/recipient-address-flags': {}
} as const;

test('every POST route refuses foreign origins and non-JSON bodies', async () => {
  for (const route of Object.keys(postRoutes)) {
    const send = (headers: Record<string, string>) => fetch(`${base}${route}`, { method: 'POST', headers, body: '{}' });
    assert.equal((await send({ 'content-type': 'application/json', origin: 'https://evil.example' })).status, 403, `${route} origin`);
    assert.equal((await send({ 'content-type': 'text/plain', origin: 'https://evil.example' })).status, 403, `${route} both`);
    assert.equal((await send({ 'content-type': 'text/plain' })).status, 415, `${route} content type`);
    // The app's own origin and the Android WebView still reach the route; an empty body is a plain 400.
    assert.equal((await send({ 'content-type': 'application/json', origin: base })).status, 400, `${route} site`);
    assert.equal((await send({ 'content-type': 'application/json', origin: 'https://localhost' })).status, 400, `${route} webview`);
  }
});

test('valid bodies still succeed on the four routes from the site and the Android WebView', async () => {
  const valid: Record<string, [unknown, number]> = {
    '/api/places': [{ query: 'Białystok' }, 200],
    '/api/recipients': [{ lat: 52, lon: 21 }, 200],
    '/api/area-places': [area(boxMetres(3000, 3000)), 200],
    '/api/recipient-address-flags': [{ kind: 'police', unit_id: policeUnit }, 201]
  };
  for (const [route, [body, expected]] of Object.entries(valid)) {
    for (const origin of [base, 'https://localhost']) {
      await pool.query('DELETE FROM rate_counter');
      const response = await fetch(`${base}${route}`, { method: 'POST',
        headers: { 'content-type': 'application/json', origin }, body: JSON.stringify(body) });
      assert.equal(response.status, expected, `${route} from ${origin}`);
    }
  }
});

test('areas, Accuracy and times beyond the limits are refused', async () => {
  for (const [name, report] of Object.entries({
    'area 100 km': areaReport([19, 51, 20.46, 51.9]),
    'area 10.1 km east-west': areaReport(boxMetres(1000, 10_100)),
    'area 10.1 km north-south': areaReport(boxMetres(10_100, 1000)),
    'accuracy 1e308': (() => { const r = fresh(); return { ...r, device_fix: { ...r.device_fix!, accuracy_m: 1e308 } }; })(),
    'accuracy 100001': (() => { const r = fresh(); return { ...r, device_fix: { ...r.device_fix!, accuracy_m: 100_001 } }; })(),
    'captured_at 9999': { ...fresh(), captured_at: '9999-01-01T00:00:00Z' },
    'captured_at 2019': { ...fresh(), captured_at: '2019-12-31T23:59:59Z' },
    'device_fix.at 9999': (() => { const r = fresh(); return { ...r, device_fix: { ...r.device_fix!, at: '9999-01-01T00:00:00Z' } }; })(),
    'occurred_at 9999': (() => { const r = fresh(); return { ...r, occurred_at: { ...r.occurred_at, at: '9999-01-01T00:00:00Z' } }; })(),
    'occurred_at in 8 days': (() => { const r = fresh(); return { ...r, occurred_at: { ...r.occurred_at, at: new Date(Date.now() + 8 * day).toISOString() } }; })(),
    'window_end in 8 days': (() => {
      const r = fresh();
      const at = new Date(Date.now() + 6.9 * day).toISOString();
      return { ...r, occurred_at: { at, source: 'entered_by_reporter', coarseness: 'within_hours', window_end: new Date(Date.parse(at) + day).toISOString() } };
    })()
  })) {
    const status = (await post(report)).status;
    assert.equal(status, 400, `${name} gave ${status}`);
  }
});

test('what an honest client sends stays accepted', async () => {
  const mid = homeArea({ lat: 52.2, lon: 21 }, 8);
  const south = homeArea({ lat: 49.2, lon: 19.9 }, 8);
  const r = fresh();
  for (const [name, report] of Object.entries({
    'area 6 km': areaReport(boxMetres(6000, 6000)),
    'home cell 8 km at 52N': { ...fresh(), device_fix: null, incident_location: mid },
    'home cell 8 km at 49N': { ...fresh(), device_fix: null, incident_location: south },
    'point radius 3 km (6.1 km box)': areaReport(boxMetres(6100, 6100)),
    'accuracy 50000': { ...r, device_fix: { ...r.device_fix!, accuracy_m: 50_000 } },
    'occurred_at in 1900 stays a designed outcome': (() => { const x = fresh(); return { ...x, occurred_at: { at: '1900-01-01T00:00:00Z', source: 'entered_by_reporter', coarseness: 'exact' } }; })(),
    'phone clock 6 days ahead': (() => { const x = fresh(); const at = new Date(Date.now() + 6 * day).toISOString();
      return { ...x, captured_at: at, occurred_at: { ...x.occurred_at, at }, device_fix: { ...x.device_fix!, at } }; })()
  })) {
    const response = await post(report);
    assert.equal(response.status, 201, `${name}: ${response.status}`);
  }
});

// Needs the live stack (worker), not the in-process server.
test('polar Reports end computed and do not raise terminal_failures', async () => {
  const status = async () => (await (await fetch(`${liveBase}/api/worker-status`)).json()) as { terminal_failures: number };
  assert.equal((await status()).terminal_failures, 0, 'terminal_failures before');
  const pending: { id: string; token: string; label: string }[] = [];
  const submit = async (label: string, shape: (report: Report) => unknown) => {
    const token = randomBytes(32).toString('hex');
    const report = fresh();
    report.token_sha256 = createHash('sha256').update(token).digest('hex');
    // Midsummer, so the sun does not set at 70 and 89 north.
    report.occurred_at = { at: '2026-06-21T12:00:00+02:00', source: 'entered_by_reporter', coarseness: 'exact' };
    report.device_fix = null;
    assert.equal((await post(shape(report), liveBase)).status, 201, label);
    pending.push({ id: report.id, token, label });
  };
  for (const lat of [70, 89, -70, 66.9]) {
    await submit(`point ${lat}`, report => ({ ...report, incident_location: { lat, lon: 21, source: 'moved_by_reporter' } }));
  }
  for (const lat of [70, 89]) {
    await submit(`area ${lat}`, report => ({ ...report,
      incident_location: area([21, lat - 0.02, 21.1, lat + 0.02]) }));
  }
  for (const { id, token, label } of pending) {
    let findings: FindingsResult = { status: 'pending' } as FindingsResult;
    for (let attempt = 0; attempt < 150 && findings.status === 'pending'; attempt++) {
      findings = await (await fetch(`${liveBase}/api/reports/${id}/findings`, { headers: { authorization: `Bearer ${token}` } })).json();
      if (findings.status === 'pending') await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert.equal(findings.status, 'computed', `${label}: ${JSON.stringify(findings)}`);
    if (findings.status === 'computed') assert.equal(findings.noc?.status, 'not_computed', label);
  }
  assert.equal((await status()).terminal_failures, 0, 'terminal_failures after');
});
