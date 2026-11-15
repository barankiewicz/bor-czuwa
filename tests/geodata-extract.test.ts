import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const web = process.env.TEST_WEB_URL;
const snapshot = 'moniecki-2026-09-25-osm-v1';
const path = `/api/geodata/${snapshot}/ambony`;
const source = await readFile(new URL('../data/fixtures/osm/stands.geojsonseq', import.meta.url));

async function download(pathname: string, init?: RequestInit) {
  for (let attempt = 0; attempt < 5; attempt++) {
    const response = await fetch(`${web}${pathname}`, init);
    if (response.status !== 429) return response;
    await new Promise(resolve => setTimeout(resolve, 1100));
  }
  throw new Error('Download route did not admit request');
}

test('immutable extract serves exact snapshot bytes with conditional and range requests', { skip: !web }, async () => {
  const full = await download(path, { headers: { origin: 'https://localhost' } });
  assert.equal(full.status, 200);
  assert.deepEqual(Buffer.from(await full.arrayBuffer()), source);
  assert.equal(full.headers.get('cache-control'), 'public, max-age=31536000, immutable');
  assert.match(full.headers.get('content-type') ?? '', /application\/geo\+json-seq/);
  assert.match(full.headers.get('content-disposition') ?? '', /osm-stands-moniecki-2026-09-25-osm-v1.geojsonseq/);
  assert.match(full.headers.get('link') ?? '', /rel="license"/);
  assert.match(full.headers.get('link') ?? '', /rel="source"/);
  assert.equal(full.headers.get('access-control-allow-origin'), 'https://localhost');
  const etag = full.headers.get('etag');
  assert.ok(etag);
  const conditional = await download(path, { headers: { 'if-none-match': etag } });
  assert.equal(conditional.status, 304);
  assert.equal(conditional.headers.get('cache-control'), 'public, max-age=31536000, immutable');
  assert.equal((await conditional.arrayBuffer()).byteLength, 0);
  const modifiedSince = await download(path, { headers: { 'if-modified-since': full.headers.get('last-modified') ?? '' } });
  assert.equal(modifiedSince.status, 304);
  const range = await download(path, { headers: { range: 'bytes=0-15' } });
  assert.equal(range.status, 206);
  assert.equal(range.headers.get('content-range'), `bytes 0-15/${source.length}`);
  assert.deepEqual(Buffer.from(await range.arrayBuffer()), source.subarray(0, 16));
  const head = await download(path, { method: 'HEAD' });
  assert.equal(head.status, 200);
  assert.equal(Number(head.headers.get('content-length')), source.length);
  const preflight = await download(path, { method: 'OPTIONS', headers: { origin: 'https://localhost',
    'access-control-request-method': 'GET', 'access-control-request-headers': 'Range' } });
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get('access-control-allow-origin'), 'https://localhost');
});

test('unknown extracts stay uncached and direct API does not read legacy bytea', { skip: !web }, async () => {
  const missing = await download('/api/geodata/missing/ambony');
  assert.equal(missing.status, 404);
  assert.notEqual(missing.headers.get('cache-control'), 'public, max-age=31536000, immutable');
  const direct = await fetch(`${process.env.TEST_BASE_URL ?? 'http://127.0.0.1:3001'}${path}`);
  assert.equal(direct.status, 404);
});
