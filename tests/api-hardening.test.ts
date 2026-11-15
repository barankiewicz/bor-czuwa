import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { startClockedApi } from './helpers/clocked-api.ts';
import { createApiServer } from '../server/api.ts';
import { pool } from '../server/db.ts';
import { assertSchemaCompatible } from '../server/migrations.ts';
import { solve, reportAt as newReport, postReport } from './helpers/reports.ts';
import { removeFlood } from './helpers/flood-teardown.ts';

const ids: string[] = [];
function reportAt() {
  const report = newReport();
  ids.push(report.id);
  return report;
}

// Remove this test's queue flood so it cannot delay other API tests' Findings. The real workers may still be
// processing it, so the removal takes locks in the order they do (see removeFlood).
after(async () => {
  try { await removeFlood(pool, ids); } finally { await pool.end(); }
});

test('Report writes require a signed, unexpired, single-use proof and remain idempotent', async () => {
  await assertSchemaCompatible(pool);
  let now = Date.now();
  const server = createApiServer(() => now);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const post = (value: unknown) => fetch(`${base}/api/reports`, { method: 'POST',
    headers: { 'content-type': 'application/json' }, body: JSON.stringify(value) });
  try {
    const report = reportAt();
    assert.equal((await post(report)).status, 403);
    assert.equal((await post({ ...report, name: 'private' })).status, 400);
    const challenge = await (await fetch(`${base}/api/challenge`)).json();
    const solution = solve(challenge);
    assert.equal((await post({ ...report, solution: { ...solution, number: -1 } })).status, 403);
    assert.equal((await post({ ...report, solution: { ...solution, signature: '0'.repeat(64) } })).status, 403);
    assert.equal((await post({ ...report, solution })).status, 201);
    assert.equal((await post({ ...report, solution })).status, 200);
    assert.equal((await post({ ...report, solution, token_sha256: 'f'.repeat(64) })).status, 409);
    assert.equal((await post({ ...report, solution, id: randomUUID() })).status, 403);
    const expires = solve(await (await fetch(`${base}/api/challenge`)).json());
    now += 600_001;
    assert.equal((await post({ ...reportAt(), solution: expires })).status, 403);
    const future = reportAt();
    future.captured_at = new Date(now + 86400_000).toISOString();
    future.species = 'unlisted-species';
    assert.ok(future.device_fix && !('type' in future.incident_location));
    future.device_fix.lat = future.incident_location.lat = 40;
    assert.equal((await post({ ...future, solution: solve(await (await fetch(`${base}/api/challenge`)).json()) })).status, 201);
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

test('a failed Findings enqueue rolls back Report and events', async () => {
  const report = reportAt();
  const server = createApiServer();
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  await pool.query(`CREATE FUNCTION reject_findings_job_for_test() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF NEW.report_id = '${report.id}'::uuid THEN RAISE EXCEPTION 'test enqueue failure'; END IF;
      RETURN NEW;
    END $$`);
  await pool.query(`CREATE TRIGGER reject_findings_job_for_test BEFORE INSERT ON findings_job
    FOR EACH ROW EXECUTE FUNCTION reject_findings_job_for_test()`);
  try {
    assert.equal((await postReport(base, report)).status, 503);
    for (const [table, column] of [['report', 'id'], ['report_event', 'report_id'], ['findings_job', 'report_id']]) {
      assert.equal((await pool.query(`SELECT 1 FROM ${table} WHERE ${column} = $1`, [report.id])).rowCount, 0);
    }
  } finally {
    await pool.query('DROP TRIGGER reject_findings_job_for_test ON findings_job');
    await pool.query('DROP FUNCTION reject_findings_job_for_test()');
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

test('concurrent writes stop at 50, a replay pays its count, and Warsaw midnight rotates the salt', async () => {
  let now = Date.parse('2026-10-24T21:55:00Z');
  const server = await startClockedApi(now);
  const { base, database } = server;
  try {
    const first = newReport();
    assert.equal((await postReport(base, first)).status, 201);
    assert.equal((await postReport(base, first)).status, 200);
    const candidates = Array.from({ length: 50 }, () => newReport());
    const payloads = [];
    for (const report of candidates) {
      const challenge = await fetch(`${base}/api/challenge`);
      assert.equal(challenge.status, 200);
      payloads.push({ ...report, solution: solve(await challenge.json()) });
    }
    const responses = await Promise.all(payloads.map(payload => fetch(`${base}/api/reports`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload)
    })));
    // The first Report and its replay took two of the 50 (ticket 48: a replay pays its count).
    assert.equal(responses.filter(r => r.status === 201).length, 48);
    const refusedIndex = responses.findIndex(r => r.status === 429);
    const refused = responses[refusedIndex];
    assert.ok(refused);
    assert.equal(refused.headers.get('retry-after'), '300');
    const rejectedId = candidates[refusedIndex].id;
    for (const [table, column] of [['report', 'id'], ['report_event', 'report_id'], ['findings_job', 'report_id']]) {
      assert.equal((await database.query(`SELECT 1 FROM ${table} WHERE ${column} = $1`, [rejectedId])).rowCount, 0);
    }
    // With the budget spent, even a replay of a stored Report waits for the next day like a new one.
    assert.equal((await postReport(base, first)).status, 429);
    now = Date.parse('2026-10-24T22:00:00Z');
    await server.setTime(now);
    assert.equal((await postReport(base, newReport())).status, 201);
    // The DST fall-back day is 25 hours long in Warsaw.
    for (let i = 1; i < 50; i++) assert.equal((await postReport(base, newReport())).status, 201);
    const limited = await postReport(base, newReport());
    assert.equal(limited.status, 429);
    assert.equal(limited.headers.get('retry-after'), '90000');
    const nativeLimited = await fetch(`${base}/api/reports`, { method: 'POST',
      headers: { origin: 'https://localhost', 'content-type': 'application/json' },
      body: JSON.stringify({ ...newReport(), solution: solve(await (await fetch(`${base}/api/challenge`)).json()) }) });
    assert.equal(nativeLimited.status, 429);
    assert.equal(nativeLimited.headers.get('access-control-allow-origin'), 'https://localhost');
    assert.equal(nativeLimited.headers.get('access-control-expose-headers'), 'Retry-After');
    assert.equal(nativeLimited.headers.get('retry-after'), '90000');
    assert.equal(nativeLimited.headers.get('cache-control'), 'no-store');
    now = Date.parse('2026-10-25T22:30:00Z');
    await server.setTime(now);
    // Apply the background TTL sweep after 24.5 hours of a 25-hour Warsaw day.
    await database.query('DELETE FROM rate_counter WHERE expires_at <= $1', [new Date(now)]);
    const stillLimited = await postReport(base, newReport());
    assert.equal(stillLimited.status, 429);
    assert.equal(stillLimited.headers.get('retry-after'), '1800');
    now = Date.parse('2026-10-25T23:00:00Z');
    await server.setTime(now);
    assert.equal((await postReport(base, newReport())).status, 201);
  } finally {
    await server.close();
  }
});


test('Report mutations refuse form content types and foreign or spoofed Origins', async () => {
  const server = createApiServer();
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const id = randomUUID();
  const routes = [['POST', '/api/reports'], ['POST', `/api/reports/${id}/events`],
    ['DELETE', `/api/reports/${id}`]];
  try {
    for (const [method, path] of routes) {
      const request = (headers: Record<string, string>) => fetch(base + path, { method, headers });
      for (const contentType of ['text/plain', 'application/x-www-form-urlencoded', 'application/jsonp']) {
        assert.equal((await request({ 'content-type': contentType })).status, 415);
      }
      assert.equal((await request({})).status, 415);
      assert.equal((await request({ 'content-type': 'application/json', origin: 'https://foreign.example' })).status, 403);
      assert.equal((await request({ 'content-type': 'application/json', origin: 'null' })).status, 403);
      assert.equal((await request({ 'content-type': 'application/json', origin: 'https://foreign.example',
        'x-forwarded-host': 'foreign.example', 'x-forwarded-proto': 'https' })).status, 403);
      for (const origin of [base, 'https://localhost']) {
        const response = await request({ 'content-type': 'application/json; charset=utf-8', origin });
        assert.equal(response.status, method === 'DELETE' || path.endsWith('/events') ? 404 : 400);
        if (origin === 'https://localhost') assert.equal(response.headers.get('access-control-allow-origin'), origin);
      }
    }
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
});

test('IPv6 clients share one daily budget per /64, including compressed and embedded IPv4 forms', async () => {
  // Own database and API process: 50 Reports through the shared stack's rate_counter break whenever
  // another process clears it.
  const prior = process.env.TRUSTED_PROXY_IP;
  process.env.TRUSTED_PROXY_IP = '127.0.0.1';
  let isolated: Awaited<ReturnType<typeof startClockedApi>> | undefined;
  try {
    isolated = await startClockedApi(Date.now());
    const base = isolated.base;
    const post = async (address: string) => {
      const report = newReport();
      const solution = solve(await (await fetch(`${base}/api/challenge`)).json());
      return fetch(`${base}/api/reports`, { method: 'POST', headers: {
        'content-type': 'application/json', 'x-real-ip': address }, body: JSON.stringify({ ...report, solution }) });
    };
    for (let index = 0; index < 50; index++) {
      assert.equal((await post(index % 2 ? '2001:db8:0:1::192.0.2.1' : '2001:0db8:0000:0001::1')).status, 201);
    }
    assert.equal((await post('2001:db8:0:1:ffff:ffff:ffff:ffff')).status, 429);
    assert.equal((await post('2001:db8:0:2::1')).status, 201);
  } finally {
    try { await isolated?.close(); }
    finally {
      if (prior === undefined) delete process.env.TRUSTED_PROXY_IP;
      else process.env.TRUSTED_PROXY_IP = prior;
    }
  }
});

test('receive and synced times retain minutes while capture time retains seconds', async () => {
  const server = createApiServer();
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  try {
    const report = reportAt();
    report.captured_at = '2026-09-24T12:00:37.123Z';
    assert.equal((await postReport(base, report)).status, 201);
    const row = (await pool.query(`SELECT received_at, captured_at,
      (SELECT at FROM report_event WHERE report_id = report.id AND kind = 'synced') AS synced_at
      FROM report WHERE id = $1`, [report.id])).rows[0];
    assert.equal(row.received_at.getUTCSeconds(), 0);
    assert.equal(row.received_at.getUTCMilliseconds(), 0);
    assert.equal(row.synced_at.getUTCSeconds(), 0);
    assert.equal(row.synced_at.getUTCMilliseconds(), 0);
    assert.equal(row.captured_at.toISOString(), report.captured_at);
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
});


test('trusted proxy owns the site Origin and rejects client Origin forwarding', async () => {
  const prior = process.env.TRUSTED_PROXY_IP;
  process.env.TRUSTED_PROXY_IP = '127.0.0.1';
  const server = createApiServer();
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const headers = { 'content-type': 'application/json', 'x-forwarded-host': 'app.example:8443',
    'x-forwarded-proto': 'https' };
  try {
    assert.equal((await fetch(`${base}/api/reports`, { method: 'POST', headers: {
      ...headers, origin: 'https://app.example:8443' } })).status, 400);
    assert.equal((await fetch(`${base}/api/reports`, { method: 'POST', headers: {
      ...headers, origin: 'https://foreign.example' } })).status, 403);
    assert.equal((await fetch(`${base}/api/reports`, { method: 'POST', headers: {
      ...headers, 'x-forwarded-proto': 'javascript', origin: 'https://app.example:8443' } })).status, 403);
  } finally {
    if (prior === undefined) delete process.env.TRUSTED_PROXY_IP;
    else process.env.TRUSTED_PROXY_IP = prior;
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});
