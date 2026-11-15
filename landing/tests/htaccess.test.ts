import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir, userInfo } from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';

// Runs the built .htaccess through a real Apache 2.4 on a loopback port and reads the answers off
// the wire, because the file is only a request that a host may ignore and a directive that does
// nothing looks the same as one that works. Skips, loudly, where httpd is not installed. The
// modules below are the ones lh.pl is expected to have; the file's IfModule guards are tested
// separately in policy.test.ts and by the run without mod_headers below.
const root = process.env.LANDING_BUILD ?? path.resolve(import.meta.dirname, '../build');
// The server is httpd (Fedora, Red Hat) or apache2 (Debian, Ubuntu); its modules live in a
// different directory on each. The first candidate that holds mod_headers.so wins.
export const moduleCandidates = ['/usr/lib64/httpd/modules', '/usr/lib/httpd/modules', '/usr/lib/apache2/modules', '/usr/libexec/apache2', '/usr/local/libexec/apache24'];
export const findModules = (candidates: string[]) => candidates.find(directory => existsSync(path.join(directory, 'mod_headers.so')));
const httpd = ['httpd', 'apache2'].find(name => spawnSync(name, ['-v']).status === 0);
const modules = findModules(moduleCandidates) ?? '';
const skip = !httpd || !modules ? 'httpd or apache2 2.4 with its modules is not installed' : false;
const port = 18000 + Math.floor(Math.random() * 1000);
let work: string, child: ReturnType<typeof spawn>;

const config = (dir: string, load: string[]) => `ServerRoot "${dir}"
PidFile "${dir}/pid"
Listen 127.0.0.1:PORT
ErrorLog "${dir}/error.log"
${['mpm_event', 'unixd', 'authz_core', 'mime', 'dir', ...load].map(name => `LoadModule ${name}_module ${modules}/mod_${name}.so`).join('\n')}
TypesConfig /etc/mime.types
User ${userInfo().username}
DocumentRoot "${dir}/site"
<Directory "${dir}/site">
  AllowOverride All
  Require all granted
</Directory>
`;

async function start(load: string[], listen: number): Promise<void> {
  const dir = mkdtempSync(path.join(tmpdir(), 'bor-htaccess-'));
  work = dir;
  cpSync(root, path.join(dir, 'site'), { recursive: true });
  mkdirSync(path.join(dir, 'site/empty'));
  writeFileSync(path.join(dir, 'site/.ftp-deploy-sync-state.json'), '{}');
  writeFileSync(path.join(dir, 'site/.env'), 'SECRET=1');
  writeFileSync(path.join(dir, 'conf'), config(dir, load).replace('PORT', String(listen)));
  child = spawn(httpd!, ['-f', path.join(dir, 'conf'), '-X'], { stdio: 'ignore' });
  for (let n = 0; n < 100; n++) {
    try { await fetch(`http://127.0.0.1:${listen}/`); return; } catch { await new Promise(resolve => setTimeout(resolve, 50)); }
  }
  throw new Error('httpd did not start');
}
const stop = () => { child?.kill(); if (work) rmSync(work, { recursive: true, force: true }); };
const get = (listen: number, url: string) => fetch(`http://127.0.0.1:${listen}${url}`, { redirect: 'manual' });

const full = ['headers', 'autoindex', 'alias'];
before(async () => { if (!skip) await start(full, port); });
after(stop);

test('security headers come with every page', { skip }, async () => {
  const response = await get(port, '/');
  assert.equal(response.status, 200);
  const h = response.headers;
  assert.equal(h.get('strict-transport-security'), 'max-age=31536000');
  assert.doesNotMatch(h.get('strict-transport-security')!, /includeSubDomains|preload/i);
  assert.equal(h.get('x-content-type-options'), 'nosniff');
  assert.equal(h.get('cross-origin-opener-policy'), 'same-origin');
  assert.equal(h.get('referrer-policy'), 'no-referrer');
  assert.equal(h.get('content-security-policy'), "frame-ancestors 'none'");
  const permissions = h.get('permissions-policy') ?? '';
  for (const feature of ['camera', 'microphone', 'geolocation', 'payment', 'usb']) assert.match(permissions, new RegExp(`${feature}=\\(\\)`));
});

test('pages revalidate within minutes, hashed assets last a year', { skip }, async () => {
  assert.equal((await get(port, '/')).headers.get('cache-control'), 'public, max-age=300');
  const html = await (await get(port, '/')).text();
  const hashed = /\/_app\/immutable\/[^"']+\.[A-Za-z0-9_-]{8}\.css/.exec(html)?.[0] ?? /\/_app\/immutable\/assets\/[^"']+\.[A-Za-z0-9_-]{8}\.\w+/.exec(html)?.[0];
  assert.ok(hashed, 'the page names a hashed asset');
  assert.equal((await get(port, hashed!)).headers.get('cache-control'), 'public, max-age=31536000, immutable');
  assert.equal((await get(port, '/count.js')).headers.get('cache-control'), 'public, max-age=300', 'an unhashed script is not kept for a year');
  assert.equal((await get(port, '/share/tagline.png')).headers.get('cache-control'), 'public, max-age=86400');
});

test('no directory listing, no dotfiles, but /.well-known/ is public', { skip }, async () => {
  assert.equal((await get(port, '/empty/')).status, 403, 'a directory with no index is refused, not listed');
  for (const hidden of ['/.htaccess', '/.ftp-deploy-sync-state.json', '/.env', '/.git/config']) assert.ok([403, 404].includes((await get(port, hidden)).status), hidden);
  const security = await get(port, '/.well-known/security.txt');
  assert.equal(security.status, 200);
  assert.match(await security.text(), /^Contact: /m);
});

test('without mod_headers, mod_autoindex and mod_alias the site still answers', { skip }, async () => {
  stop();
  const bare = port + 1;
  await start([], bare);
  const response = await get(bare, '/');
  assert.equal(response.status, 200, 'every directive sits inside its IfModule guard, so a missing module is not a 500');
  assert.equal(response.headers.get('strict-transport-security'), null);
  assert.equal((await get(bare, '/.env')).status, 403, 'dotfiles are still refused by mod_authz_core');
});

test('the module directory is found where Debian puts it as well as where Fedora does', () => {
  const fake = mkdtempSync(path.join(tmpdir(), 'bor-modules-'));
  try {
    const debian = path.join(fake, 'usr/lib/apache2/modules');
    mkdirSync(debian, { recursive: true });
    writeFileSync(path.join(debian, 'mod_headers.so'), '');
    assert.equal(findModules([path.join(fake, 'usr/lib64/httpd/modules'), debian]), debian);
    assert.equal(findModules([path.join(fake, 'nowhere')]), undefined);
  } finally { rmSync(fake, { recursive: true, force: true }); }
});
