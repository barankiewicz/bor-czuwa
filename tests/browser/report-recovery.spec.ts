import { test, expect, type Page, type Route } from '@playwright/test';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { blankTiles, settled } from './stages.ts';
import { localReport, localWithdrawals } from './local-reports.ts';
import type { FindingsResult } from '../../src/lib/report.ts';
import { homeArea } from '../../src/lib/home-area.ts';

// A Report the server already measured and whose Notice events all arrived, so the old
// worker never sent anything that could discover the server losing it.
test.use({ serviceWorkers: 'block' });
const id = '352ad090-8888-4888-8888-888888888888';
const noticeId = '552ad090-8888-4888-8888-888888888888';
const at = '2026-10-05T12:00:00Z';
const computed = JSON.parse(await readFile(new URL('./computed-findings.json', import.meta.url), 'utf8')) as FindingsResult;
const challenge = { algorithm: 'SHA-256', challenge: createHash('sha256').update('fixture0').digest('hex'), salt: 'fixture', signature: 'fixture-signature', maxnumber: 1 };
// The dwelling fact row on the Report screen, which keeps its value while a lost Report is saved again.
const measurement = '140 m';
const base = { notice_id: noticeId, recipient_kind: 'police' as const, unit_id: 'police.monki', template_version: '1', directory_version: '1', at };
const fixture = () => ({
  report: { id, event_type: 'shot', captured_at: at, occurred_at: { at, source: 'device_clock', coarseness: 'exact' },
    device_fix: null, incident_location: homeArea({ lat: 53.403481, lon: 22.658699 }, 4), species: null, has_note: false,
    app_version: '0.1.0', privacy_policy_version: '1', terms_of_use_version: '1', token_sha256: '0'.repeat(64) },
  privateFix: { lat: 53.403481, lon: 22.658699, accuracy_m: 8, at },
  note: 'prywatna notatka', token: '1'.repeat(64), events: [{ kind: 'created', at }, { kind: 'synced', at }], findings: computed,
  notices: [{ id: noticeId, recipient: { kind: 'police', id: 'police.monki', name: 'Policja', email: null }, others: [], variant: 'unsigned', events: [
    { ...base, id: '652ad090-8888-4888-8888-888888888888', kind: 'notice_composed', synced: true },
    { ...base, id: '752ad090-8888-4888-8888-888888888888', kind: 'handed_to_mail_client', synced: true },
    { ...base, id: '852ad090-8888-4888-8888-888888888888', kind: 'confirmed_by_reporter', synced: true }
  ], outcomes: [{ id: '952ad090-8888-4888-8888-888888888888', kind: 'outcome_reported', notice_id: noticeId, recipient_kind: 'police',
    unit_id: 'police.monki', outcome: 'no_answer_yet', observed_on: '2026-10-05', at, synced: true }] }]
});

/** A second measured Report, saved a minute after the first and without Notices. */
const laterReport = (reportId: string) => ({ ...fixture(), report: { ...fixture().report, id: reportId }, notices: [],
  events: [{ kind: 'created', at: '2026-10-05T12:01:00Z' }, { kind: 'synced', at: '2026-10-05T12:01:00Z' }] });

