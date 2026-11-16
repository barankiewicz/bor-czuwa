import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

// The landing lives on shared hosting where a header file may be ignored, so every page has to
// carry its own policy. LANDING_BUILD points the test at another directory, for the fixtures that
// prove it fails; by default it reads the real build.
const root = process.env.LANDING_BUILD ?? path.resolve(import.meta.dirname, '../build');
if (!existsSync(root)) throw new Error(`${root} is missing; run npm run build:landing first`);

const pages = (directory: string): string[] => readdirSync(directory, { withFileTypes: true }).flatMap(entry =>
  entry.isDirectory() ? pages(path.join(directory, entry.name)) : entry.name.endsWith('.html') ? [path.join(directory, entry.name)] : []);
const files = pages(root);
const attribute = (tag: string, name: string) => new RegExp(`\\b${name}\\s*=\\s*"([^"]*)"`, 'i').exec(tag)?.[1];
const metas = (html: string) => html.match(/<meta\b[^>]*>/gi) ?? [];

test('the build holds pages', () => assert.ok(files.length >= 8, `found ${files.length} pages`));

for (const file of files) test(`${path.relative(root, file)} carries its own CSP and referrer policy`, () => {
  const html = readFileSync(file, 'utf8');
  const policies = metas(html).filter(tag => attribute(tag, 'http-equiv')?.toLowerCase() === 'content-security-policy');
  assert.equal(policies.length, 1, 'exactly one CSP meta element');
  const directives = new Map((attribute(policies[0], 'content') ?? '').split(';').map(part => part.trim().split(/\s+/)).filter(part => part[0]).map(([name, ...sources]) => [name, sources]));
  assert.deepEqual(directives.get('default-src'), ["'none'"]);
  for (const [name, sources] of directives) for (const source of sources) {
    // The one address a page may contact is the page-opening count (ticket 14), and only as connect-src.
    if (name === 'connect-src') assert.equal(source, 'https://app.bor-czuwa.pl/_stats/website', 'connect-src allows exactly the counting endpoint');
    else assert.ok(!/^(https?:|\*|wss?:)/.test(source), `${name} names another origin: ${source}`);
    if (name !== 'style-src-attr') assert.notEqual(source, "'unsafe-inline'", `${name} allows inline code`);
    assert.notEqual(source, "'unsafe-eval'");
  }
  // Every inline script must be allowed by hash, or the policy blocks the page's own bootstrap.
  for (const [, body] of html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)) {
    const hash = `'sha256-${createHash('sha256').update(body).digest('base64')}'`;
    assert.ok(directives.get('script-src')?.includes(hash), `inline script ${hash} is not allowed by script-src`);
  }
  const referrers = metas(html).filter(tag => attribute(tag, 'name')?.toLowerCase() === 'referrer');
  assert.deepEqual(referrers.map(tag => attribute(tag, 'content')), ['no-referrer']);
});

test('.htaccess ships in the build with the guarded headers and the sync-state denial', () => {
  const file = path.join(root, '.htaccess');
  assert.ok(existsSync(file), '.htaccess is not in the build');
  const text = readFileSync(file, 'utf8').replace(/^\s*#.*$/gm, '');
  const guard = /<IfModule mod_headers\.c>([\s\S]*?)<\/IfModule>/.exec(text)?.[1] ?? '';
  assert.match(guard, /Header always set Content-Security-Policy "frame-ancestors 'none'"/);
  assert.match(guard, /Header always set Referrer-Policy "no-referrer"/);
  // A Header directive outside the guard is a 500 on every request when mod_headers is absent.
  assert.equal(text.replace(guard, '').includes('Header '), false, 'Header directive outside the IfModule guard');
  assert.match(text, /<Files "\.ftp-deploy-sync-state\.json">\s*Require all denied\s*<\/Files>/);
});

test('.htaccess hardening directives are present, each inside an IfModule guard', () => {
  const text = readFileSync(path.join(root, '.htaccess'), 'utf8').replace(/^\s*#.*$/gm, '');
  const guarded = [...text.matchAll(/<IfModule (mod_\w+)\.c>([\s\S]*?)\n<\/IfModule>/g)];
  const inside = (module: string) => guarded.filter(match => match[1] === module).map(match => match[2]).join('\n');
  const headers = inside('mod_headers');
  assert.match(headers, /Header always set Strict-Transport-Security "max-age=\d{7,}"/);
  assert.doesNotMatch(text, /includeSubDomains|preload/i, 'HSTS covers this host only');
  assert.match(headers, /Header always set X-Content-Type-Options "nosniff"/);
  assert.match(headers, /Header always set Cross-Origin-Opener-Policy "same-origin"/);
  const permissions = /Permissions-Policy "([^"]+)"/.exec(headers)?.[1] ?? '';
  for (const feature of ['camera', 'microphone', 'geolocation', 'payment', 'usb']) assert.ok(permissions.includes(`${feature}=()`), feature);
  assert.match(headers, /immutable/);
  assert.match(inside('mod_autoindex'), /Options -Indexes/);
  assert.match(inside('mod_authz_core'), /<FilesMatch "\^\\\.">\s*Require all denied/);
  assert.match(inside('mod_alias'), /RedirectMatch 404 .*well-known/);
  // Nothing that needs a module may sit outside its guard: that is a 500 when the module is absent.
  const outside = guarded.reduce((rest, match) => rest.replace(match[0], ''), text);
  assert.doesNotMatch(outside, /\b(Header|Expires\w*|RedirectMatch|Require)\b/, 'a module directive outside its guard');
});
