import { test, expect } from '@playwright/test';
import { createServer } from 'node:http';
import { clockedGeolocation, finishFromWhen, stubReportServer } from './stages.ts';
import { startClockedApi } from '../helpers/clocked-api.ts';
import { pool } from '../../server/db.ts';
import { postReport, reportAt } from '../helpers/reports.ts';

test.beforeEach(async ({ page, context }) => {
  await clockedGeolocation(page);
  await context.setGeolocation({ latitude: 52, longitude: 21, accuracy: 8 });
});

async function capture(page: import('@playwright/test').Page) {
  await page.getByRole('button', { name: 'Strzał', exact: true }).click();
  await finishFromWhen(page, false);
  await page.getByRole('button', { name: 'Zapisz zgłoszenie' }).click();
}

test('500 keeps a Report queued, then retries to one server row', async ({ page }) => {
  let attempts = 0;
  let payload: Record<string, unknown>;
  await page.route('**/api/reports', async route => {
    attempts++;
    payload = route.request().postDataJSON();
    if (attempts === 1) await route.fulfill({ status: 500, body: '{}' });
    else await route.continue();
  });
  await page.goto('/');
  await capture(page);
  await expect(page.getByText('Zapisano na serwerze.', { exact: true })).toBeVisible({ timeout: 30_000 });
  expect(attempts).toBe(2);
  const response = await postReport(process.env.TEST_BASE_URL ?? 'http://127.0.0.1:3001', payload!);
  expect(response.status).toBe(200);
});