async function seed(page: Page, local: ReturnType<typeof fixture> | ReturnType<typeof fixture>[] = fixture(),
  { withdrawals = [] as { id: string; token: string; at: string }[], open = id } = {}) {
  await page.goto('/');
  await page.getByRole('heading', { name: 'Co się stało?' }).waitFor();
  await page.evaluate(async ({ value, pendingWithdrawals }) => {
    const request = indexedDB.open('bor-czuwa');
    const db = await new Promise<IDBDatabase>((resolve, reject) => { request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
    const transaction = db.transaction(['reports', 'withdrawals'], 'readwrite');
    for (const item of Array.isArray(value) ? value : [value]) transaction.objectStore('reports').put(item);
    for (const item of pendingWithdrawals) transaction.objectStore('withdrawals').put(item);
    await new Promise<void>((resolve, reject) => { transaction.oncomplete = () => resolve(); transaction.onerror = () => reject(transaction.error); });
    db.close();
  }, { value: local, pendingWithdrawals: withdrawals });
  await page.goto(`/?screen=report&report=${open}`);
  await page.getByRole('heading', { name: 'Zgłoszenie', exact: true }).waitFor();
  await settled(page);
}

const stored = (page: Page, reportId = id) => localReport(page, reportId);

/** Counts Report writes, View Transitions and changes to the Report's status rows. */
async function observe(page: Page) {
  await page.addInitScript(() => {
    const state = { writes: 0, transitions: 0, mutations: 0 };
    (window as unknown as { recovery: typeof state }).recovery = state;
    const put = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function (...args) { if (this.name === 'reports') state.writes++; return put.apply(this, args); };
    const start = document.startViewTransition?.bind(document);
    if (start) document.startViewTransition = (...args) => { state.transitions++; return start(...args); };
    new MutationObserver(records => {
      if (records.some(record => (record.target as Element).closest?.('.report-status') || record.target.parentElement?.closest('.report-status'))) state.mutations++;
    }).observe(document, { subtree: true, childList: true, characterData: true, attributes: true });
  });
}
const observed = (page: Page) => page.evaluate(() => (window as unknown as { recovery: { writes: number; transitions: number; mutations: number } }).recovery);
const resetObserved = (page: Page) => page.evaluate(() => Object.assign((window as unknown as { recovery: object }).recovery, { writes: 0, transitions: 0, mutations: 0 }));

/** A server that lost the Report until it is uploaded again. */
function lostServer(page: Page) {
  const server = { probes: 0, uploads: [] as Record<string, unknown>[], events: [] as Record<string, unknown>[], restored: false };
  void page.route('**/api/reports', route => {
    server.uploads.push(route.request().postDataJSON());
    server.restored = true;
    return route.fulfill({ status: 201, json: {} });
  });
  void page.route('**/api/reports/*/findings', route => {
    server.probes++;
    return route.fulfill(server.restored ? { json: { status: 'pending' } } : { status: 404, json: { error: 'not_found' } });
  });
  void page.route('**/api/reports/*/events', route => {
    if (!server.restored) return route.fulfill({ status: 404, json: { error: 'not_found' } });
    server.events.push(route.request().postDataJSON());
    return route.fulfill({ status: 201, json: {} });
  });
  return server;
}

const statusList = (page: Page) => page.getByRole('list', { name: 'Stan zgłoszenia' });

test.beforeEach(async ({ page }) => {
  await blankTiles(page);
  await page.route('**/api/challenge', route => route.fulfill({ json: challenge }));
});

test('opening a measured Report finds the server lost it and saves it again with its Findings and Notice history', async ({ page }) => {
  const server = lostServer(page);
  // Hold the proof until the recovering state is on screen, so its end has something to announce.
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  await page.unroute('**/api/challenge');
  await page.route('**/api/challenge', async route => { await held; return route.fulfill({ json: challenge }); });
  await seed(page);
  await expect(statusList(page).getByText('Zgłoszenia zabrakło na serwerze. Telefon zapisze je tam ponownie sam.', { exact: true })).toBeVisible();
  release();
  await expect.poll(() => server.uploads.length).toBe(1);
  const local = fixture();
  const { solution: _, ...sent } = server.uploads[0];
  expect(sent).toEqual(local.report);
  expect(JSON.stringify(sent)).not.toMatch(/53\.403481|22\.658699|privateFix|prywatna|signer/);
  await expect.poll(() => server.events.length).toBe(4);
  expect(server.events.map(event => event.id)).toEqual([...local.notices[0].events, ...local.notices[0].outcomes].map(event => event.id));
  expect(server.events.map(event => event.kind)).toEqual(['notice_composed', 'handed_to_mail_client', 'confirmed_by_reporter', 'outcome_reported']);
  await expect(statusList(page).getByText('Zgłoszenie jest znowu zapisane na serwerze.', { exact: false })).toHaveCount(0);
  await expect(page.getByRole('status').filter({ hasText: /^Zapisano na serwerze\./ })).toBeVisible();
  await expect(page.locator('[data-fact="dwelling"] .fact-value b').getByText(measurement, { exact: true })).toBeVisible();
  await expect(page.locator('p.sr-only[aria-live]').filter({ hasText: 'Zgłoszenie jest znowu zapisane na serwerze.' })).toHaveCount(1);
  const after = await stored(page);
  expect(after.findings).toEqual(computed);
  expect(after.note).toBe('prywatna notatka');
  expect(after.privateFix).toEqual(local.privateFix);
  expect(after.token).toBe(local.token);
  expect(after.server_lost).toBeUndefined();
});

test('an unchanged probe writes nothing, animates nothing and runs once per launch and at most hourly', async ({ page }) => {
  await observe(page);
  await page.clock.install();
  let probes = 0;
  await page.route('**/api/reports/*/findings', route => { probes++; return route.fulfill({ json: computed }); });
  await page.route('**/api/reports', route => { throw new Error(`unexpected upload ${route.request().url()}`); });
  await seed(page);
  await expect.poll(() => probes).toBe(1);
  await settled(page);
  await resetObserved(page);
  // Returning to the app within the hour sends nothing.
  await page.clock.fastForward('30:00');
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  await page.clock.fastForward('29:00');
  expect(probes).toBe(1);
  expect((await observed(page)).writes).toBe(0);
  // No timer polls while the app stays open: only a resume or reconnect after the hour checks again.
  await page.clock.fastForward('02:00');
  expect(probes).toBe(1);
  await settled(page);
  await resetObserved(page);
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  await expect.poll(() => probes).toBe(2);
  await settled(page);
  expect(await observed(page)).toEqual({ writes: 0, transitions: 0, mutations: 0 });
  // A restart checks again at once.
  await page.reload();
  await page.getByRole('heading', { name: 'Zgłoszenie', exact: true }).waitFor();
  await expect.poll(() => probes).toBe(3);
});

test('pending Findings timers never probe an otherwise healthy measured Report', async ({ page }) => {
  await page.clock.install();
  const pendingId = '392ad090-8888-4888-8888-888888888888';
  const pending = laterReport(pendingId);
  pending.findings = { status: 'pending' } as FindingsResult;
  const probes: Record<string, number> = { [id]: 0, [pendingId]: 0 };
  await page.route('**/api/reports/*/findings', route => {
    const reportId = route.request().url().split('/').at(-2)!;
    probes[reportId]++;
    return route.fulfill({ json: reportId === pendingId ? { status: 'pending' } : computed });
  });
  await seed(page, [fixture(), pending]);
  await expect.poll(() => probes[id]).toBe(1);
  await expect.poll(() => probes[pendingId]).toBeGreaterThan(0);
  const before = probes[pendingId];
  await page.clock.fastForward('01:01:00');
  await expect.poll(() => probes[pendingId]).toBeGreaterThan(before);
  expect(probes[id]).toBe(1);
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  await expect.poll(() => probes[id]).toBe(2);
});

test('resume during an aborted IndexedDB pass retains the requested presence check', async ({ page }) => {
  await page.clock.install();
  let probes = 0;
  await page.route('**/api/reports/*/findings', route => {
    probes++;
    return route.fulfill({ json: computed });
  });
  await seed(page);
  await expect.poll(() => probes).toBe(1);
  await page.addInitScript(() => {
    const original = IDBObjectStore.prototype.getAll;
    const state = window as typeof window & { heldPresenceRead?: boolean; releasePresenceRead?: () => void };
    let withdrawalReads = 0;
    IDBObjectStore.prototype.getAll = function (...args) {
      const request = original.apply(this, args);
      if (this.name === 'withdrawals' && ++withdrawalReads === 2) {
        request.addEventListener('success', event => {
          event.stopImmediatePropagation();
          state.heldPresenceRead = true;
          state.releasePresenceRead = () => request.dispatchEvent(new Event('success'));
        }, { once: true });
      }
      return request;
    };
  });
  await page.goto('/');
  await expect.poll(() => page.evaluate(() =>
    (window as typeof window & { heldPresenceRead?: boolean }).heldPresenceRead)).toBe(true);
  probes = 0;
  await page.evaluate(() => {
    let visible = false;
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => visible ? 'visible' : 'hidden' });
    document.dispatchEvent(new Event('visibilitychange'));
    visible = true;
    document.dispatchEvent(new Event('visibilitychange'));
    (window as typeof window & { releasePresenceRead: () => void }).releasePresenceRead();
  });
  await expect.poll(async () => {
    await page.clock.runFor(1500);
    return probes;
  }, { timeout: 5000 }).toBe(1);
});

