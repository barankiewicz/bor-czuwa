import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout } from 'node:timers/promises';
import { createApiServer } from '../server/api.ts';
import { pool } from '../server/db.ts';

after(() => pool.end());

test('liveness stays separate from readiness and worker progress', async () => {
  const server = createApiServer();
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  try {
    assert.deepEqual(await (await fetch(`${base}/api/health`)).json(), { status: 'ok' });
    assert.deepEqual(await (await fetch(`${base}/api/ready`)).json(), { status: 'ready' });
    const worker = await (await fetch(`${base}/api/worker-status`)).json() as Record<string, unknown>;
    assert.equal(worker.status, 'ok');
    assert.equal(typeof worker.last_poll_age_seconds, 'number');
    assert.equal(typeof worker.queued, 'number');
    assert.equal(typeof worker.terminal_failures, 'number');
    assert.equal(typeof worker.integrity_last_poll_age_seconds, 'number');
    assert.equal(typeof worker.integrity_queued, 'number');
    assert.equal(typeof worker.integrity_terminal_failures, 'number');
    assert.equal(typeof worker.recovery_count, 'number');
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

test('a blocked database query times out and returns pool capacity', async () => {
  const blocker = await pool.connect();
  try {
    await blocker.query('BEGIN');
    await blocker.query('LOCK TABLE report IN ACCESS EXCLUSIVE MODE');
    const started = Date.now();
    await assert.rejects(pool.query('SELECT count(*) FROM report'), (error: { code?: string }) => {
      assert.equal(error.code, '55P03');
      assert.ok(Date.now() - started < 6000);
      return true;
    });
  } finally {
    await blocker.query('ROLLBACK');
    blocker.release();
  }
  assert.equal((await pool.query('SELECT 1 AS ready')).rows[0].ready, 1);
});

test('server shutdown drains active database work before closing', async () => {
  const blocker = await pool.connect();
  const server = createApiServer();
  try {
    await blocker.query('BEGIN');
    await blocker.query('LOCK TABLE findings_job IN ACCESS EXCLUSIVE MODE');
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const responsePromise = fetch(`${base}/api/worker-status`);
    await setTimeout(50);
    const closePromise = new Promise<void>(resolve => server.close(() => resolve()));
    const response = await responsePromise;
    await closePromise;
    assert.equal(response.status, 503);
  } finally {
    await blocker.query('ROLLBACK');
    blocker.release();
    if (server.listening) await new Promise<void>(resolve => server.close(() => resolve()));
  }
  assert.equal((await pool.query('SELECT 1 AS ready')).rows[0].ready, 1);
});

test('a slow statement hits its runtime budget and returns pool capacity', async () => {
  const started = Date.now();
  await assert.rejects(pool.query('SELECT pg_sleep(12)'), (error: { code?: string }) => {
    assert.equal(error.code, '57014');
    assert.ok(Date.now() - started < 15_000);
    return true;
  });
  assert.equal((await pool.query('SELECT 1 AS ready')).rows[0].ready, 1);
});

test('worker status counts API 503s by SQLSTATE without exception text', async () => {
  const blocker = await pool.connect();
  const server = createApiServer();
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  try {
    const before = await (await fetch(`${base}/api/worker-status`)).json();
    await blocker.query('BEGIN');
    await blocker.query('LOCK TABLE findings_job IN ACCESS EXCLUSIVE MODE');
    const failed = await fetch(`${base}/api/worker-status`);
    assert.equal(failed.status, 503);
    assert.deepEqual(await failed.json(), { error: 'temporarily_unavailable' });
    await blocker.query('ROLLBACK');
    const after = await (await fetch(`${base}/api/worker-status`)).json();
    assert.equal(after.api_503_by_class['55P03'], (before.api_503_by_class['55P03'] ?? 0) + 1);
    assert.ok(Object.keys(after.api_503_by_class).every(key => /^[0-9A-Z]{5}$/.test(key)));
    await blocker.query('BEGIN');
    await blocker.query('LOCK TABLE recipient_jurisdiction IN ACCESS EXCLUSIVE MODE');
    const unavailable = await fetch(`${base}/api/recipients`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ lat: 52, lon: 13 })
    });
    assert.equal(unavailable.status, 503);
    assert.deepEqual(await unavailable.json(), { error: 'temporarily_unavailable' });
    await blocker.query('ROLLBACK');
    const domain = await (await fetch(`${base}/api/worker-status`)).json();
    assert.equal(domain.api_503_by_class['55P03'],
      (after.api_503_by_class['55P03'] ?? 0) + 1);
  } finally {
    await blocker.query('ROLLBACK');
    blocker.release();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});