test('connection failure keeps a saved retry deadline and offers immediate recovery in both languages', async ({ page }) => {
  let posts = 0;
  await page.route('**/api/reports', route => {
    posts++;
    return posts === 1 ? route.abort('internetdisconnected') : route.continue();
  });
  await page.route('**/api/reports/*/findings', route => route.fulfill({ json: { status: 'failed', reason: 'test' } }));
  await page.clock.install();
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/');
  await capture(page);
  await expect(page.getByText(/Nie udało się połączyć. Ponowna próba:/)).toBeVisible();
  await page.reload();
  await page.getByRole('button', { name: 'Moje zapisy' }).click();
  await expect(page.locator('.history').getByText('Czeka na internet, potem zapisze się samo', { exact: true })).toBeVisible();
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  expect(posts).toBe(1);
  await page.getByRole('button', { name: /^Strzał, / }).click();
  await page.getByRole('button', { name: 'Menu' }).click();
  await page.getByRole('button', { name: 'English' }).click();
  await page.getByRole('button', { name: 'Back to the app' }).click();
  await expect(page.getByText(/Could not connect. Next attempt:/)).toBeVisible();
  await page.getByRole('button', { name: 'Try now' }).click();
  await expect(page.getByText('Saved on the server.', { exact: true })).toBeVisible();
  await expect(page.locator('section.findings p').filter({ hasText: 'Findings could not be calculated. You can prepare a Notice without measurements.' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Prepare Notice' })).toBeVisible();
});

test('server acceptance, pending Findings and terminal failure remain distinct', async ({ page }) => {
  // Only the client's status wording is checked, so the upload spends no daily Report.
  await stubReportServer(page);
  let failed = false;
  await page.route('**/api/reports/*/findings', route => route.fulfill({ json: failed
    ? { status: 'failed', reason: 'test' } : { status: 'pending' } }));
  await page.goto('/');
  await capture(page);
  await expect(page.getByText('Zapisano na serwerze.', { exact: true })).toBeVisible();
  await expect(page.locator('section.findings p').filter({ hasText: 'Czekamy na pomiary.' })).toBeVisible();
  await page.getByRole('button', { name: 'Menu' }).click();
  await page.getByRole('button', { name: 'English' }).click();
  await page.getByRole('button', { name: 'Back to the app' }).click();
  await expect(page.locator('section.findings p').filter({ hasText: 'Waiting for measurements.' })).toBeVisible();
  failed = true;
  await expect(page.locator('section.findings p').filter({ hasText: 'Findings could not be calculated. You can prepare a Notice without measurements.' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Prepare Notice' })).toBeVisible();
});

test('Findings rate limit keeps its deadline through reload and foreground', async ({ page }) => {
  // Only the client's status wording is checked, so the upload spends no daily Report.
  await stubReportServer(page);
  let polls = 0;
  await page.route('**/api/reports/*/findings', route => {
    polls++;
    return route.fulfill(polls === 1 ? { status: 429, headers: { 'Retry-After': '3600' }, body: '{}' }
      : { json: { status: 'failed', reason: 'test' } });
  });
  await page.clock.install();
  await page.goto('/');
  await capture(page);
  await expect(page.getByText('Zapisano na serwerze.', { exact: true })).toBeVisible();
  await expect(page.locator('section.findings p').filter({ hasText: 'Nie udało się pobrać pomiarów. Spróbujemy ponownie.' })).toBeVisible();
  await page.reload();
  await page.getByRole('button', { name: 'Moje zapisy' }).click();
  await page.getByRole('button', { name: /^Strzał, / }).click();
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  expect(polls).toBe(1);
  await page.clock.fastForward(3_600_001);
  await expect(page.locator('section.findings p').filter({ hasText: 'Nie udało się obliczyć ustaleń.' })).toBeVisible();
  expect(polls).toBe(2);
});

test('Notice event retry does not claim Findings retrieval failed', async ({ page }) => {
  // Only the client's status wording is checked, so the upload spends no daily Report.
  await stubReportServer(page);
  await page.route('**/api/reports/*/findings', route => route.fulfill({ json: { status: 'pending' } }));
  await page.route('**/api/reports/*/events', route => route.fulfill({ status: 503, body: '{}' }));
  await page.goto('/');
  await capture(page);
  await expect(page.getByText('Zapisano na serwerze.', { exact: true })).toBeVisible();
  await page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('bor-czuwa');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const transaction = db.transaction('reports', 'readwrite');
    const store = transaction.objectStore('reports');
    const request = store.getAll();
    request.onsuccess = () => {
      const item = request.result[0];
      const id = crypto.randomUUID();
      item.notices = [{ id, recipient: { id: 'test-unit', kind: 'police', name: 'Test unit', email: 'test@example.org' },
        others: [], variant: 'unsigned', events: [{ id: crypto.randomUUID(), kind: 'notice_composed', notice_id: id,
          recipient_kind: 'police', unit_id: 'test-unit', template_version: 'v1', directory_version: 'v1', at: new Date().toISOString() }] }];
      store.put(item);
    };
    await new Promise<void>((resolve, reject) => { transaction.oncomplete = () => resolve(); transaction.onerror = () => reject(transaction.error); });
    db.close();
  });
  await page.reload();
  await expect.poll(() => page.evaluate(async () => {
    const request = indexedDB.open('bor-czuwa');
    const db = await new Promise<IDBDatabase>(resolve => { request.onsuccess = () => resolve(request.result); });
    const rows = await new Promise<any[]>(resolve => { const read = db.transaction('reports').objectStore('reports').getAll(); read.onsuccess = () => resolve(read.result); });
    db.close();
    return rows[0].retry_stage;
  })).toBe('events');
  await page.getByRole('button', { name: 'Moje zapisy' }).click();
  await page.getByRole('button', { name: /^Strzał, / }).click();
  await expect(page.locator('section.findings p').filter({ hasText: 'Czekamy na pomiary.' })).toBeVisible();
});

test('400 remains visible in queue and storage refusal warns without losing capture', async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator.storage, 'persist', { value: async () => false });
    Object.defineProperty(navigator.storage, 'persisted', { value: async () => false });
  });
  let posts = 0;
  await page.route('**/api/reports', route => { posts++; return route.fulfill({ status: 400, body: '{}' }); });
  await page.goto('/');
  await page.getByRole('button', { name: 'Strzał', exact: true }).click();
  await finishFromWhen(page, false);
  await page.getByRole('button', { name: 'Zapisz zgłoszenie' }).click();
  await expect(page.getByRole('alert')).toContainText('Serwer nie przyjął');
  await expect(page.locator('section.findings p').filter({ hasText: 'Pomiary są niedostępne, bo serwer nie przyjął zgłoszenia.' })).toBeVisible();
  const warning = page.getByText('Telefon może usunąć zapisy, gdy zabraknie miejsca', { exact: true });
  await expect(warning).toHaveCount(0);
  await page.getByRole('button', { name: 'Bór czuwa' }).click();
  await expect(warning).toHaveCount(0);
  await page.getByRole('button', { name: 'Moje zapisy' }).click();
  await expect(warning).toHaveCount(0);
  await page.getByRole('button', { name: 'Menu', exact: true }).click();
  await expect(warning).toBeVisible();
  await page.reload();
  await expect(warning).toBeVisible();
  await page.getByRole('button', { name: 'Moje zapisy' }).click();
  await expect(page.locator('.history').getByText('Nie zostało przyjęte. Otwórz, żeby zobaczyć dlaczego.', { exact: true })).toBeVisible();
  expect(posts).toBe(1);
});

