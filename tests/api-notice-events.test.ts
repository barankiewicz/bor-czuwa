import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { Client, Pool } from 'pg';
import type { Report } from '../src/lib/report.ts';
import type { NoticeEvent, NoticeOutcome } from '../src/lib/notice-event.ts';
import { privacyPolicyVersion, termsOfUseVersion } from '../src/lib/legal/versions.ts';
import { postReport } from './helpers/reports.ts';
import { testDatabaseUrl } from './helpers/test-database.ts';
import { startClockedApi } from './helpers/clocked-api.ts';
import { computeIntegritySignals, queueIntegrityNeighbors } from '../server/integrity.ts';

const base = process.env.TEST_BASE_URL ?? 'http://127.0.0.1:3001';
const points = JSON.parse(await readFile(new URL('../data/fixtures/acceptance.json', import.meta.url), 'utf8'));

async function syncedReport(origin = base) {
  const token = randomBytes(32).toString('hex');
  const at = '2026-09-24T10:00:00+02:00';
  const report: Report = {
    id: randomUUID(), event_type: 'person_with_gun', captured_at: at,
    occurred_at: { at, source: 'device_clock', coarseness: 'exact' },
    device_fix: { ...points.edge.point, accuracy_m: 8, at },
    incident_location: { ...points.edge.point, source: 'device_fix' },
    species: null, photo_sha256: [], has_note: false, app_version: '0.1.0',
    privacy_policy_version: privacyPolicyVersion, terms_of_use_version: termsOfUseVersion,
    token_sha256: createHash('sha256').update(token).digest('hex')
  };
  const response = await postReport(origin, report);
  assert.equal(response.status, 201);
  // Only the shared stack runs live workers. A clocked API owns a database nothing drains.
  if (origin === base) await integrityRefreshDone(report.id);
  return { id: report.id, token };
}

// The new Report's own integrity_refresh row can still be queued when the call returns.
async function integrityRefreshDone(id: string) {
  const database = new Client({ connectionString: testDatabaseUrl() });
  await database.connect();
  try {
    for (let attempt = 0; attempt < 100; attempt++) {
      if (!(await database.query('SELECT 1 FROM integrity_refresh WHERE report_id = $1', [id])).rowCount) return;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    throw new Error('Integrity refresh did not finish');
  } finally { await database.end(); }
}

function event(kind: NoticeEvent['kind']): NoticeEvent {
  return { id: randomUUID(), kind, recipient_kind: 'police', unit_id: 'e7ffa23f-0186-4570-bbe4-91203d78864b',
    template_version: 'placeholder-2026-09-25', directory_version: '2026-09-24', at: '2026-09-24T10:05:00+02:00' };
}

async function send(id: string, token: string | undefined, body: unknown, origin = base) {
  return fetch(`${origin}/api/reports/${id}/events`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body)
  });
}

async function rows(id: string) {
  const database = new Client({ connectionString: testDatabaseUrl() });
  await database.connect();
  try {
    return (await database.query(`SELECT kind, event_id, at, details FROM report_event
      WHERE report_id = $1 AND kind IN ('notice_composed', 'handed_to_mail_client', 'confirmed_by_reporter', 'outcome_reported') ORDER BY id`, [id])).rows;
  } finally { await database.end(); }
}

