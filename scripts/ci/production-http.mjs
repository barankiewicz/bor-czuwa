import { execFileSync } from 'node:child_process';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { chromium } from '@playwright/test';
import { randomUUID } from 'node:crypto';

const [directory, mode] = process.argv.slice(2);
if (!directory || !['production', 'staging'].includes(mode)) throw new Error('Usage: production-http.mjs PAYLOAD MODE');
const temporary = await mkdtemp(path.join(tmpdir(), 'candidate-http-'));
const name = `candidate-http-${randomUUID()}`;
const run = (program, args) => execFileSync(program, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
try {
  // Render the production policy, then adapt only TLS/listener and filesystem paths
  // for a disposable loopback nginx. The production response headers stay intact.
  let config = run('python3', [path.join(directory, 'ops/production/render-nginx.py'), 'candidate.example',
    '--indexing', mode === 'staging' ? 'staging' : 'public']);
  config = config.replace('user www-data;', 'user nginx;').replaceAll('listen 443 ssl;', 'listen 8080;')
    .replaceAll('listen [::]:443 ssl;', '').replaceAll(/    ssl_certificate(?:_key)? .*;\n/g, '')
    .replaceAll('/opt/bor-czuwa/current/build', '/usr/share/nginx/html');
  await writeFile(path.join(temporary, 'nginx.conf'), config);
  run('podman', ['run', '-d', '--name', name, '-p', '127.0.0.1::8080', '-v', `${path.resolve(directory, 'build')}:/usr/share/nginx/html:ro,Z`,
    '-v', `${temporary}/nginx.conf:/etc/nginx/nginx.conf:ro,Z`, 'docker.io/library/nginx:1.28-alpine']);
  const origin = `http://${run('podman', ['port', name, '8080/tcp']).trim()}`;
  const results = [];
  for (const route of ['/', '/legal/privacy/v1/', '/service-worker.js', '/missing', '/_app/immutable/missing.js']) {
    const response = await fetch(origin + route, { signal: AbortSignal.timeout(10000), headers: { Host: 'candidate.example' } });
    const body = await response.text();
    const headers = response.headers;
    if (headers.get('x-frame-options') !== 'DENY' || headers.get('x-content-type-options') !== 'nosniff'
      || headers.get('referrer-policy') !== 'no-referrer' || !headers.get('content-security-policy')?.includes("frame-ancestors 'none'")
      || headers.get('permissions-policy') !== 'camera=(self), geolocation=(self)') throw new Error(`HTTP security headers failed: ${route}`);
    // The app host never serves the public face, so every response keeps the exclusion in both modes.
    if (!/noindex/i.test(headers.get('x-robots-tag') ?? '')) {
      throw new Error(`Required noindex missing: ${route}`);
    }
    if (route === '/' && response.status !== 200) throw new Error('Candidate document unavailable');
    results.push({ route, status: response.status });
  }
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    const response = await page.goto(origin, { waitUntil: 'networkidle' });
    if (!/noindex/i.test(response.headers()['x-robots-tag'] ?? '')) throw new Error('Required noindex missing: hydrated document');
  } finally { await browser.close(); }
  console.log(JSON.stringify({ passed: true, indexing: 'noindex', routes: results,
    scope: 'actual HTTP responses from rendered production nginx; dedicated HTTPS host remains a human gate' }));
} finally {
  try { run('podman', ['rm', '-f', name]); } finally { await rm(temporary, { recursive: true, force: true }); }
}
