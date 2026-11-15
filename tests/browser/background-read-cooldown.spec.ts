import { test, expect, type Page } from '@playwright/test';
import { createHash } from 'node:crypto';

test.use({ serviceWorkers: 'block', reducedMotion: 'reduce' });
const epoch = Date.parse('2026-10-04T12:00:00Z');
const id = (index: number) => `35000000-0000-4000-8000-${String(index).padStart(12, '0')}`;
function report(index: number, pending = false) {
  const at = new Date(epoch + index * 1000).toISOString();
  return { report: { id: id(index), event_type: 'shot', captured_at: at,
    occurred_at: { at, source: 'device_clock', coarseness: 'exact' }, device_fix: null,
    incident_location: { lat: 53.4, lon: 22.6, source: 'moved_by_reporter' }, species: null, has_note: true,
    app_version: '0.1.2', privacy_policy_version: '1', terms_of_use_version: '1', token_sha256: '0'.repeat(64) },
  token: '1'.repeat(64), events: [{ kind: 'created', at }, { kind: 'synced', at }],
  findings: pending ? { status: 'pending' } : { status: 'failed', reason: 'fixture' }, note: `private-${index}` };
}
async function rows(page: Page) {
  return page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>(resolve => { const request = indexedDB.open('bor-czuwa'); request.onsuccess = () => resolve(request.result); });
    try { return await new Promise<any[]>(resolve => { const request = db.transaction('reports').objectStore('reports').getAll(); request.onsuccess = () => resolve(request.result); }); }
    finally { db.close(); }
  });
}
async function put(page: Page, reports: object[], deleted: string[] = [], withdrawals: { id: string; token: string; at: string }[] = []) {
  await page.evaluate(async ({ reports, deleted, withdrawals }) => {
    const db = await new Promise<IDBDatabase>(resolve => { const request = indexedDB.open('bor-czuwa'); request.onsuccess = () => resolve(request.result); });
    try {
      const tx = db.transaction(['reports', 'withdrawals'], 'readwrite');
      reports.forEach(value => tx.objectStore('reports').put(value));
      deleted.forEach(value => tx.objectStore('reports').delete(value));
      withdrawals.forEach(value => tx.objectStore('withdrawals').put(value));
      await new Promise<void>(resolve => { tx.oncomplete = () => resolve(); });
    } finally { db.close(); }
  }, { reports, deleted, withdrawals });
}
async function setup(page: Page, reports: object[], response: (id: string, attempt: number) => { status: number; headers?: Record<string, string> }, responseUrl?: string) {
  await page.clock.install({ time: new Date(epoch) }); await page.clock.pauseAt(new Date(epoch));
  await page.addInitScript(url => {
    const original = window.fetch.bind(window), cancel = ReadableStream.prototype.cancel;
    const bodies = new WeakMap<ReadableStream, string>();
    const probe = { documentId: crypto.randomUUID(), attempts: [] as { path: string; at: number; method: string }[], responses: [] as { path: string; at: number; status: number; retryAfter: string | null }[], canceled: [] as string[] };
    (window as any).readCooldownProbe = probe;
    window.fetch = async (...args) => {
      const path = new URL(String(args[0]), location.href).pathname;
      probe.attempts.push({ path, at: Date.now(), method: args[1]?.method ?? 'GET' });
      const response = await original(...args);
      if (path.endsWith('/findings')) {
        probe.responses.push({ path, at: Date.now(), status: response.status, retryAfter: response.headers.get('retry-after') });
        if (response.body) bodies.set(response.body, path);
        if (url !== undefined) Object.defineProperty(response, 'url', { value: url });
      }
      return response;
    };
    ReadableStream.prototype.cancel = function (...args) {
      const path = bodies.get(this); if (path) probe.canceled.push(path);
      return Reflect.apply(cancel, this, args);
    };
  }, responseUrl);
  const reads: string[] = [], writes: { path: string; method: string; body?: unknown }[] = [], counts = new Map<string, number>();
  const challenge = { algorithm: 'SHA-256', challenge: createHash('sha256').update('fixture0').digest('hex'), salt: 'fixture', signature: 'fixture-signature', maxnumber: 1 };
  await page.route('**/api/**', route => {
    const path = new URL(route.request().url()).pathname, method = route.request().method();
    const match = /^\/api\/reports\/([^/]+)\/findings$/.exec(path);
    if (match) {
      const key = match[1], attempt = (counts.get(key) ?? 0) + 1; counts.set(key, attempt); reads.push(key);
      return route.fulfill({ ...response(key, attempt), json: { status: 'failed', reason: 'fixture' } });
    }
    if (path === '/api/challenge') return route.fulfill({ json: challenge });
    if (method !== 'GET') { writes.push({ path, method, ...(method === 'POST' ? { body: route.request().postDataJSON() } : {}) }); return route.fulfill({ status: method === 'POST' && path === '/api/reports' ? 201 : 204 }); }
    return route.fulfill({ status: 503, json: { error: 'fixture' } });
  });
  await page.goto('/'); await expect(page.getByRole('heading', { name: 'Co się stało?', exact: true })).toBeVisible();
  await page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await put(page, reports);
  const documents = [await page.evaluate(() => (window as any).readCooldownProbe)];
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Co się stało?', exact: true })).toBeVisible();
  return { reads, writes, documents, probe: () => page.evaluate(() => (window as any).readCooldownProbe), wake: () => page.evaluate(() => window.dispatchEvent(new Event('online'))) };
}