test('a transient storage failure does not consume a requested presence check', async ({ page }) => {
  await page.clock.install();
  let probes = 0;
  await page.route('**/api/reports/*/findings', route => {
    probes++;
    return route.fulfill({ json: computed });
  });
  await seed(page);
  await expect.poll(() => probes).toBe(1);
  await page.addInitScript(() => {
    const original = IDBObjectStore.prototype.getAll;
    let withdrawalReads = 0;
    IDBObjectStore.prototype.getAll = function (...args) {
      if (this.name === 'withdrawals' && ++withdrawalReads === 2) {
        (window as typeof window & { presenceStorageFailed?: boolean }).presenceStorageFailed = true;
        throw new DOMException('Synthetic transient read failure', 'UnknownError');
      }
      return original.apply(this, args);
    };
  });
  probes = 0;
  await page.goto('/');
  await expect.poll(() => page.evaluate(() =>
    (window as typeof window & { presenceStorageFailed?: boolean }).presenceStorageFailed)).toBe(true);
  await expect.poll(async () => {
    await page.clock.runFor(1500);
    return probes;
  }, { timeout: 5000 }).toBe(1);
});

test('a rate-limited or failing probe retries later without touching the Report, then recovers', async ({ page }) => {
  await observe(page);
  await page.clock.install();
  const replies: (() => Parameters<Route['fulfill']>[0])[] = [
    () => ({ status: 429, headers: { 'retry-after': '20' }, json: { error: 'try_again' } }),
    () => ({ status: 503, json: { error: 'temporarily_unavailable' } })
  ];
  const server = { probes: 0, uploads: 0, restored: false };
  await page.route('**/api/reports/*/findings', route => {
    server.probes++;
    const reply = replies.shift();
    if (reply) return route.fulfill(reply());
    return route.fulfill(server.restored ? { json: { status: 'pending' } } : { status: 404, json: { error: 'not_found' } });
  });
  await page.route('**/api/reports', route => { server.uploads++; server.restored = true; return route.fulfill({ status: 201, json: {} }); });
  await page.route('**/api/reports/*/events', route => route.fulfill({ status: 200, json: {} }));
  await seed(page);
  await expect.poll(() => server.probes).toBe(1);
  await settled(page);
  await resetObserved(page);
  await page.clock.fastForward('00:19');
  expect(server.probes).toBe(1);
  await page.clock.fastForward('00:02');
  await expect.poll(() => server.probes).toBe(2);
  expect(await observed(page)).toEqual({ writes: 0, transitions: 0, mutations: 0 });
  await expect(statusList(page).getByText(/Ponowna próba|niedostępny|ograniczył/)).toHaveCount(0);
  // The failed probe waits 30 s, not the worker's second-scale retry.
  await page.clock.fastForward('00:29');
  expect(server.probes).toBe(2);
  await page.clock.fastForward('00:02');
  await expect.poll(() => server.uploads).toBe(1);
  await expect(page.getByRole('status').filter({ hasText: /^Zapisano na serwerze\./ })).toBeVisible();
  await expect(page.locator('[data-fact="dwelling"] .fact-value b').getByText(measurement, { exact: true })).toBeVisible();
});

