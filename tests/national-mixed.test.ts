import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import { promisify } from 'node:util';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const point = JSON.parse(await readFile(new URL('../data/fixtures/acceptance.json', import.meta.url), 'utf8')).edge;

test('mixed load records real HTTP captures and lookups without changing Findings measurements', async context => {
  const { createApiServer } = await import('../server/api.ts');
  const { pool } = await import('../server/db.ts');
  const server = createApiServer();
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  context.after(async () => {
    await new Promise<void>(resolve => server.close(() => resolve()));
    await pool.end();
  });
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const { stdout } = await promisify(execFile)(process.execPath,
    ['--import', 'tsx', 'scripts/benchmark-national-mixed.mjs', '--drive', base,
      JSON.stringify({ points: [point.point], seconds: 1, capturesPerSecond: 2, lookupsPerSecond: 4, readsPerSecond: 4 })]);
  const result = JSON.parse(stdout);
  assert.equal(result.requests.filter((row: { route: string; status: number }) => row.route === 'capture' && row.status === 201).length, 2);
  assert.equal(result.requests.filter((row: { route: string; status: number }) => row.route === 'lookup' && row.status === 200).length, 4);
  assert.equal(result.accepted, true);
  assert.equal(result.requests.filter((row: { route: string; status: number }) => row.route === 'read' && row.status === 200).length, 4);
  assert.ok(result.requests.every((row: { milliseconds: number; status: number; error?: string }) =>
    row.milliseconds >= 0 && row.status >= 200 && row.status < 300 && row.error === undefined));
  for (const report of result.reports) {
    let findings;
    for (let attempt = 0; attempt < 100; attempt++) {
      const response = await fetch(`${base}/api/reports/${report.id}/findings`, { headers: { authorization: `Bearer ${report.token}` } });
      assert.equal(response.status, 200);
      findings = await response.json();
      if (findings.status !== 'pending') break;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert.equal(findings.status, 'computed');
    assert.ok(Math.abs(findings.dwelling_distance.value_m - point.expected_m) <= 0.5);
    assert.equal(findings.accuracy_m, 8);
    assert.equal(findings.rule_set_id, 'pl-2026-09-24-v2-protected-v1');
  }
});

for (const fault of ['malformed JSON', 'transport failure']) {
  test(`mixed load rejects a read with ${fault}`, async context => {
    const server = createServer((_request, response) => {
      if (fault === 'transport failure') response.destroy();
      else {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end('{invalid');
      }
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    context.after(() => new Promise<void>(resolve => server.close(() => resolve())));
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const { stdout } = await promisify(execFile)(process.execPath,
      ['--import', 'tsx', 'scripts/benchmark-national-mixed.mjs', '--drive', base,
        JSON.stringify({ points: [point.point], seconds: 1, capturesPerSecond: 0, lookupsPerSecond: 0, readsPerSecond: 1 })]);
    const result = JSON.parse(stdout);
    assert.equal(result.requests.length, 1);
    assert.equal(result.requests[0].route, 'read');
    assert.equal(result.requests[0].status, fault === 'malformed JSON' ? 200 : 0);
    assert.equal(typeof result.requests[0].error, 'string');
    assert.equal(result.accepted, false);
  });
}