test('fixture seeds a paused old document and retains every new-document read', async ({ page }, info) => {
  const initial = [report(1), report(2), report(3)];
  const run = await setup(page, initial, key => key === id(1)
    ? { status: 429, headers: { 'Retry-After': '10' } } : { status: 200 });
  await expect.poll(() => run.documents.length).toBe(1);
  const old = run.documents[0], current = await run.probe();
  expect(old.documentId).not.toBe(current.documentId);
  expect(old.attempts.filter((request: { path: string }) => request.path.endsWith('/findings'))).toEqual([]);
  await expect.poll(() => run.reads.length).toBe(1);
  expect(run.reads).toEqual([id(1)]);
  await page.clock.fastForward(9_999);
  expect(run.reads).toEqual([id(1)]);
  const final = await run.probe();
  expect(final.attempts.filter((request: { path: string }) => request.path.endsWith('/findings'))
    .map((request: { path: string }) => request.path)).toEqual(run.reads.map(key => `/api/reports/${key}/findings`));
  expect(run.writes).toEqual([]);
  expect(await rows(page)).toEqual(initial);
  await info.attach('fixture-document-provenance', { body: JSON.stringify({ documents: run.documents,
    current: final, reads: run.reads, writes: run.writes }), contentType: 'application/json' });
});

for (const header of ['10', new Date(epoch + 10_000).toUTCString()]) test(`valid ${header} cooldown preserves unattempted mixed Reports and resumes on expiry`, async ({ page }, info) => {
  const initial = [report(1), report(2, true), report(3)];
  const run = await setup(page, initial, key => key === id(1) ? { status: 429, headers: { 'Retry-After': header } } : { status: 200 });
  await expect.poll(() => run.reads.length).toBe(1);
  await run.wake(); await page.clock.fastForward(9_999); expect(run.reads).toEqual([id(1)]);
  expect((await rows(page)).filter(row => row.report.id !== id(1))).toEqual(initial.slice(1));
  await page.clock.fastForward(1); await expect.poll(() => run.reads.length).toBeGreaterThanOrEqual(3);
  expect(run.reads.slice(0, 3)).toEqual([id(1), id(2), id(3)]);
  const probe = await run.probe(); expect(probe.canceled).toContain(`/api/reports/${id(1)}/findings`);
  await info.attach('read-cooldown', { body: JSON.stringify(probe), contentType: 'application/json' });
});

for (const header of [undefined, 'invalid', '0', '-1', new Date(epoch - 1_000).toUTCString()]) test(`unusable ${String(header)} header keeps per-Report fallback without shared wait`, async ({ page }) => {
  const run = await setup(page, [report(1, true), report(2)], key => key === id(1) ? { status: 429, headers: header === undefined ? undefined : { 'Retry-After': header } } : { status: 200 });
  await expect.poll(() => run.reads.length).toBe(2);
  expect(run.reads).toEqual([id(1), id(2)]);
  const first = (await rows(page)).find(row => row.report.id === id(1))!;
  expect(first).toMatchObject({ retry_at: epoch + 60_000, retry_stage: 'findings', retry_reason: 'rate_limit' });
});

for (const url of ['', 'not a URL', 'https://example.invalid/api/reports/other/findings']) test(`unproven response origin ${JSON.stringify(url)} cannot establish shared wait`, async ({ page }) => {
  const run = await setup(page, [report(1, true), report(2)], key => key === id(1) ? { status: 429, headers: { 'Retry-After': '10' } } : { status: 200 }, url);
  await expect.poll(() => run.reads.length).toBe(2); expect(run.reads).toEqual([id(1), id(2)]);
  expect((await rows(page)).find(row => row.report.id === id(1))!.retry_at).toBe(epoch + 10_000);
});