async function blockedBy(database: Client, blocker: number, pid?: number, query?: RegExp) {
  for (let attempt = 0; attempt < 100; attempt++) {
    await database.query('SELECT pg_stat_clear_snapshot()');
    const result = await database.query(`WITH RECURSIVE waiting(pid) AS (
      SELECT $1::int UNION SELECT activity.pid FROM pg_stat_activity activity
        JOIN waiting ON waiting.pid = ANY(pg_blocking_pids(activity.pid))
        WHERE activity.datname = current_database())
      SELECT activity.pid, activity.query FROM waiting JOIN pg_stat_activity activity USING (pid)
        WHERE pid <> $1 AND ($2::int IS NULL OR pid = $2)`, [blocker, pid ?? null]);
    const found = result.rows.find(row => !query || query.test(row.query));
    if (found) return found as { pid: number; query: string };
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.fail('Expected the owned lock to block the actual database consumer');
}

test('events record the three Notice kinds with their versions, once per event id', async () => {
  const { id, token } = await syncedReport();
  const events = [event('notice_composed'), event('handed_to_mail_client'), event('confirmed_by_reporter')];
  for (const item of events) assert.equal((await send(id, token, item)).status, 201);
  assert.equal((await send(id, token, events[1])).status, 200);
  const stored = await rows(id);
  assert.deepEqual(stored.map(row => [row.kind, row.event_id]), events.map(item => [item.kind, item.id]));
  for (const row of stored) {
    assert.equal(new Date(row.at).toISOString(), '2026-09-24T08:05:00.000Z');
    assert.deepEqual(row.details, { recipient_kind: 'police', unit_id: 'e7ffa23f-0186-4570-bbe4-91203d78864b',
      template_version: 'placeholder-2026-09-25', directory_version: '2026-09-24' });
  }
});

test('events refuse a wrong, missing or foreign token without writing', async () => {
  const { id, token } = await syncedReport();
  const other = await syncedReport();
  for (const candidate of [randomBytes(32).toString('hex'), undefined, 'not-a-token', other.token]) {
    const response = await send(id, candidate, event('notice_composed'));
    assert.equal(response.status, 404);
  }
  assert.equal((await send(randomUUID(), token, event('notice_composed'))).status, 404);
  assert.deepEqual(await rows(id), []);
});

test('events refuse any other kind, identity fields and missing versions', async () => {
  const { id, token } = await syncedReport();
  const valid = event('handed_to_mail_client');
  const { directory_version: _, ...withoutDirectory } = valid;
  for (const body of [
    { ...valid, kind: 'sent' }, { ...valid, kind: 'delivered' }, { ...valid, name: 'Jan Kowalski' },
    { ...valid, address: 'ul. Leśna 1' }, withoutDirectory, { ...valid, recipient_kind: 'prosecutor' },
    { ...valid, at: 'yesterday' }, { ...valid, id: 'not-a-uuid' }, null
  ]) {
    const response = await send(id, token, body);
    assert.equal(response.status, 400, JSON.stringify(body));
    assert.deepEqual(await response.json(), { error: 'invalid_event' });
  }
  assert.deepEqual(await rows(id), []);
});

test('an event id already stored for another Report is a conflict', async () => {
  const first = await syncedReport();
  const second = await syncedReport();
  const shared = event('notice_composed');
  assert.equal((await send(first.id, first.token, shared)).status, 201);
  assert.equal((await send(second.id, second.token, shared)).status, 409);
  assert.deepEqual(await rows(second.id), []);
});

test('per-Notice outcomes and corrections append dated codes without identity', async () => {
  const { id, token } = await syncedReport();
  const firstNotice = randomUUID();
  const secondNotice = randomUUID();
  const baseOutcome: NoticeOutcome = {
    id: randomUUID(), kind: 'outcome_reported', notice_id: firstNotice,
    recipient_kind: 'police', unit_id: 'e7ffa23f-0186-4570-bbe4-91203d78864b',
    outcome: 'no_answer_yet', observed_on: '2026-09-24', at: '2026-09-24T10:05:00+02:00'
  };
  assert.equal((await send(id, token, baseOutcome)).status, 409);
  assert.equal((await send(id, token, { ...event('handed_to_mail_client'), notice_id: firstNotice })).status, 201);
  assert.equal((await send(id, token, baseOutcome)).status, 409);
  assert.equal((await send(id, token, { ...event('confirmed_by_reporter'), notice_id: firstNotice })).status, 201);
  const second = { ...baseOutcome, id: randomUUID(), notice_id: secondNotice,
    recipient_kind: 'psl', unit_id: '20', outcome: 'reply', observed_on: '2026-09-25' };
  assert.equal((await send(id, token, second)).status, 409);
  assert.equal((await send(id, token, { ...event('confirmed_by_reporter'), notice_id: secondNotice,
    recipient_kind: 'psl', unit_id: '20' })).status, 201);
  assert.equal((await send(id, token, { ...baseOutcome, id: randomUUID(), notice_id: randomUUID() })).status, 409);
  assert.equal((await send(id, token, { ...baseOutcome, id: randomUUID(), recipient_kind: 'psl', unit_id: '20' })).status, 409);
  const correction = { ...baseOutcome, id: randomUUID(), outcome: 'proceedings_opened',
    observed_on: '2026-09-26', at: '2026-09-26T12:00:00+02:00' };
  for (const item of [baseOutcome, second, correction]) assert.equal((await send(id, token, item)).status, 201);
  assert.equal((await send(id, token, correction)).status, 200);
  const stored = await rows(id);
  const outcomes = stored.filter(row => row.kind === 'outcome_reported');
  assert.equal(outcomes.length, 3);
  assert.deepEqual(outcomes.map(row => row.details), [baseOutcome, second, correction].map(item => ({
    notice_id: item.notice_id, recipient_kind: item.recipient_kind, unit_id: item.unit_id,
    outcome: item.outcome, observed_on: item.observed_on
  })));
  assert.deepEqual(outcomes.map(row => new Date(row.at).toISOString()),
    ['2026-09-24T08:05:00.000Z', '2026-09-24T08:05:00.000Z', '2026-09-26T10:00:00.000Z']);
  for (const body of [{ ...baseOutcome, id: randomUUID(), reply_body: 'private' },
    { ...baseOutcome, id: randomUUID(), signed_name: 'Jan' },
    { ...baseOutcome, id: randomUUID(), outcome: 'delivered' }]) {
    assert.equal((await send(id, token, body)).status, 400);
  }
  assert.equal((await send(id, randomBytes(32).toString('hex'), baseOutcome)).status, 404);
  assert.equal((await rows(id)).length, 6);
});

test('one token admits 128 fresh Notice events, preserves replay, and defers further writes', async () => {
  const { id, token } = await syncedReport();
  const accepted = Array.from({ length: 128 }, () => event('notice_composed'));
  for (const item of accepted) assert.equal((await send(id, token, item)).status, 201);
  const refused = await send(id, token, event('notice_composed'));
  assert.equal(refused.status, 409);
  assert.deepEqual(await refused.json(), { error: 'event_limit' });
  assert.equal((await send(id, token, accepted[0])).status, 200);
  assert.equal((await rows(id)).length, 128);
  const other = await syncedReport();
  assert.equal((await send(other.id, other.token, event('notice_composed'))).status, 201);
});

test('queued writes for one Report leave capacity for another Reporter', async context => {
  const first = await syncedReport();
  const second = await syncedReport();
  const database = new Client({ connectionString: testDatabaseUrl() });
  await database.connect();
  await database.query('BEGIN');
  await database.query('SELECT 1 FROM report WHERE id = $1 FOR UPDATE', [first.id]);
  try {
    const waiting = send(first.id, first.token, event('notice_composed'));
    await new Promise(resolve => setTimeout(resolve, 100));
    const duplicateQueue = await send(first.id, first.token, event('notice_composed'));
    assert.equal(duplicateQueue.status, 429);
    assert.equal(duplicateQueue.headers.get('retry-after'), '1');
    const independent = await send(second.id, second.token, event('notice_composed'));
    if (independent.status !== 201) {
      const diagnostics: Record<string, unknown> = { status: independent.status };
      try {
        const response = await fetch(`${base}/api/worker-status`, { signal: AbortSignal.timeout(1000) });
        if (response.ok) {
          const status = await response.json();
          diagnostics.worker = { api503ByClass: status.api_503_by_class,
            recoveryCount: status.recovery_count, databaseRecoveryCount: status.database_recovery_count };
        } else diagnostics.worker = { status: response.status };
      } catch { diagnostics.worker = 'diagnostic_unavailable'; }
      const observer = new Client({ connectionString: testDatabaseUrl(), connectionTimeoutMillis: 1000,
        query_timeout: 1000, statement_timeout: 1000 });
      try {
        await observer.connect();
        const activity = await observer.query(`SELECT pid, state, wait_event_type, wait_event,
          query_start, xact_start, pg_blocking_pids(pid) AS blockers, query
          FROM pg_stat_activity WHERE datname = current_database() AND pid <> pg_backend_pid()
          ORDER BY pid`);
        diagnostics.activity = activity.rows.map(({ query, ...row }) => ({ ...row,
          queryClass: query.startsWith('SELECT 1 FROM report WHERE id = $1 FOR NO KEY UPDATE') ? 'notice_report_lock'
            : query.startsWith('INSERT INTO report_event') ? 'insert_report_event'
              : /^INSERT INTO findings\s*\(/.test(query) ? 'insert_findings'
                : query.startsWith('WITH counts AS') ? 'compute_integrity_signals'
                  : query.startsWith('INSERT INTO integrity_refresh') ? 'queue_integrity_neighbors' : 'other',
          querySha256: createHash('sha256').update(query).digest('hex') }));
      } catch (error) {
        const code = (error as { code?: string }).code;
        diagnostics.activity = code && /^[0-9A-Z]{5}$/.test(code) ? code : 'diagnostic_unavailable';
      } finally { await observer.end().catch(() => {}); }
      context.diagnostic(JSON.stringify(diagnostics));
    }
    assert.equal(independent.status, 201);
    await database.query('COMMIT');
    assert.equal((await waiting).status, 201);
  } finally {
    await database.query('ROLLBACK');
    await database.end();
  }
});

test('a neighboring Integrity refresh does not tie independent Notice writes to one Report lock', async () => {
  const isolated = await startClockedApi(Date.now());
  const database = isolated.database;
  const connection = new URL(testDatabaseUrl());
  connection.pathname = '/' + (await database.query('SELECT current_database() AS name')).rows[0].name;
  const workers = new Pool({ connectionString: connection.toString(), max: 1, connectionTimeoutMillis: 5000 });
  const worker = await workers.connect();
  const ownerPid = (await database.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
  const workerPid = (await worker.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
  let waiting: Promise<Response> | undefined;
  let refreshing: Promise<void> | undefined;
  let refreshError: string | undefined;
  try {
    const first = await syncedReport(isolated.base);
    const second = await syncedReport(isolated.base);
    const firstEvent = event('notice_composed');
    const secondEvent = event('notice_composed');
    await database.query('DELETE FROM integrity_refresh WHERE report_id = $1', [first.id]);
    await database.query('BEGIN');
    await database.query('SELECT 1 FROM report WHERE id = $1 FOR UPDATE', [first.id]);
    waiting = send(first.id, first.token, firstEvent, isolated.base);
    await blockedBy(database, ownerPid);
    assert.equal((await send(first.id, first.token, event('notice_composed'), isolated.base)).status, 429);
    await worker.query('BEGIN');
    await worker.query("SET LOCAL lock_timeout = '3s'");
    await computeIntegritySignals(worker, second.id);
    refreshing = queueIntegrityNeighbors(worker, second.id)
      .then(async () => { await worker.query('COMMIT'); })
      .catch(async error => { refreshError = String(error.code ?? 'Error'); await worker.query('ROLLBACK'); });
    await blockedBy(database, ownerPid, workerPid);
    const independent = await send(second.id, second.token, secondEvent, isolated.base);
    await database.query('COMMIT');
    assert.equal(independent.status, 201);
    assert.equal((await waiting).status, 201);
    await refreshing;
    assert.equal(refreshError, undefined);
    const expected = [{ reportId: first.id, item: firstEvent }, { reportId: second.id, item: secondEvent }].map(({ reportId, item }) => {
      const { id, kind, at, ...details } = item;
      return { report_id: reportId, event_id: id, kind, details };
    }).sort((a, b) => a.event_id.localeCompare(b.event_id));
    assert.deepEqual((await database.query(`SELECT report_id,event_id,kind,details FROM report_event
      WHERE event_id IS NOT NULL ORDER BY event_id`)).rows, expected);
  } finally {
    await database.query('ROLLBACK');
    await refreshing;
    await waiting;
    worker.release();
    await workers.end();
    await isolated.close();
  }
});

for (const replay of [true, false]) test(`Withdrawal waits for an active Notice ${replay ? 'replay' : 'foreign-ID conflict'} and retains durable deletion`, async () => {
  const isolated = await startClockedApi(Date.now());
  const database = isolated.database;
  let writing: Promise<Response> | undefined;
  let withdrawing: Promise<Response> | undefined;
  try {
    const report = await syncedReport(isolated.base);
    const fixtureReport = replay ? report : await syncedReport(isolated.base);
    const item = event('notice_composed');
    const { id, kind, at, ...details } = item;
    const ownerPid = (await database.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
    await database.query('BEGIN');
    await database.query(`INSERT INTO report_event (report_id,kind,at,details,event_id)
      VALUES ($1,$2,$3,$4,$5)`, [fixtureReport.id, kind, at, details, id]);
    writing = send(report.id, report.token, item, isolated.base);
    const eventWrite = await blockedBy(database, ownerPid, undefined, /^INSERT INTO report_event/);
    assert.match(eventWrite.query, /INSERT INTO report_event/);
    withdrawing = fetch(`${isolated.base}/api/reports/${report.id}`, { method: 'DELETE',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${report.token}` } });
    const withdrawal = replay
      ? await blockedBy(database, ownerPid, undefined, /SELECT token_sha256 FROM report WHERE id = \$1 FOR UPDATE/)
      : await blockedBy(database, eventWrite.pid);
    assert.match(withdrawal.query, /SELECT token_sha256 FROM report WHERE id = \$1 FOR UPDATE/);
    await database.query('COMMIT');
    assert.equal((await writing).status, replay ? 200 : 409);
    assert.equal((await withdrawing).status, 204);
    for (const table of ['report', 'report_event', 'findings_job', 'integrity_refresh', 'integrity_signal']) {
      const column = table === 'report' ? 'id' : 'report_id';
      assert.equal((await database.query(`SELECT count(*)::int AS count FROM ${table} WHERE ${column}=$1`, [report.id])).rows[0].count, 0);
    }
    assert.equal((await send(report.id, report.token, item, isolated.base)).status, 404);
    assert.equal((await database.query('SELECT token_sha256 FROM report_withdrawal WHERE id=$1', [report.id])).rows[0].token_sha256,
      createHash('sha256').update(report.token).digest('hex'));
    assert.equal((await database.query('SELECT total::int AS total FROM excluded_withdrawal_count')).rows[0].total, 0);
    if (!replay) assert.equal((await database.query('SELECT report_id FROM report_event WHERE event_id=$1', [id])).rows[0].report_id, fixtureReport.id);
  } finally {
    await database.query('ROLLBACK');
    await writing;
    await withdrawing;
    await isolated.close();
  }
});

test('concurrent Notice replays do not request another connection while holding the whole API pool', async () => {
  const isolated = await startClockedApi(Date.now());
  const database = isolated.database;
  const pending: Promise<Response>[] = [];
  try {
    const reports = [];
    for (let index = 0; index < 5; index++) reports.push(await syncedReport(isolated.base));
    const items = reports.map(() => event('notice_composed'));
    const ownerPid = (await database.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
    await database.query('BEGIN');
    for (let index = 0; index < reports.length; index++) {
      const { id, kind, at, ...details } = items[index];
      await database.query(`INSERT INTO report_event (report_id,kind,at,details,event_id)
        VALUES ($1,$2,$3,$4,$5)`, [reports[index].id, kind, at, details, id]);
      pending.push(send(reports[index].id, reports[index].token, items[index], isolated.base));
    }
    let blocked = 0;
    for (let attempt = 0; attempt < 100; attempt++) {
      await database.query('SELECT pg_stat_clear_snapshot()');
      blocked = (await database.query(`SELECT count(*)::int AS count FROM pg_stat_activity
        WHERE datname=current_database() AND $1=ANY(pg_blocking_pids(pid))
          AND query LIKE 'INSERT INTO report_event%'`, [ownerPid])).rows[0].count;
      if (blocked === 5) break;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.equal(blocked, 5, 'All five actual event writes must hold their API pool connections');
    await database.query('COMMIT');
    assert.deepEqual((await Promise.all(pending)).map(response => response.status), [200, 200, 200, 200, 200]);
  } finally {
    await database.query('ROLLBACK');
    await Promise.all(pending);
    await isolated.close();
  }
});

// SYNCED_REPORT_CALLS raises the count for a repeat run (the daily Report limit is 50 per address).
test('syncedReport on the shared stack returns only after the new Report\'s own integrity refresh has run', async () => {
  const database = new Client({ connectionString: testDatabaseUrl() });
  await database.connect();
  try {
    // Earlier tests in a full run spend the shared 50-Report daily budget; this disposable database is ours to reset.
    await database.query('DELETE FROM rate_counter');
    for (let call = 0; call < Number(process.env.SYNCED_REPORT_CALLS ?? 5); call++) {
      const { id, token } = await syncedReport();
      assert.equal((await database.query('SELECT 1 FROM integrity_refresh WHERE report_id = $1', [id])).rowCount, 0, `call ${call}`);
      const withdrawn = await fetch(`${base}/api/reports/${id}`, { method: 'DELETE', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` } });
      assert.equal(withdrawn.status, 204);
    }
  } finally { await database.end(); }
});
