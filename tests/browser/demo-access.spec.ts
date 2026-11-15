import { test, expect, type Page } from '@playwright/test';
import { createServer, type ViteDevServer } from 'vite';
import { android } from './native-notifications.ts';
import { createHash, randomUUID } from 'node:crypto';
import { reportSchema } from '../../src/lib/report.ts';
import { readFile } from 'node:fs/promises';
import { translate } from '../../src/lib/strings.ts';
import { noFileWatcher } from '../helpers/no-file-watcher.ts';

// Source-matched native-bridge UI fixture, not hosted or physical Android acceptance.
// Keep the supported TypeScript/Chrome107 baseline; Promise.withResolvers is not available there.
const origin = 'https://native-demo.example.invalid';
const invitation = 'a'.repeat(64);
let server: ViteDevServer;
let url: string;
const previous = { recipient: process.env.VITE_DEMO_TEST_RECIPIENT, origin: process.env.VITE_API_ORIGIN };

test.use({ serviceWorkers: 'block', permissions: [] });
test.beforeAll(async () => {
  process.env.VITE_DEMO_TEST_RECIPIENT = 'synthetic-inbox@example.invalid';
  process.env.VITE_API_ORIGIN = origin;
  server = await createServer({ mode: 'staging', server: { host: '127.0.0.1', port: 0 },
    optimizeDeps: { noDiscovery: true, include: [] }, plugins: [noFileWatcher] });
  await server.listen();
  const address = server.httpServer!.address();
  if (!address || typeof address === 'string') throw new Error('native_fixture_address_unavailable');
  url = `http://127.0.0.1:${address.port}`;
});
test.afterAll(async () => {
  await server?.close();
  if (previous.recipient === undefined) delete process.env.VITE_DEMO_TEST_RECIPIENT;
  else process.env.VITE_DEMO_TEST_RECIPIENT = previous.recipient;
  if (previous.origin === undefined) delete process.env.VITE_API_ORIGIN;
  else process.env.VITE_API_ORIGIN = previous.origin;
});

// Only immutable Draft fields, Report payload/token/notes and Withdrawal ownership are compared.
// Retry/event progress may change legitimately; this is not exact full-store or sync-completion proof.
const inventory = (page: Page) => page.evaluate(async () => {
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open('bor-czuwa');
    request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
  });
  const all = (name: string) => new Promise<any[]>((resolve, reject) => {
    const read = db.transaction(name).objectStore(name).getAll();
    read.onsuccess = () => resolve(read.result); read.onerror = () => reject(read.error);
  });
  const result = {
    drafts: (await all('drafts')).map(({ id, capturedAt, eventType, note, fix }) => ({ id, capturedAt, eventType, note, fix })),
    reports: (await all('reports')).map(({ report, token, note }) => ({ report, token, note })),
    withdrawals: (await all('withdrawals')).map(({ id, token, at }) => ({ id, token, at }))
  };
  db.close();
  return result;
});

