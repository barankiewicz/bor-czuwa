import { test, expect, type Page } from '@playwright/test';
import { createHash } from 'node:crypto';
import { blankTiles, finishFromWhen, settled } from './stages.ts';
import type { FindingsResult } from '../../src/lib/report.ts';
import { homeArea } from '../../src/lib/home-area.ts';

test.use({ serviceWorkers: 'block' });
const id = '351ad090-8888-4888-8888-888888888888';
const at = '2026-10-04T12:00:00Z';
const challenge = { algorithm: 'SHA-256', challenge: createHash('sha256').update('fixture0').digest('hex'), salt: 'fixture', signature: 'fixture-signature', maxnumber: 1 };
const fixture = () => ({
  report: { id, event_type: 'shot', captured_at: at, occurred_at: { at, source: 'device_clock', coarseness: 'exact' },
    device_fix: null, incident_location: homeArea({ lat: 53.403481, lon: 22.658699 }, 4), species: null, has_note: false,
    app_version: '0.1.0', privacy_policy_version: '1', terms_of_use_version: '1', token_sha256: '0'.repeat(64) },
  token: '1'.repeat(64), events: [{ kind: 'created', at }, { kind: 'synced', at }], findings: { status: 'pending' } as FindingsResult
});

async function seed(page: Page, local: { report: { id: string } }) {
  await page.goto('/');
  await page.getByRole('heading', { name: 'Co się stało?' }).waitFor();
  await page.evaluate(async value => {
    const request = indexedDB.open('bor-czuwa');
    const db = await new Promise<IDBDatabase>((resolve, reject) => { request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
    const transaction = db.transaction('reports', 'readwrite');
    transaction.objectStore('reports').put(value);
    await new Promise<void>((resolve, reject) => { transaction.oncomplete = () => resolve(); transaction.onerror = () => reject(transaction.error); });
    db.close();
  }, local);
  await page.goto(`/?screen=report&report=${local.report.id}`);
  await page.getByRole('heading', { name: 'Zgłoszenie', exact: true }).waitFor();
  await settled(page);
}

test.beforeEach(async ({ page }) => {
  await blankTiles(page);
  await page.route('**/api/challenge', route => route.fulfill({ json: challenge }));
});

for (const missingAt of ['findings', 'events'] as const) test(`restored server reaccepts the same home Report after ${missingAt} 404 and resends Notice confirmations in order`, async ({ page }) => {
  const noticeId = '551ad090-8888-4888-8888-888888888888';
  const base = { notice_id: noticeId, recipient_kind: 'police' as const, unit_id: 'police.monki', template_version: '1', directory_version: '1', at };
  const local = { ...fixture(), notices: [{ id: noticeId, recipient: { kind: 'police', id: 'police.monki', name: 'Policja', email: null }, others: [], variant: 'unsigned', events: [
    { ...base, id: '651ad090-8888-4888-8888-888888888888', kind: 'notice_composed', synced: true },
    { ...base, id: '751ad090-8888-4888-8888-888888888888', kind: 'handed_to_mail_client', refused: true },
    { ...base, id: '851ad090-8888-4888-8888-888888888888', kind: 'confirmed_by_reporter', refused: true }
  ] }] };
  if (missingAt === 'events') {
    local.findings = { status: 'failed', reason: 'fixture' };
    delete (local.notices[0].events[2] as { refused?: boolean }).refused;
  }
  const uploads: Record<string, unknown>[] = [], events: Record<string, unknown>[] = [];
  let restored = false;
  await page.route('**/api/reports', route => { uploads.push(route.request().postDataJSON()); restored = true; return route.fulfill({ status: 201, json: {} }); });
  await page.route('**/api/reports/*/findings', route => route.fulfill(restored ? { json: { status: 'failed', reason: 'fixture' } } : { status: 404, json: { error: 'not_found' } }));
  await page.route('**/api/reports/*/events', route => {
    if (!restored) return route.fulfill({ status: 404, json: { error: 'not_found' } });
    events.push(route.request().postDataJSON());
    return route.fulfill({ status: 204 });
  });
  await seed(page, local);
  await expect.poll(() => uploads.length).toBe(1);
  const { solution: _, ...sent } = uploads[0];
  expect(sent).toEqual(local.report);
  expect(JSON.stringify(sent)).not.toMatch(/53\.403481|22\.658699|privateFix|signer/);
  await expect.poll(() => events.length).toBe(3);
  expect(events.map(event => event.kind)).toEqual(['notice_composed', 'handed_to_mail_client', 'confirmed_by_reporter']);
  expect(events.map(event => event.id)).toEqual(local.notices[0].events.map(event => event.id));
  expect(events.every(event => event.synced === undefined && event.refused === undefined)).toBe(true);
  await expect(page.getByRole('status').filter({ hasText: /^Zapisano na serwerze\./ })).toBeVisible();
});

test('changed Findings refresh without starting or skipping a View Transition', async ({ page }) => {
  await page.addInitScript(() => {
    const state = { starts: 0, skips: 0 };
    (window as unknown as { syncTransitions: typeof state }).syncTransitions = state;
    const start = document.startViewTransition.bind(document);
    document.startViewTransition = (...args) => {
      state.starts++;
      const transition = start(...args);
      const skip = transition.skipTransition.bind(transition);
      transition.skipTransition = () => { state.skips++; skip(); };
      return transition;
    };
  });
  let release!: () => void;
  const ready = new Promise<void>(resolve => { release = resolve; });
  await page.route('**/api/reports/*/findings', async route => {
    await ready;
    await route.fulfill({ json: { status: 'failed', reason: 'fixture' } });
  });
  await seed(page, fixture());
  await page.evaluate(() => {
    const state = (window as unknown as { syncTransitions: { starts: number; skips: number } }).syncTransitions;
    state.starts = 0;
    state.skips = 0;
  });
  release();
  await expect(page.locator('section.findings').getByText('Nie udało się obliczyć ustaleń. Możesz przygotować powiadomienie bez pomiarów.', { exact: true })).toBeVisible();
  expect(await page.evaluate(() => (window as unknown as { syncTransitions: unknown }).syncTransitions)).toEqual({ starts: 0, skips: 0 });
});

test('pending Findings back off without Report writes or View Transitions', async ({ page }) => {
  const polls: number[] = [];
  await page.clock.install({ time: new Date(at) });
  await page.clock.pauseAt(new Date(at));
  await page.route('**/api/reports/*/findings', route => { polls.push(Date.now()); return route.fulfill({ json: { status: 'pending' } }); });
  await page.addInitScript(() => {
    const state = { writes: 0, transitions: 0, waits: [] as number[] };
    (window as unknown as { syncObservation: typeof state }).syncObservation = state;
    const put = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function (...args) { if (this.name === 'reports') state.writes++; return put.apply(this, args); };
    const start = document.startViewTransition?.bind(document);
    if (start) document.startViewTransition = (...args) => { state.transitions++; return start(...args); };
    const timeout = window.setTimeout.bind(window);
    Object.defineProperty(window, 'setTimeout', { value: (handler: TimerHandler, delay?: number, ...args: unknown[]) => {
      if (delay && delay >= 1000 && delay <= 30000) state.waits.push(delay);
      return timeout(handler, delay, ...args);
    } });
  });
  await seed(page, fixture());
  await expect.poll(() => polls.length).toBe(1);
  await page.evaluate(() => { const state = (window as unknown as { syncObservation: { writes: number; transitions: number } }).syncObservation; state.writes = 0; state.transitions = 0; });
  for (const delay of [2000, 4000, 8000, 16000, 30000]) {
    await expect.poll(() => page.evaluate(() => (window as unknown as { syncObservation: { waits: number[] } }).syncObservation.waits.at(-1))).toBe(delay);
    const previous = polls.length;
    await page.clock.fastForward(delay - 1);
    expect(polls.length).toBe(previous);
    await page.clock.fastForward(1);
    await expect.poll(() => polls.length).toBe(previous + 1);
  }
  expect(await page.evaluate(() => {
    const { writes, transitions } = (window as unknown as { syncObservation: { writes: number; transitions: number } }).syncObservation;
    return { writes, transitions };
  })).toEqual({ writes: 0, transitions: 0 });
  await expect(page.locator('section.findings').getByText('Czekamy na pomiary.', { exact: true })).toBeVisible();
});

test('missing AbortSignal.any still uploads a captured home Report', async ({ page, context }) => {
  await context.setGeolocation({ latitude: 53.403481, longitude: 22.658699, accuracy: 12 });
  await page.addInitScript(() => Object.defineProperty(AbortSignal, 'any', { value: undefined }));
  let sent: Record<string, unknown> | undefined;
  await page.route('**/api/reports', route => { sent = route.request().postDataJSON(); return route.fulfill({ status: 201, json: {} }); });
  await page.route('**/api/reports/*/findings', route => route.fulfill({ json: { status: 'pending' } }));
  await page.goto('/');
  await page.getByRole('button', { name: 'Strzał', exact: true }).click();
  await finishFromWhen(page, true);
  await page.getByRole('button', { name: 'Zapisz zgłoszenie', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: /^Zapisano na serwerze\./ })).toBeVisible();
  expect(sent?.device_fix).toBeNull();
  expect(sent?.incident_location).toMatchObject({ precise_fix_withheld: 'home_privacy' });
});

test('blocked local preferences remain visible after the introduction', async ({ page }) => {
  await page.addInitScript(() => {
    Storage.prototype.getItem = () => { throw new DOMException('Storage is blocked', 'SecurityError'); };
  });
  await page.goto('/');
  await page.getByRole('button', { name: 'Dalej bez lokalizacji', exact: true }).click();
  await page.getByRole('heading', { name: 'Co się stało?' }).waitFor();
  await settled(page);
  await expect(page.getByRole('alert')).toHaveText('Nie udało się zapamiętać ustawień. Przy następnym uruchomieniu aplikacja może zapytać o nie ponownie.');
});

test('a slower old refresh cannot overwrite a newer local Report', async ({ page }) => {
  const local = fixture();
  local.findings = { status: 'failed', reason: 'fixture' };
  await seed(page, local);
  await page.evaluate(() => {
    Object.defineProperty(navigator, 'onLine', { get: () => false });
    window.dispatchEvent(new Event('offline'));
    const reads = new WeakSet<IDBRequest>();
    const getAll = IDBObjectStore.prototype.getAll;
    IDBObjectStore.prototype.getAll = function (...args) {
      const request = getAll.apply(this, args);
      if (this.name === 'reports') reads.add(request);
      return request;
    };
    let held = false;
    const listen = IDBRequest.prototype.addEventListener;
    IDBRequest.prototype.addEventListener = function (type: string, listener: EventListenerOrEventListenerObject, options?: boolean | AddEventListenerOptions) {
      if (type !== 'success' || !reads.has(this) || held || typeof listener !== 'function') return listen.call(this, type, listener, options);
      held = true;
      return listen.call(this, type, event => {
        (window as unknown as { releaseOldRefresh: () => void }).releaseOldRefresh = () => listener.call(this, event);
      }, options);
    };
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await expect.poll(() => page.evaluate(() => typeof (window as unknown as { releaseOldRefresh?: unknown }).releaseOldRefresh)).toBe('function');
  await page.evaluate(async reportId => {
    const open = indexedDB.open('bor-czuwa');
    const db = await new Promise<IDBDatabase>(resolve => { open.onsuccess = () => resolve(open.result); });
    const transaction = db.transaction('reports', 'readwrite');
    const store = transaction.objectStore('reports');
    const read = store.get(reportId);
    read.onsuccess = () => { const local = read.result; local.events = local.events.filter((event: { kind: string }) => event.kind !== 'synced'); store.put(local); };
    await new Promise<void>(resolve => { transaction.oncomplete = () => resolve(); });
    db.close();
    document.dispatchEvent(new Event('visibilitychange'));
  }, id);
  await expect(page.getByText('Zapisano na telefonie. Czeka na połączenie.', { exact: true })).toBeVisible();
  await settled(page);
  await page.evaluate(() => (window as unknown as { releaseOldRefresh: () => void }).releaseOldRefresh());
  await settled(page);
  await expect(page.getByText('Zapisano na telefonie. Czeka na połączenie.', { exact: true })).toBeVisible();
  await expect(page.getByRole('status').filter({ hasText: /^Zapisano na serwerze\./ })).toHaveCount(0);
});