test('a refused Report retries after an app update', async ({ page }) => {
  let posts = 0;
  await page.route('**/api/reports', route => {
    posts++;
    return route.fulfill({ status: posts === 1 ? 400 : 201, body: '{}' });
  });
  await page.route('**/api/reports/*/findings', route => route.fulfill({ json: { status: 'failed', reason: 'test' } }));
  await page.goto('/');
  await capture(page);
  await expect(page.getByRole('alert')).toContainText('Serwer nie przyjął');
  await page.evaluate(() => new Promise<void>((resolve, reject) => {
    const request = indexedDB.open('bor-czuwa');
    request.onsuccess = () => {
      const db = request.result;
      const transaction = db.transaction('reports', 'readwrite');
      const store = transaction.objectStore('reports');
      const rows = store.getAll();
      rows.onsuccess = () => { for (const row of rows.result) store.put({ ...row, refused_version: 'previous-build' }); };
      transaction.oncomplete = () => { db.close(); resolve(); };
      transaction.onerror = () => reject(transaction.error);
    };
    request.onerror = () => reject(request.error);
  }));
  await page.reload();
  await page.getByRole('button', { name: 'Moje zapisy' }).click();
  await page.getByRole('button', { name: /^Strzał, / }).click();
  await expect(page.getByText('Zapisano na serwerze.', { exact: true })).toBeVisible({ timeout: 30_000 });
  expect(posts).toBe(2);
});

test('429 deadline survives reload and online events', async ({ page }) => {
  let posts = 0;
  await page.route('**/api/reports', route => {
    posts++;
    return route.fulfill({ status: posts === 1 ? 429 : 201,
      headers: posts === 1 ? { 'Retry-After': '3600' } : {}, body: '{}' });
  });
  await page.route('**/api/reports/*/findings', route => route.fulfill({ json: { status: 'failed', reason: 'test' } }));
  await page.clock.install();
  await page.goto('/');
  await capture(page);
  await expect(page.getByText(/Ponowna próba/)).toBeVisible({ timeout: 30_000 });
  await page.reload();
  await page.getByRole('button', { name: 'Moje zapisy' }).click();
  await expect(page.locator('.history').getByText('Serwer chwilowo nie przyjmuje zgłoszeń. Zapisze się samo później.', { exact: true })).toBeVisible();
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  await page.clock.fastForward(3599_000);
  expect(posts).toBe(1);
  await page.clock.fastForward(1001);
  await expect(page.locator('.history')).toBeVisible();
  await expect(page.locator('.history')).not.toContainText(/Zapisuje się|Czeka na internet|Serwer chwilowo/, { timeout: 30_000 });
  expect(posts).toBe(2);
});

test('a Report rate limit defers other queued Reports before solving another proof', async ({ page }) => {
  let challenges = 0;
  let posts = 0;
  await page.route('**/api/challenge', route => { challenges++; return route.continue(); });
  await page.route('**/api/reports', route => {
    posts++;
    return route.fulfill({ status: posts === 1 ? 429 : 201,
      headers: posts === 1 ? { 'Retry-After': '90000' } : {}, body: '{}' });
  });
  await page.clock.install({ time: new Date('2026-10-24T22:00:00Z') });
  await page.goto('/');
  await capture(page);
  await expect(page.getByText(/Ponowna próba/)).toBeVisible();
  await page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('bor-czuwa');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const transaction = db.transaction('reports', 'readwrite');
    const store = transaction.objectStore('reports');
    const existing = await new Promise<any>(resolve => {
      const request = store.getAll();
      request.onsuccess = () => resolve(request.result[0]);
    });
    store.put({ ...existing, report: { ...existing.report, id: crypto.randomUUID() },
      retry_at: undefined, retry_reason: undefined, retry_stage: undefined });
    await new Promise<void>(resolve => { transaction.oncomplete = () => resolve(); });
    db.close();
  });
  await page.reload();
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  expect(challenges).toBe(1);
  expect(posts).toBe(1);
  await page.clock.fastForward(90_000_001);
  await expect.poll(() => posts).toBeGreaterThan(1);
});