test('recovery keeps Findings visible, explains itself offline and finishes after reconnecting', async ({ page, context }) => {
  const server = lostServer(page);
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  await page.unroute('**/api/challenge');
  await page.route('**/api/challenge', async route => { await held; return route.fulfill({ json: challenge }); });
  await seed(page);
  await expect(statusList(page).getByText('Zgłoszenia zabrakło na serwerze. Telefon zapisze je tam ponownie sam.', { exact: true })).toBeVisible();
  await expect(page.locator('[data-fact="dwelling"] .fact-value b').getByText(measurement, { exact: true })).toBeVisible();
  expect((await stored(page)).server_lost).toBe(true);
  // The transport itself goes down, not only navigator.onLine.
  await context.setOffline(true);
  await expect(statusList(page).getByText('Zgłoszenia zabrakło na serwerze. Telefon zapisze je tam ponownie, gdy wróci internet.', { exact: true })).toBeVisible();
  expect(await page.evaluate(() => fetch('/api/health').then(() => 'reached', () => 'unreachable'))).toBe('unreachable');
  release();
  expect(server.uploads).toHaveLength(0);
  expect((await stored(page)).server_lost).toBe(true);
  await context.setOffline(false);
  await expect.poll(() => server.uploads.length).toBe(1);
  await expect(page.getByRole('status').filter({ hasText: /^Zapisano na serwerze\./ })).toBeVisible();
  await page.getByRole('button', { name: 'Wróć', exact: true }).click();
  await expect(page.getByText('Zapisuje się ponownie na serwerze', { exact: true })).toHaveCount(0);
});