test('gate revocation reopens the mounted Menu entry without losing queued or local work', async ({ page, context }) => {
  test.setTimeout(90_000);
  await android(context);
  await context.addInitScript(() => localStorage.setItem('first-launch-seen', '1'));
  let refused = false;
  let foreignRequests = 0;
  await context.route('https://foreign.example/**', route => { foreignRequests++; return route.fulfill({ body: 'unexpected' }); });
  await context.route(`${origin}/api/**`, route => {
    const path = new URL(route.request().url()).pathname;
    const headers = { 'access-control-allow-origin': '*', 'content-type': 'application/json' };
    if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204,
      headers: { ...headers, 'access-control-allow-methods': 'GET, POST, DELETE',
        'access-control-allow-headers': 'authorization, content-type, x-bor-demo-invitation' } });
    if (path === '/api/redirect-probe') return route.fulfill({ status: 302,
      headers: { ...headers, location: 'https://foreign.example/should-not-receive-invitation' }, body: '' });
    const allowed = !refused && route.request().headers()['x-bor-demo-invitation'] === invitation;
    return route.fulfill({ status: allowed && path === '/api/ready' ? 200 : refused ? 401 : 503,
      headers, json: { status: allowed && path === '/api/ready' ? 'ready' : 'unavailable' } });
  });
  await page.goto(url);
  // Capture is usable before entering any invitation.
  await page.getByRole('button', { name: 'Zapisz miejsce i czas', exact: true }).click();
  await expect(page.locator('#receipt')).toBeVisible();
  const at = new Date().toISOString();
  const token = 'c'.repeat(64);
  const queued = { report: reportSchema.parse({
    id: randomUUID(), event_type: 'person_with_gun', captured_at: at,
    occurred_at: { at, source: 'device_clock', coarseness: 'exact' },
    device_fix: { lat: 52, lon: 21, accuracy_m: 12, at },
    incident_location: { lat: 52, lon: 21, source: 'device_fix' },
    species: null, photo_sha256: [], has_note: false, app_version: '0.1.0',
    privacy_policy_version: 'v1', terms_of_use_version: 'v1',
    token_sha256: createHash('sha256').update(token).digest('hex')
  }), token, events: [{ kind: 'created', at }], findings: { status: 'pending' } };
  const withdrawal = { id: randomUUID(), token: 'b'.repeat(64), at };
  await page.evaluate(async ({ queued, withdrawal }) => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('bor-czuwa');
      request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
    });
    const transaction = db.transaction(['reports', 'withdrawals'], 'readwrite');
    transaction.objectStore('reports').put(queued);
    transaction.objectStore('withdrawals').put(withdrawal);
    await new Promise<void>((resolve, reject) => {
      transaction.oncomplete = () => resolve(); transaction.onerror = () => reject(transaction.error);
    });
    db.close();
  }, { queued, withdrawal });
  const before = await inventory(page);
  expect(before.drafts).toHaveLength(1); expect(before.reports).toHaveLength(1); expect(before.withdrawals).toHaveLength(1);
  await page.getByRole('button', { name: 'Menu', exact: true }).click();
  await page.getByLabel('Kod zaproszenia', { exact: true }).fill(invitation);
  await page.getByRole('button', { name: 'Połącz z serwerem testowym', exact: true }).click();
  await expect(page.getByText('Serwer przyjął kod. Zapisane zgłoszenia mogą się teraz zsynchronizować.', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Usuń kod z pamięci', exact: true })).toBeFocused();
  // A real browser redirect must fail before any request reaches another origin.
  expect(await page.evaluate(async () => {
    const modulePath = '/src/lib/api-url.ts';
    // This page-realm loading boundary must reuse the live client module, not a static Node import.
    const transport = await import(/* @vite-ignore */ modulePath);
    try { await transport.apiFetch('/api/redirect-probe'); return false; } catch { return transport.hasNativeDemoInvitation(); }
  })).toBe(true);
  expect(foreignRequests).toBe(0);
  refused = true;
  await page.evaluate(async () => {
    const modulePath = '/src/lib/api-url.ts';
    // This page-realm loading boundary must reuse the live client module, not a static Node import.
    const transport = await import(/* @vite-ignore */ modulePath);
    const response = await transport.apiFetch('/api/challenge'); await response.body?.cancel();
  });
  await expect(page.getByRole('heading', { name: 'Menu', exact: true })).toBeVisible();
  await expect(page.getByLabel('Kod zaproszenia', { exact: true })).toBeVisible();
  await expect(page.getByLabel('Kod zaproszenia', { exact: true })).toBeFocused();
  await expect(page.getByText('Serwer przyjął kod. Zapisane zgłoszenia mogą się teraz zsynchronizować.', { exact: true })).toHaveCount(0);
  expect(await inventory(page)).toEqual(before);
});

test('invitation requests preserve keyboard focus, restore their result and do not steal another control', async ({ page, context }) => {
  await android(context);
  await context.addInitScript(() => localStorage.setItem('first-launch-seen', '1'));
  await page.setViewportSize({ width: 320, height: 740 });
  let status = 401;
  let release: (() => void) | undefined;
  await context.route(`${origin}/api/**`, async route => {
    const headers = { 'access-control-allow-origin': '*', 'content-type': 'application/json' };
    if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204,
      headers: { ...headers, 'access-control-allow-methods': 'GET, POST, DELETE',
        'access-control-allow-headers': 'authorization, content-type, x-bor-demo-invitation' } });
    if (new URL(route.request().url()).pathname !== '/api/ready') return route.fulfill({ status: 503, headers, json: { status: 'unavailable' } });
    await new Promise<void>(resolve => { release = resolve; });
    return route.fulfill({ status, headers, json: { status: status === 200 ? 'ready' : 'unavailable' } });
  });
  await page.goto(url);
  await page.evaluate(() => { document.documentElement.style.fontSize = '34px'; });
  await page.getByRole('button', { name: 'Menu', exact: true }).click();
  await expect.poll(() => page.locator('.screen-body').evaluate(node => node.scrollWidth <= node.clientWidth)).toBe(true);
  const input = page.getByLabel('Kod zaproszenia', { exact: true });
  const connect = page.getByRole('button', { name: 'Połącz z serwerem testowym', exact: true });
  const busy = page.getByRole('button', { name: 'Sprawdzanie kodu…', exact: true });
  await input.fill(invitation);
  await connect.focus();
  await page.keyboard.press('Enter');
  await expect.poll(() => !!release).toBe(true);
  await expect(busy).toBeFocused();
  await expect(input).not.toBeEditable();
  release!(); release = undefined;
  await expect(page.getByRole('alert')).toContainText('Serwer nie przyjął kodu.');
  await expect(input).toBeFocused();

  status = 200;
  await connect.focus();
  await page.keyboard.press('Enter');
  await expect.poll(() => !!release).toBe(true);
  await expect(busy).toBeFocused();
  release!(); release = undefined;
  const clear = page.getByRole('button', { name: 'Usuń kod z pamięci', exact: true });
  await expect(clear).toBeFocused();
  await clear.click();
  await expect(input).toBeFocused();
  await expect(input).toHaveValue('');

  status = 401;
  await input.fill(invitation);
  await connect.focus();
  await page.keyboard.press('Enter');
  await expect.poll(() => !!release).toBe(true);
  const elsewhere = page.getByRole('button', { name: 'English', exact: true });
  await elsewhere.focus();
  release!(); release = undefined;
  await expect(page.getByRole('alert')).toContainText('Serwer nie przyjął kodu.');
  await expect(elsewhere).toBeFocused();
});