test('a later Report limit does not delay an earlier Withdrawal retry', async ({ page }) => {
  let deletes = 0;
  let posts = 0;
  await page.route('**/api/reports/*', route => {
    deletes++;
    return route.fulfill({ status: 204, body: '' });
  });
  await page.route('**/api/reports', route => {
    posts++;
    return route.fulfill({ status: 429, headers: { 'Retry-After': '3600' }, body: '{}' });
  });
  await page.clock.install({ time: new Date('2026-10-24T22:00:00Z') });
  await page.goto('/');
  await capture(page);
  await expect(page.getByText(/Ponowna próba/)).toBeVisible();
  await page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('bor-czuwa');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction(['reports', 'withdrawals'], 'readwrite');
      const reports = transaction.objectStore('reports');
      const request = reports.getAll();
      request.onsuccess = () => reports.put({ ...request.result[0], retry_at: undefined,
        retry_reason: undefined, retry_stage: undefined });
      transaction.objectStore('withdrawals').put({ id: crypto.randomUUID(), token: 'a'.repeat(64),
        at: new Date().toISOString(), retry_at: Date.now() + 10_000 });
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
    });
    db.close();
  });
  await page.reload();
  await expect.poll(() => posts).toBe(2);
  expect(deletes).toBe(0);
  await page.clock.fastForward(10_001);
  await expect.poll(() => deletes).toBe(1);
});