test('an interrupted recovery resumes after restart without duplicating Notice events', async ({ page }) => {
  const server = lostServer(page);
  await page.unroute('**/api/challenge');
  await page.route('**/api/challenge', () => { /* never answers before the restart */ });
  await seed(page);
  await expect.poll(async () => (await stored(page))?.server_lost).toBe(true);
  await page.goto('/?screen=library');
  await expect(page.getByText('Zapisuje się ponownie na serwerze', { exact: true })).toBeVisible();
  await page.unroute('**/api/challenge');
  await page.route('**/api/challenge', route => route.fulfill({ json: challenge }));
  await page.goto(`/?screen=report&report=${id}`);
  await expect.poll(() => server.uploads.length).toBe(1);
  await expect.poll(() => server.events.length).toBe(4);
  await page.reload();
  await page.getByRole('heading', { name: 'Zgłoszenie', exact: true }).waitFor();
  await expect(page.getByRole('status').filter({ hasText: /^Zapisano na serwerze\./ })).toBeVisible();
  expect(new Set(server.events.map(event => event.id)).size).toBe(4);
  expect(server.events).toHaveLength(4);
});

test('withdrawing during recovery never uploads the Report again', async ({ page }) => {
  const server = lostServer(page);
  const deletes: string[] = [];
  await page.route(`**/api/reports/${id}`, route => { deletes.push(route.request().method()); return route.fulfill({ status: 204 }); });
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  let asked = 0;
  await page.unroute('**/api/challenge');
  await page.route('**/api/challenge', async route => { asked++; await held; return route.fulfill({ json: challenge }); });
  await seed(page);
  await expect.poll(() => asked).toBe(1);
  await page.getByRole('button', { name: 'Wycofaj zgłoszenie' }).click();
  await page.getByRole('group', { name: 'Wycofać to zgłoszenie?' }).getByRole('button', { name: 'Wycofaj', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Moje zapisy' })).toBeVisible();
  release();
  await expect.poll(() => deletes).toEqual(['DELETE']);
  await expect(page.locator('#withdrawal-result')).toHaveText('Zgłoszenie wycofane. Dane usunięto z telefonu i serwera.');
  expect(server.uploads).toHaveLength(0);
  expect(await stored(page)).toBeUndefined();
});

test('a failing check on one Report never holds back recovery of the next', async ({ page }) => {
  await page.clock.install();
  const other = '362ad090-8888-4888-8888-888888888888';
  const later = laterReport(other);
  const probes: Record<string, number> = { [id]: 0, [other]: 0 };
  const uploads: string[] = [];
  await page.route('**/api/reports/*/findings', route => {
    const reportId = route.request().url().split('/').at(-2)!;
    probes[reportId]++;
    // The first Report's check keeps failing; the second Report is gone from the server.
    if (reportId === id) return route.fulfill({ status: 503, json: { error: 'temporarily_unavailable' } });
    return route.fulfill(uploads.includes(other) ? { json: computed } : { status: 404, json: { error: 'not_found' } });
  });
  await page.route('**/api/reports', route => { uploads.push(route.request().postDataJSON().id); return route.fulfill({ status: 201, json: {} }); });
  await page.route('**/api/reports/*/events', route => route.fulfill({ status: 201, json: {} }));
  await seed(page, [fixture(), later]);
  await expect.poll(() => uploads).toEqual([other]);
  expect(probes[other]).toBe(1);
  // The failing Report keeps its own backoff: 30 s, then 60 s.
  expect(probes[id]).toBe(1);
  await page.clock.fastForward('00:31');
  await expect.poll(() => probes[id]).toBe(2);
  await page.clock.fastForward('01:01');
  await expect.poll(() => probes[id]).toBe(3);
  expect(uploads).toEqual([other]);
});

test('a re-upload the server committed before the phone was stopped is not duplicated after restart', async ({ page }) => {
  // The server keeps Reports by ID: a second upload of a stored ID is a replay.
  const serverReports: Record<string, Record<string, unknown>> = {};
  const answers: number[] = [];
  const events: Record<string, unknown>[] = [];
  let committed!: () => void;
  const commit = new Promise<void>(resolve => { committed = resolve; });
  let stopBeforeAnswer = true;
  await page.route('**/api/reports', async route => {
    const body = route.request().postDataJSON();
    const replay = !!serverReports[body.id];
    serverReports[body.id] = body;
    if (stopBeforeAnswer) { committed(); return; } // the phone never hears back
    answers.push(replay ? 200 : 201);
    return route.fulfill({ status: replay ? 200 : 201, json: { id: body.id } });
  });
  await page.route('**/api/reports/*/findings', route => route.fulfill(serverReports[id] ? { json: { status: 'pending' } } : { status: 404, json: { error: 'not_found' } }));
  await page.route('**/api/reports/*/events', route => {
    if (!serverReports[id]) return route.fulfill({ status: 404, json: { error: 'not_found' } });
    events.push(route.request().postDataJSON());
    return route.fulfill({ status: 201, json: {} });
  });
  await seed(page);
  await commit;
  expect((await stored(page)).server_lost).toBe(true);
  stopBeforeAnswer = false;
  await page.reload();
  await page.getByRole('heading', { name: 'Zgłoszenie', exact: true }).waitFor();
  await expect(page.getByRole('status').filter({ hasText: /^Zapisano na serwerze\./ })).toBeVisible();
  expect(Object.keys(serverReports)).toEqual([id]);
  expect(answers).toEqual([200]);
  const after = await stored(page);
  expect(after.findings).toEqual(computed);
  expect(after.server_lost).toBeUndefined();
  await expect.poll(() => events.length).toBe(4);
  expect(new Set(events.map(event => event.id)).size).toBe(4);
});

// Other request failures stay isolated; an observed Findings 429 shares only its read wait.
for (const [failing, kind] of [['Findings poll', 503], ['Findings poll', 429], ['Notice event', 503], ['upload', 503], ['upload', 429]] as const) {
  const sharedReadWait = failing === 'Findings poll' && kind === 429;
  test(sharedReadWait ? 'a Findings 429 defers later presence until its header deadline, then repairs the lost Report and Notice history'
    : `an earlier Report's failing ${failing} (${kind}) never blocks finding a later Report the server lost`, async ({ page }) => {
    const clockTime = new Date('2026-10-05T13:00:00Z');
    await page.clock.install(sharedReadWait ? { time: clockTime } : undefined);
    if (sharedReadWait) await page.clock.pauseAt(clockTime);
    const other = '372ad090-8888-4888-8888-888888888888';
    const earlier = fixture();
    if (failing === 'Findings poll') earlier.findings = { status: 'pending' } as FindingsResult;
    if (failing === 'Notice event') delete (earlier.notices[0].outcomes[0] as { synced?: true }).synced;
    if (failing === 'upload') earlier.events = [{ kind: 'created', at }];
    const later = { ...laterReport(other), ...(sharedReadWait ? { notices: fixture().notices } : {}) };
    if (sharedReadWait) for (const notice of later.notices) {
      notice.id = notice.id.replace(/888888888888$/, '777777777777');
      for (const event of [...notice.events, ...notice.outcomes]) {
        event.id = event.id.replace(/888888888888$/, '777777777777');
        event.notice_id = notice.id;
      }
    }
    const requests: Record<string, number> = { [id]: 0, [other]: 0 };
    const uploads: string[] = [];
    const uploadedBodies: Record<string, unknown>[] = [];
    const events: Record<string, unknown>[] = [];
    const fail = (route: Route) => route.fulfill(kind === 429
      ? { status: 429, headers: { 'retry-after': '60' }, json: { error: 'try_again' } }
      : { status: 503, json: { error: 'temporarily_unavailable' } });
    await page.route('**/api/reports/*/findings', route => {
      const reportId = route.request().url().split('/').at(-2)!;
      requests[reportId]++;
      if (reportId === id) return failing === 'Findings poll' ? fail(route) : route.fulfill({ json: computed });
      return route.fulfill(uploads.includes(other) ? { json: computed } : { status: 404, json: { error: 'not_found' } });
    });
    await page.route('**/api/reports/*/events', route => {
      if (route.request().url().includes(id)) { requests[id]++; return fail(route); }
      events.push(route.request().postDataJSON());
      return route.fulfill({ status: 201, json: {} });
    });
    await page.route('**/api/reports', route => {
      const reportId = route.request().postDataJSON().id;
      if (reportId === id) { requests[id]++; return fail(route); }
      uploads.push(reportId);
      uploadedBodies.push(route.request().postDataJSON());
      return route.fulfill({ status: 201, json: {} });
    });
    await seed(page, [earlier, later]);
    if (sharedReadWait) {
      await expect.poll(async () => (await stored(page))?.retry_stage).toBe('findings');
      const deadline = (await stored(page)).retry_at as number;
      const now = await page.evaluate(() => Date.now());
      expect(deadline - now).toBe(60_000);
      expect(requests[other]).toBe(0);
      expect(await stored(page, other)).toEqual(later);
      await page.clock.fastForward(deadline - now - 1);
      expect(await page.evaluate(() => Date.now())).toBe(deadline - 1);
      expect(requests[other]).toBe(0);
      expect(await stored(page, other)).toEqual(later);
      expect(uploads).toEqual([]);
      expect(events).toEqual([]);
      await page.clock.fastForward(1);
      await expect.poll(() => requests[other]).toBe(1);
      await expect.poll(async () => (await stored(page, other))?.server_lost).toBe(true);
      expect(uploads).toEqual([]);
      await page.clock.fastForward(1);
      await expect.poll(() => uploads).toEqual([other]);
      await expect.poll(() => events.length).toBe(4);
      const { solution: _, ...sent } = uploadedBodies[0];
      expect(sent).toEqual(later.report);
      expect(JSON.stringify(sent)).not.toMatch(/53\.403481|22\.658699|privateFix|prywatna|signer/);
      expect(events).toEqual([...later.notices[0].events, ...later.notices[0].outcomes].map(({ synced: _, ...event }) => event));
      expect(await stored(page, other)).toEqual({ ...later, events: [later.events[0], { kind: 'synced', at: new Date(deadline + 1).toISOString() }] });
      expect(requests[other]).toBe(1);
      return;
    }
    await expect.poll(() => requests[other]).toBeGreaterThan(0);
    await expect.poll(async () => (await stored(page, other))?.server_lost || uploads.includes(other)).toBe(true);
    // A daily upload limit holds back the later upload too, but its loss is found and shown.
    if (!(failing === 'upload' && kind === 429)) await expect.poll(() => uploads).toEqual([other]);
    expect(requests[id]).toBeGreaterThan(0);
  });
}

test('a pending Withdrawal whose deletion keeps failing never blocks finding a Report the server lost', async ({ page }) => {
  await page.clock.install();
  const other = '382ad090-8888-4888-8888-888888888888';
  const deletes: number[] = [];
  const uploads: string[] = [];
  let probes = 0;
  // The withdrawn Report already left the phone; only its retry authorization remains.
  await page.route(`**/api/reports/${id}`, route => { deletes.push(Date.now()); return route.fulfill({ status: 503, json: { error: 'temporarily_unavailable' } }); });
  await page.route('**/api/reports/*/findings', route => {
    probes++;
    return route.fulfill(uploads.includes(other) ? { json: computed } : { status: 404, json: { error: 'not_found' } });
  });
  await page.route('**/api/reports', route => { uploads.push(route.request().postDataJSON().id); return route.fulfill({ status: 201, json: {} }); });
  await seed(page, [laterReport(other)], { withdrawals: [{ id, token: '1'.repeat(64), at }], open: other });
  await expect.poll(() => uploads).toEqual([other]);
  expect(probes).toBeGreaterThan(0);
  expect(deletes.length).toBeGreaterThan(0);
  // The Withdrawal keeps its own backoff and stays pending; the withdrawn Report is never uploaded.
  const attempts = deletes.length;
  await page.clock.fastForward('00:40');
  await expect.poll(() => deletes.length).toBeGreaterThan(attempts);
  expect(uploads).toEqual([other]);
  expect((await localWithdrawals(page)).map(row => row.id)).toEqual([id]);
});