for (const language of ['pl', 'en'] as const) test(`native dataset-download failure is accessible inside Sources in ${language}`, async ({ page, context }) => {
  const t = (text: string) => translate(language, text);
  await android(context);
  await context.addInitScript(value => {
    localStorage.setItem('first-launch-seen', '1');
    localStorage.setItem('interface-language', value);
  }, language);
  let failedDownloads = 0;
  await context.route(`${origin}/api/**`, route => {
    const headers = { 'access-control-allow-origin': '*', 'content-type': 'application/json' };
    if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204,
      headers: { ...headers, 'access-control-allow-methods': 'GET, POST, DELETE',
        'access-control-allow-headers': 'authorization, content-type, x-bor-demo-invitation' } });
    if (new URL(route.request().url()).pathname.includes('/ambony')) failedDownloads++;
    return route.fulfill({ status: 503, headers, json: { error: 'synthetic_geodata_unavailable' } });
  });
  await page.goto(url);
  await expect(page.getByRole('heading', { name: t('Co się stało?'), exact: true })).toBeVisible();
  const findings = JSON.parse(await readFile(new URL('./computed-findings.json', import.meta.url), 'utf8'));
  const id = '356ad090-8888-4888-8888-888888888888';
  const at = '2026-10-05T12:00:00Z';
  await page.evaluate(async ({ id, at, findings }) => {
    const db = await new Promise<IDBDatabase>(resolve => {
      const request = indexedDB.open('bor-czuwa'); request.onsuccess = () => resolve(request.result);
    });
    const tx = db.transaction('reports', 'readwrite');
    tx.objectStore('reports').put({ report: { id, event_type: 'person_with_gun', captured_at: at,
      occurred_at: { at, source: 'device_clock', coarseness: 'exact' }, species: null, photo_sha256: [], has_note: false,
      device_fix: { lat: 53.403481, lon: 22.658699, accuracy_m: 8, at }, incident_location: { lat: 53.403481, lon: 22.658699, source: 'device_fix' },
      app_version: '0.1.3', privacy_policy_version: '1', terms_of_use_version: '1', token_sha256: '0'.repeat(64) },
      token: '1'.repeat(64), findings, events: [{ kind: 'created', at }, { kind: 'synced', at }], notices: [] });
    await new Promise<void>(resolve => { tx.oncomplete = () => resolve(); }); db.close();
  }, { id, at, findings });
  await page.goto(`${url}/?screen=report&report=${id}`);
  await page.getByRole('button', { name: t('Skąd te wyniki') }).click();
  const sheet = page.getByRole('dialog');
  const download = sheet.getByRole('link', { name: t('Pobierz zbiór oznaczonych ambon (ODbL)') });
  await download.click();
  await expect(sheet.getByRole('alert')).toContainText(language === 'pl'
    ? 'Nie udało się pobrać zbioru ambon. Sprawdź połączenie i kod zaproszenia w Menu.'
    : 'Could not download the stand dataset. Check your connection and invitation code in Menu.');
  await expect(download).toHaveAttribute('aria-describedby', 'ambona-download-error');
  await expect(sheet).toBeVisible();
  expect(failedDownloads).toBe(1);
});