test('an HTTP-date Retry-After stays absolute when clock reads advance', async ({ page }, testInfo) => {
  const deadline = Date.parse('2026-10-25T23:00:00Z');
  let posts = 0;
  const requests: { method?: string; path?: string }[] = [];
  const server = createServer((request, response) => {
    requests.push({ method: request.method, path: request.url });
    if (request.method === 'OPTIONS') {
      response.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'POST', 'Access-Control-Allow-Headers': 'content-type' });
      response.end();
      return;
    }
    posts++;
    response.writeHead(429, { 'Retry-After': 'Sun, 25 Oct 2026 23:00:00 GMT', 'Access-Control-Allow-Origin': '*', 'Access-Control-Expose-Headers': 'Retry-After', 'Content-Type': 'application/json' });
    response.end('{}');
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Retry fixture address unavailable');
    await page.clock.install({ time: new Date('2026-10-24T22:00:00Z') });
    await page.route('**/api/reports', route => route.continue({ url: `http://127.0.0.1:${address.port}/api/reports` }));
    await page.goto('/');
    await page.evaluate(() => {
      const original = Date.now.bind(Date);
      const clock = { reads: 0 };
      (window as typeof window & { advancingRetryClock?: typeof clock }).advancingRetryClock = clock;
      Date.now = () => original() + clock.reads++;
    });
    await capture(page);
    await expect(page.getByText(/Ponowna próba/)).toBeVisible();
    const readDeadline = () => page.evaluate(async () => {
      const db = await new Promise<IDBDatabase>((resolve, reject) => {
        const request = indexedDB.open('bor-czuwa');
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      try {
        const rows = await new Promise<any[]>(resolve => {
          const request = db.transaction('reports').objectStore('reports').getAll();
          request.onsuccess = () => resolve(request.result);
        });
        return rows[0]?.retry_at;
      } finally { db.close(); }
    });
    await testInfo.attach('retry-http-clock', { body: JSON.stringify({ requests, posts, deadline, observedDeadline: await readDeadline(),
      clockReads: await page.evaluate(() => (window as typeof window & { advancingRetryClock: { reads: number } }).advancingRetryClock.reads) }), contentType: 'application/json' });
    await expect.poll(readDeadline).toBe(deadline);
    expect(await page.evaluate(() => (window as typeof window & { advancingRetryClock: { reads: number } }).advancingRetryClock.reads)).toBeGreaterThan(1);
    expect(posts).toBe(1);
    expect(requests.filter(request => request.method !== 'OPTIONS')).toEqual([{ method: 'POST', path: '/api/reports' }]);
    await page.reload();
    await expect(page.getByText(/Ponowna próba/)).toBeVisible();
    await page.evaluate(() => window.dispatchEvent(new Event('online')));
    await expect.poll(readDeadline).toBe(deadline);
    expect(posts).toBe(1);
  } finally {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

test('HTTP-date, invalid and missing Retry-After produce persisted usable deadlines', async ({ page }) => {
  let posts = 0;
  await page.clock.install({ time: new Date('2026-10-24T22:00:00Z') });
  await page.route('**/api/reports', route => {
    posts++;
    return route.fulfill({ status: 429, headers: posts === 1
      ? { 'Retry-After': 'Sun, 25 Oct 2026 23:00:00 GMT' }
      : posts === 2 ? { 'Retry-After': 'invalid' } : {}, body: '{}' });
  });
  await page.goto('/');
  await capture(page);
  await expect(page.getByText(/Ponowna próba/)).toBeVisible();
  await expect.poll(() => page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('bor-czuwa');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const rows = await new Promise<any[]>(resolve => {
      const request = db.transaction('reports').objectStore('reports').getAll();
      request.onsuccess = () => resolve(request.result);
    });
    db.close();
    return rows[0].retry_at;
  })).toBe(Date.parse('2026-10-25T23:00:00Z'));
  await page.reload();
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  expect(posts).toBe(1);
  await page.clock.fastForward(90_000_001);
  await expect.poll(() => posts).toBe(2);
  await page.clock.fastForward(59_999);
  expect(posts).toBe(2);
  await page.clock.fastForward(2);
  await expect.poll(() => posts).toBe(3);
  await page.reload();
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  expect(posts).toBe(3);
  await page.clock.fastForward(60_001);
  await expect.poll(() => posts).toBe(4);
});

test('the 51st Report syncs after Warsaw midnight with a faked clock', async ({ page }) => {
  let now = Date.parse('2026-09-25T21:59:00Z');
  const server = await startClockedApi(now);
  const { base } = server;
  try {
    for (let i = 0; i < 50; i++) expect((await postReport(base, reportAt())).status).toBe(201);
    await page.route('**/api/**', async route => {
      const response = await route.fetch({ url: base + new URL(route.request().url()).pathname, headers: { ...route.request().headers(), origin: base } });
      await route.fulfill({ response });
    });
    await page.clock.install({ time: new Date(now) });
    await page.goto('/');
    await capture(page);
    await expect(page.getByText(/Ponowna próba/)).toBeVisible({ timeout: 30_000 });
    now += 60_001;
    await server.setTime(now);
    await page.clock.fastForward(60_001);
    await expect(page.getByText('Zapisano na serwerze.', { exact: true })).toBeVisible({ timeout: 30_000 });
  } finally {
    try {
      await page.goto('about:blank');
      await page.unrouteAll({ behavior: 'wait' });
    } finally { await server.close(); }
  }
});

/** Counts persist() calls; each records how many Drafts the phone held when the browser was asked.
 * Also tracks IndexedDB opens and reads still in flight, so a test can wait for the app's storage work to finish. */
async function countPersist(page: import('@playwright/test').Page, persisted: boolean) {
  await page.addInitScript(alreadyKept => {
    const asked: number[] = [];
    const tracker = { inflight: 0 };
    Object.assign(window, { persistAsked: asked, storageTracker: tracker });
    const track = (request: IDBRequest) => {
      tracker.inflight++;
      const done = () => { tracker.inflight--; };
      request.addEventListener('success', done, { once: true });
      request.addEventListener('error', done, { once: true });
      return request;
    };
    const open = IDBFactory.prototype.open;
    IDBFactory.prototype.open = function (...args) { return track(open.apply(this, args)) as IDBOpenDBRequest; };
    for (const name of ['get', 'getAll', 'count'] as const) {
      const read = IDBObjectStore.prototype[name] as (...args: unknown[]) => IDBRequest;
      Object.defineProperty(IDBObjectStore.prototype, name, { configurable: true, writable: true,
        value(this: IDBObjectStore, ...args: unknown[]) { return track(read.apply(this, args)); } });
    }
    Object.defineProperty(navigator.storage, 'persisted', { value: async () => alreadyKept });
    Object.defineProperty(navigator.storage, 'persist', { value: async () => {
      const db = await new Promise<IDBDatabase>((resolve, reject) => {
        const request = indexedDB.open('bor-czuwa');
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      const drafts = await new Promise<number>(resolve => {
        const count = db.transaction('drafts').objectStore('drafts').count();
        count.onsuccess = () => resolve(count.result);
      });
      db.close();
      asked.push(drafts);
      return true;
    } });
  }, persisted);
  return () => page.evaluate(() => (window as unknown as { persistAsked: number[] }).persistAsked);
}

/** Waits until no IndexedDB open or read is in flight across two tasks: whatever the app does after its
 * storage reads (asking to keep storage among it) has run by then. */
async function storageSettled(page: import('@playwright/test').Page) {
  await expect.poll(() => page.evaluate(async () => {
    const tracker = (window as unknown as { storageTracker: { inflight: number } }).storageTracker;
    if (tracker.inflight) return false;
    await new Promise(resolve => setTimeout(resolve));
    return tracker.inflight === 0;
  })).toBe(true);
}

test('the browser is asked to keep storage once, right after the first Draft is stored', async ({ page }) => {
  await stubReportServer(page);
  const asked = await countPersist(page, false);
  await page.goto('/');
  await expect(page.getByRole('heading', { level: 1, name: 'Co się stało?' })).toBeVisible();
  await storageSettled(page);
  expect(await asked()).toEqual([]);
  await page.getByRole('button', { name: 'Strzał', exact: true }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Kiedy to się stało?' })).toBeVisible();
  await expect.poll(asked).toEqual([1]);
  await finishFromWhen(page, false);
  await page.getByRole('button', { name: 'Zapisz zgłoszenie' }).click();
  await expect(page.getByText('Zgłoszenie zapisane na urządzeniu.', { exact: true })).toBeAttached();
  await storageSettled(page);
  expect(await asked()).toEqual([1]);
});

test('storage the browser already keeps is never asked for again', async ({ page }) => {
  await stubReportServer(page);
  const asked = await countPersist(page, true);
  await page.goto('/');
  await capture(page);
  await expect(page.getByText('Zgłoszenie zapisane na urządzeniu.', { exact: true })).toBeAttached();
  await storageSettled(page);
  expect(await asked()).toEqual([]);
});

test('a Draft stored before this load is enough for the browser to be asked on the next start', async ({ page }) => {
  await stubReportServer(page);
  const asked = await countPersist(page, false);
  await page.goto('/');
  await page.getByRole('button', { name: 'Strzał', exact: true }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Kiedy to się stało?' })).toBeVisible();
  await expect.poll(asked).toEqual([1]);
  // A Draft saved by an earlier version of the app was never followed by the question; a reload asks it.
  await page.goto('/');
  await expect.poll(asked).toEqual([1]);
  await storageSettled(page);
  expect(await asked()).toEqual([1]);
});

test('a persistence question left unanswered does not hold the saved Report', async ({ page }) => {
  await stubReportServer(page);
  // Firefox can leave its persistent-storage question open indefinitely.
  await page.addInitScript(() => {
    Object.defineProperty(navigator.storage, 'persisted', { value: async () => false });
    Object.defineProperty(navigator.storage, 'persist', { value: () => new Promise(() => {}) });
  });
  await page.goto('/');
  await capture(page);
  await expect(page.getByText('Zgłoszenie zapisane na urządzeniu.', { exact: true })).toBeAttached();
  // The save has finished, so the next capture starts at once.
  await page.getByRole('button', { name: 'Bór czuwa' }).click();
  await page.getByRole('button', { name: 'Strzał', exact: true }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Kiedy to się stało?' })).toBeVisible();
});

test('a start with a Draft shows the eviction warning while the persistence question is still open', async ({ page }) => {
  await stubReportServer(page);
  await page.goto('/');
  await page.getByRole('button', { name: 'Strzał', exact: true }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Kiedy to się stało?' })).toBeVisible();
  // From the next start on, the browser keeps nothing and leaves its question unanswered, as Firefox can.
  await page.addInitScript(() => {
    Object.defineProperty(navigator.storage, 'persisted', { value: async () => false });
    Object.defineProperty(navigator.storage, 'persist', { value: () => new Promise(() => {}) });
  });
  await page.goto('/');
  await page.getByRole('button', { name: 'Menu' }).click();
  await expect(page.getByText('Telefon może usunąć zapisy, gdy zabraknie miejsca')).toBeVisible();
});

test.afterAll(() => pool.end());
