import { test } from 'node:test';
import assert from 'node:assert/strict';

const web = process.env.TEST_WEB_URL;

test('proxy bounds challenge traffic and returns usable Android backoff', { skip: !web }, async () => {
  const responses = await Promise.all(Array.from({ length: 8 }, () => fetch(`${web}/api/challenge`, {
    headers: { origin: 'https://localhost' }
  })));
  const limited = responses.find(response => response.status === 429);
  assert.ok(limited, `statuses: ${responses.map(response => response.status).join(', ')}`);
  assert.equal(limited.headers.get('retry-after'), '1');
  assert.equal(limited.headers.get('access-control-allow-origin'), 'https://localhost');
  assert.equal(limited.headers.get('access-control-expose-headers'), 'Retry-After');
  assert.deepEqual(await limited.json(), { error: 'try_again' });
  // A body route allows 4 connections per client at a time, so the eight go in fours.
  const postReport = () => fetch(`${web}/api/reports`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  const reports = [...await Promise.all(Array.from({ length: 4 }, postReport)), ...await Promise.all(Array.from({ length: 4 }, postReport))];
  assert.ok(reports.every(response => response.status === 400),
    `Report statuses: ${reports.map(response => response.status).join(', ')}`);
});

test('proxy gives health, downloads, assets and Notice batches separate bounded budgets', { skip: !web }, async () => {
  const checks = [
    ['/api/health', 12, 200],
    ['/api/geodata/missing/ambony', 4, 404]
  ] as const;
  for (const [path, count, ordinaryStatus] of checks) {
    const responses = await Promise.all(Array.from({ length: count }, () => fetch(`${web}${path}`)));
    assert.ok(responses.some(response => response.status === ordinaryStatus), path);
    assert.ok(responses.some(response => response.status === 429), path);
  }
  const assets = await Promise.all(Array.from({ length: 24 }, () => fetch(`${web}/absent-static-file`)));
  assert.ok(assets.every(response => response.status === 404),
    `Asset statuses: ${assets.map(response => response.status).join(', ')}`);
  const immutable = await Promise.all(Array.from({ length: 24 }, () => fetch(`${web}/_app/immutable/absent-file`)));
  assert.ok(immutable.every(response => response.status === 404));
  const eventPath = '/api/reports/00000000-0000-4000-8000-000000000000/events';
  // Events are POST only, and a body route allows 4 connections per client at a time, so the batch
  // goes in fours: what is measured here is the events rate budget, not the connection share.
  const postEvent = () => fetch(`${web}${eventPath}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  const batch: Response[] = [];
  for (let sent = 0; sent < 18; sent += 4) batch.push(...await Promise.all(Array.from({ length: Math.min(4, 18 - sent) }, postEvent)));
  assert.ok(batch.filter(response => response.status === 404).length >= 15,
    `Notice batch statuses: ${batch.map(response => response.status).join(', ')}`);
  const overBurst: Response[] = [];
  for (let sent = 0; sent < 8; sent += 4) overBurst.push(...await Promise.all(Array.from({ length: 4 }, postEvent)));
  assert.ok(overBurst.some(response => response.status === 429));
});