test('repeated cooldown rotates reads across mixed, newly arriving and deleted IDs', async ({ page }, info) => {
  const run = await setup(page, [report(1), report(2, true), report(3)], key => key === id(3) ? { status: 500 } : { status: 429, headers: { 'Retry-After': '10' } });
  await expect.poll(() => run.reads.length).toBe(1);
  await put(page, [report(4, true)], [id(1)]);
  await page.clock.fastForward(10_000); await expect.poll(() => run.reads.length).toBe(2);
  expect(run.reads).toEqual([id(1), id(2)]);
  await page.clock.fastForward(10_000); await expect.poll(() => run.reads.length).toBeGreaterThanOrEqual(4);
  expect(run.reads.slice(0, 4)).toEqual([id(1), id(2), id(3), id(4)]);
  await page.clock.fastForward(10_000); await expect.poll(() => run.reads.length).toBeGreaterThan(4);
  expect(run.reads[4]).toBe(id(2)); expect((await rows(page)).map(row => row.report.id)).not.toContain(id(1));
  await info.attach('fair-read-continuation', { body: JSON.stringify(await run.probe()), contentType: 'application/json' });
});

test('uploads, durable Withdrawal and ordered Notice events progress while reads wait', async ({ page }, info) => {
  const first = report(1), pending: ReturnType<typeof report> & { notices?: unknown[] } = report(2, true);
  const run = await setup(page, [first, pending], key => key === id(1) ? { status: 429, headers: { 'Retry-After': '10' } } : { status: 200 });
  await expect.poll(() => run.reads.length).toBe(1);
  const at = new Date(epoch).toISOString(), notice = id(50);
  pending.notices = [{ id: notice, recipient: { kind: 'police', id: 'police.fixture', name: 'Urząd testowy', email: null },
    others: [], variant: 'unsigned', events: ['notice_composed', 'confirmed_by_reporter'].map((kind, index) => ({
      id: id(60 + index), notice_id: notice, recipient_kind: 'police' as const, unit_id: 'police.fixture',
      template_version: '1', directory_version: '1', at, kind: kind as 'notice_composed' | 'confirmed_by_reporter'
    })) }];
  const upload = report(3, true); upload.events = upload.events.filter(event => event.kind !== 'synced');
  await put(page, [pending, upload], [], [{ id: id(9), token: '1'.repeat(64), at }]);
  await run.wake(); await expect.poll(() => run.writes.length).toBe(4);
  expect(run.writes.map(({ path, method }) => ({ path, method }))).toEqual([
    { path: `/api/reports/${id(9)}`, method: 'DELETE' },
    { path: `/api/reports/${id(2)}/events`, method: 'POST' },
    { path: `/api/reports/${id(2)}/events`, method: 'POST' },
    { path: '/api/reports', method: 'POST' }
  ]);
  expect(run.writes.filter(request => request.path.endsWith('/events')).map(request => (request.body as { id: string }).id)).toEqual([id(60), id(61)]);
  expect(JSON.stringify(run.writes.find(request => request.path === '/api/reports')!.body)).not.toContain('private-3');
  expect(run.reads).toEqual([id(1)]);
  const saved = await rows(page);
  const { notices: savedNotices, ...savedPending } = saved.find(row => row.report.id === id(2))!;
  expect(savedPending).toEqual(report(2, true));
  expect(saved.find(row => row.report.id === id(3))!.events.some((event: { kind: string }) => event.kind === 'synced')).toBe(true);
  expect(savedNotices).toMatchObject([{ events: [{ synced: true }, { synced: true }] }]);
  await page.getByRole('button', { name: 'Strzał', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Kiedy to się stało?', exact: true })).toBeVisible();
  expect(run.reads).toEqual([id(1)]);
  await info.attach('independent-progress', { body: JSON.stringify({ writes: run.writes, probe: await run.probe() }), contentType: 'application/json' });
});

test('offline pause retains deferred terminal demand and reload keeps attempted per-Report deadline', async ({ page }, info) => {
  const run = await setup(page, [report(1, true), report(2)], key => key === id(1) ? { status: 429, headers: { 'Retry-After': '10' } } : { status: 200 });
  await expect.poll(() => run.reads.length).toBe(1);
  await page.evaluate(() => {
    Object.defineProperty(navigator, 'onLine', { configurable: true, get: () => false });
    window.dispatchEvent(new Event('offline'));
  });
  await page.clock.fastForward(10_000); expect(run.reads).toEqual([id(1)]);
  await page.evaluate(() => {
    Object.defineProperty(navigator, 'onLine', { configurable: true, get: () => true });
    window.dispatchEvent(new Event('online'));
  });
  await expect.poll(() => run.reads).toContain(id(2));
  // The online pass finds the first Report due (its 10 s elapsed while paused), reads it again after
  // the second Report and defers it by another 10 s. Take the deadline only once that attempt has
  // been stored; read earlier, it is the old one and the attempt moves it before the reload.
  await expect.poll(async () => (await rows(page)).find(row => row.report.id === id(1))!.retry_at).toBe(epoch + 20_000);
  const deadline = (await rows(page)).find(row => row.report.id === id(1))!.retry_at!;
  await page.reload(); await expect(page.getByRole('heading', { name: 'Co się stało?', exact: true })).toBeVisible();
  expect((await rows(page)).find(row => row.report.id === id(1))!.retry_at).toBe(deadline);
  await info.attach('pause-reload', { body: JSON.stringify({ deadline, reads: run.reads, probe: await run.probe() }), contentType: 'application/json' });
});

test('404 restoration and transient terminal failure do not create a shared read stop', async ({ page }) => {
  const run = await setup(page, [report(1), report(2), report(3)], (key, attempt) => key === id(1) && attempt === 1 ? { status: 404 } : key === id(2) ? { status: 500 } : { status: 200 });
  await expect.poll(() => run.reads.length).toBe(3);
  expect(run.reads).toEqual([id(1), id(2), id(3)]);
  await page.clock.fastForward(1); await expect.poll(() => run.writes.some(request => request.path === '/api/reports')).toBe(true);
  expect((await rows(page)).find(row => row.report.id === id(3))!.note).toBe('private-3');
});

test('short shared cooldown never advances a longer persisted Report deadline', async ({ page }) => {
  const delayed = { ...report(2, true), retry_at: epoch + 60_000, retry_reason: 'rate_limit', retry_stage: 'findings' };
  const run = await setup(page, [report(1), delayed, report(3, true)], (key, attempt) => key === id(1) && attempt === 1
    ? { status: 429, headers: { 'Retry-After': '10' } } : { status: 200 });
  await expect.poll(() => run.reads.length).toBe(1);
  await page.clock.fastForward(10_000); await expect.poll(() => run.reads).toContain(id(3));
  expect(run.reads).not.toContain(id(2));
  expect((await rows(page)).find(row => row.report.id === id(2))).toEqual(delayed);
  await page.clock.fastForward(49_999); expect(run.reads).not.toContain(id(2));
  await page.clock.fastForward(1); await expect.poll(() => run.reads).toContain(id(2));
});

test('same-time IDs and a new earlier ID receive fair read continuation', async ({ page }) => {
  const initial = [report(1), report(2, true), report(3)];
  for (const row of initial) row.events[0].at = new Date(epoch).toISOString();
  const run = await setup(page, initial, () => ({ status: 429, headers: { 'Retry-After': '10' } }));
  await expect.poll(() => run.reads.length).toBe(1);
  const earlier = report(0, true); earlier.events[0].at = new Date(epoch).toISOString();
  await put(page, [earlier]);
  for (let step = 2; step <= 4; step++) {
    await page.clock.fastForward(10_000); await expect.poll(() => run.reads.length).toBe(step);
  }
  expect(run.reads).toEqual([id(1), id(2), id(3), id(0)]);
});

test('small unthrottled mixed inventory acquires no shared wait', async ({ page }) => {
  const run = await setup(page, [report(1), report(2, true), report(3)], () => ({ status: 200 }));
  await expect.poll(() => run.reads.length).toBe(3);
  await expect.poll(async () => (await run.probe()).responses.length).toBe(3);
  expect(run.reads).toEqual([id(1), id(2), id(3)]);
  expect((await run.probe()).attempts.filter((request: { path: string }) => request.path.endsWith('/findings'))
    .map((request: { at: number }) => request.at)).toEqual([epoch, epoch, epoch]);
});

for (const pause of ['event-race', 'visibility'] as const) test(`in-flight terminal read retains demand after ${pause} abort`, async ({ page }, info) => {
  const run = await setup(page, [report(1), report(2)], (key, attempt) => key === id(1) && attempt === 1
    ? { status: 429, headers: { 'Retry-After': '10' } } : { status: 200 });
  await expect.poll(() => run.reads.length).toBe(1);
  await page.evaluate(key => {
    const original = window.fetch.bind(window); let held = false;
    window.fetch = async (...args) => {
      const response = await original(...args);
      if (!held && new URL(String(args[0]), location.href).pathname === `/api/reports/${key}/findings`) {
        held = true;
        await new Promise<void>(resolve => { (window as any).heldReadResponse = { release: resolve }; });
      }
      return response;
    };
  }, id(2));
  try {
    await page.clock.fastForward(10_000);
    await expect.poll(() => page.evaluate(() => typeof (window as any).heldReadResponse?.release)).toBe('function');
    await page.evaluate(pause => {
      if (pause === 'visibility') {
        Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
        document.dispatchEvent(new Event('visibilitychange'));
      } else {
        // Deliberately deliver the event before navigator changes; the existing timer owns recovery.
        window.dispatchEvent(new Event('offline'));
      }
      (window as any).heldReadResponse.release();
    }, pause);
    await expect.poll(async () => (await run.probe()).canceled.filter((path: string) => path.endsWith(`${id(2)}/findings`)).length).toBeGreaterThan(0);
    if (pause === 'visibility') {
      await page.clock.fastForward(2_000); expect(run.reads.filter(key => key === id(2))).toHaveLength(1);
      await page.evaluate(() => {
        Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' });
        document.dispatchEvent(new Event('visibilitychange'));
      });
    } else await page.clock.fastForward(2_000);
    await expect.poll(() => run.reads.filter(key => key === id(2)).length).toBe(2);
    expect((await rows(page)).find(row => row.report.id === id(2))!.note).toBe('private-2');
    await info.attach('interrupted-read', { body: JSON.stringify({ pause, reads: run.reads, probe: await run.probe() }), contentType: 'application/json' });
  } finally {
    await page.evaluate(() => { (window as any).heldReadResponse?.release(); });
  }
});

test('a storage failure at the read-only wrap preserves data and permits later recovery', async ({ page }, info) => {
  const initial = [report(1), report(2), report(3)];
  const run = await setup(page, initial, (key, attempt) => key === id(1) && attempt === 1
    ? { status: 429, headers: { 'Retry-After': '10' } } : { status: 200 });
  await expect.poll(() => run.reads.length).toBe(1);
  await page.evaluate(key => {
    const fetch = window.fetch.bind(window), getAll = IDBObjectStore.prototype.getAll;
    const state = { armed: false, injected: 0, restore: () => { window.fetch = fetch; IDBObjectStore.prototype.getAll = getAll; } };
    (window as any).wrapStorageFailure = state;
    window.fetch = async (...args) => {
      const response = await fetch(...args);
      if (new URL(String(args[0]), location.href).pathname === `/api/reports/${key}/findings`) state.armed = true;
      return response;
    };
    IDBObjectStore.prototype.getAll = function (...args) {
      if (this.name === 'reports' && state.armed) {
        state.armed = false; state.injected++;
        throw new DOMException('Controlled wrap snapshot failure', 'UnknownError');
      }
      return Reflect.apply(getAll, this, args);
    };
  }, id(3));
  try {
    await page.clock.fastForward(10_000);
    await expect.poll(() => page.evaluate(() => (window as any).wrapStorageFailure.injected)).toBe(1);
    await expect(page.getByRole('alert').filter({ hasText: 'Nie udało się zapisać danych na urządzeniu. Spróbuj ponownie.' })).toBeVisible();
    expect(await rows(page)).toEqual(initial);
    expect(run.reads).toEqual([id(1), id(2), id(3)]);
    await page.clock.fastForward(2_000); await expect.poll(() => run.reads.length).toBe(4);
    expect(run.reads[3]).toBe(id(1)); expect(await rows(page)).toEqual(initial);
    await info.attach('wrap-storage-recovery', { body: JSON.stringify({ reads: run.reads, probe: await run.probe() }), contentType: 'application/json' });
  } finally {
    await page.evaluate(() => (window as any).wrapStorageFailure.restore());
  }
});

test('ongoing arrivals cannot extend the current finite read round', async ({ page }, info) => {
  const initial = [report(1), report(2, true)];
  const run = await setup(page, initial, () => ({ status: 429, headers: { 'Retry-After': '10' } }));
  await expect.poll(() => run.reads.length).toBe(1);
  // Two initial members, then four members at the next round boundary. Later
  // arrivals must not extend those rounds while the older IDs remain eligible.
  for (const next of [3, 4, 5, 6, 7]) {
    await put(page, [report(next, true)]);
    await page.clock.fastForward(10_000);
    await expect.poll(() => run.reads.length).toBe(next - 1);
  }
  await info.attach('continuous-arrival-turns', { body: JSON.stringify({ initialIds: initial.map(row => row.report.id),
    arrivals: [3, 4, 5, 6, 7].map(id), reads: run.reads, probe: await run.probe() }), contentType: 'application/json' });
  for (const older of initial) expect(run.reads.filter(key => key === older.report.id).length).toBeGreaterThanOrEqual(2);
});
