import { test, expect, type Page } from '@playwright/test';
import { clockedGeolocation, expectQuickTabStaysOut, finishFromWhen } from './stages.ts';
import { Client } from 'pg';
import { testDatabaseUrl } from '../helpers/test-database.ts';
import { postReport } from '../helpers/reports.ts';
import { android } from './native-notifications.ts';
import type { Report } from '../../src/lib/report.ts';

const base = process.env.TEST_BASE_URL ?? 'http://127.0.0.1:3001';

test.beforeEach(async ({ page, context }) => {
  await clockedGeolocation(page);
  await context.setGeolocation({ latitude: 52, longitude: 21, accuracy: 8 });
});

async function capture(page: Page) {
  await page.goto('/');
  await page.getByRole('button', { name: 'Człowiek z bronią', exact: true }).click();
  await finishFromWhen(page, false);
  await page.getByRole('button', { name: 'Zapisz zgłoszenie' }).click();
  await expect(page.getByRole('heading', { name: 'Zgłoszenie', exact: true })).toBeVisible();
}

function storedRows(page: Page, store: 'reports' | 'withdrawals') {
  return page.evaluate(store => new Promise<any[]>((resolve, reject) => {
    const request = indexedDB.open('bor-czuwa');
    request.onsuccess = () => {
      const db = request.result;
      const rows = db.transaction(store).objectStore(store).getAll();
      rows.onsuccess = () => { db.close(); resolve(rows.result.map(row => store === 'reports' ? { id: row.report.id, token: row.token } : row)); };
      rows.onerror = () => reject(rows.error);
    };
    request.onerror = () => reject(request.error);
  }), store);
}

test('withdrawing a queued Report keeps only retry authorization until server confirms absence', async ({ page }) => {
  await page.route('**/api/challenge', route => route.fulfill({ status: 503, body: '{}' }));
  await capture(page);
  await expect(page.getByText('Dane znikną z tego telefonu.', { exact: false })).toHaveCount(0);
  const [{ id }] = await storedRows(page, 'reports');
  let attempts = 0;
  await page.route(`**/api/reports/${id}`, route => { expect(route.request().headers()['content-type']).toBe('application/json'); attempts++; return route.fulfill({ status: 503, body: '{}' }); });
  await page.getByRole('button', { name: 'Wycofaj zgłoszenie' }).click();
  // The app's own inline confirmation, never a native dialog, with the safe choice focused.
  page.on('dialog', dialog => { throw new Error(`native dialog: ${dialog.message()}`); });
  const confirmation = page.getByRole('group', { name: 'Wycofać to zgłoszenie?' });
  await expect(confirmation.getByText('Dane znikną z tego telefonu.', { exact: false })).toBeVisible();
  await expect(confirmation.getByRole('button', { name: 'Anuluj', exact: true })).toBeFocused();
  // While the Withdrawal saves, Wycofaj is disabled and must stay legible: ink fill, paper text (ticket 29 review).
  const busyContrast = await confirmation.getByRole('button', { name: 'Wycofaj', exact: true }).evaluate(button => {
    button.setAttribute('disabled', '');
    const style = getComputedStyle(button);
    const lum = (value: string) => {
      const [r, g, b] = value.match(/[\d.]+/g)!.slice(0, 3).map(part => { const v = Number(part) / 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; });
      return 0.2126 * r + 0.7152 * g + 0.0722 * b;
    };
    const [high, low] = [lum(style.color), lum(style.backgroundColor)].sort((a, b) => b - a);
    button.removeAttribute('disabled');
    return (high + 0.05) / (low + 0.05);
  });
  expect(busyContrast).toBeGreaterThanOrEqual(4.5);
  await confirmation.getByRole('button', { name: 'Wycofaj', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Moje zapisy' })).toBeVisible();
  const result = page.locator('#withdrawal-result');
  await expect(result).toHaveText('Zgłoszenie wycofane z telefonu. Usunięcie z serwera potwierdzimy, gdy będzie połączenie.');
  await expect(result).toBeFocused();
  await expect(page.getByText('Usuwanie z serwera w toku', { exact: false })).toBeVisible();
  expect(await storedRows(page, 'reports')).toEqual([]);
  expect(await storedRows(page, 'withdrawals')).toMatchObject([{ id }]);
  await expect.poll(() => attempts).toBeGreaterThan(0);
  // Reconnection respects the persisted retry deadline. Start the presentation
  // assertion only after the real server has confirmed deletion.
  const deletion = page.waitForResponse(response => new URL(response.url()).pathname === `/api/reports/${id}`
    && response.request().method() === 'DELETE' && response.status() === 204);
  await page.unroute('**/api/challenge');
  await page.unroute(`**/api/reports/${id}`);
  // Once the server confirms, the same line says so in place.
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  await deletion;
  await expect(result).toHaveText('Zgłoszenie wycofane. Dane usunięto z telefonu i serwera.');
  await expect(page.getByText('Usuwanie z serwera w toku', { exact: false })).toHaveCount(0);
  await page.reload();
  await expect.poll(async () => (await storedRows(page, 'withdrawals')).length).toBe(0);
  const database = new Client({ connectionString: testDatabaseUrl() });
  await database.connect();
  try { expect((await database.query('SELECT 1 FROM report WHERE id = $1', [id])).rowCount).toBe(0); }
  finally { await database.end(); }
});

test('offline withdrawal removes local details and retries server deletion after restart', async ({ page, context }) => {
  await capture(page);
  await expect(page.getByText('Zapisano na serwerze.', { exact: true })).toBeVisible({ timeout: 30_000 });
  const [{ id, token }] = await storedRows(page, 'reports');
  const findings = () => fetch(`${base}/api/reports/${id}/findings`, { headers: { authorization: `Bearer ${token}` } });
  expect((await findings()).status).toBe(200);

  await context.setOffline(true);
  await page.getByRole('button', { name: 'Wycofaj zgłoszenie' }).click();
  await page.getByRole('button', { name: 'Wycofaj', exact: true }).click();
  await expect(page.getByText('Usuwanie z serwera w toku', { exact: false })).toBeVisible();
  expect(await storedRows(page, 'reports')).toEqual([]);
  expect(await storedRows(page, 'withdrawals')).toMatchObject([{ id, token }]);
  expect((await findings()).status).toBe(200);

  await page.reload();
  await page.getByRole('button', { name: 'Bór czuwa' }).click();
  // The server deletion is the app's work, never a task, and home says nothing about it.
  await expect(page.locator('.calm')).toHaveCount(0);
  await expect(page.locator('.continuation')).toHaveCount(0);
  await context.setOffline(false);
  await expect.poll(async () => (await storedRows(page, 'withdrawals')).length).toBe(0);
  expect((await findings()).status).toBe(404);
});

test('a refused server deletion keeps the Withdrawal pending and never brings the Report back', async ({ page }) => {
  await capture(page);
  await expect(page.getByText('Zapisano na serwerze.', { exact: true })).toBeVisible({ timeout: 30_000 });
  const [{ id, token }] = await storedRows(page, 'reports');
  let refusals = 0;
  await page.route(`**/api/reports/${id}`, route => { refusals++; return route.fulfill({ status: 404, body: '{}' }); });
  await page.getByRole('button', { name: 'Wycofaj zgłoszenie' }).click();
  await page.getByRole('button', { name: 'Wycofaj', exact: true }).click();
  await expect.poll(() => refusals).toBeGreaterThan(0);
  await expect(page.locator('#withdrawal-result')).toHaveText('Zgłoszenie wycofane z telefonu. Usunięcie z serwera potwierdzimy, gdy będzie połączenie.');
  await expect(page.locator('#withdrawal-result')).toBeFocused();
  await expect(page.getByText('Wycofane zgłoszenie', { exact: true })).toBeVisible();
  await expect(page.getByText('Usuwanie z serwera w toku', { exact: false })).toBeVisible();
  await expect(page.getByRole('button', { name: /^Człowiek z bronią, / })).toHaveCount(0);
  expect(await storedRows(page, 'reports')).toEqual([]);
  expect(await storedRows(page, 'withdrawals')).toMatchObject([{ id, token }]);
  await page.reload();
  await page.getByRole('button', { name: 'Bór czuwa' }).click();
  // Pending server deletion is the app's work: a status in history, never a home card.
  await expect(page.locator('.calm')).toHaveCount(0);
  await expect(page.locator('.continuation')).toHaveCount(0);
  await page.getByRole('button', { name: 'Moje zapisy' }).click();
  await expect(page.getByText('Usuwanie z serwera w toku', { exact: false })).toBeVisible();
  await expect(page.locator('#withdrawal-result')).toHaveCount(0);
  expect(await storedRows(page, 'withdrawals')).toMatchObject([{ id, token }]);
});

test('withdrawal Retry-After survives restart and online events', async ({ page }) => {
  const now = Date.parse('2026-10-24T22:00:00Z');
  await page.route('**/api/reports', route => route.fulfill({ status: 201, body: '{}' }));
  await page.route('**/api/reports/*/findings', route => route.fulfill({
    json: { status: 'failed', reason: 'test' }
  }));
  await page.clock.install({ time: new Date(now) });
  await capture(page);
  await expect(page.getByText('Zapisano na serwerze.', { exact: true })).toBeVisible({ timeout: 30_000 });
  const [{ id }] = await storedRows(page, 'reports');
  let deletes = 0;
  await page.route(`**/api/reports/${id}`, route => {
    deletes++;
    return deletes === 1 ? route.fulfill({ status: 429, headers: { 'Retry-After': '3600' }, body: '{}' })
      : route.fulfill({ status: 204, body: '' });
  });
  await page.getByRole('button', { name: 'Wycofaj zgłoszenie' }).click();
  await page.getByRole('button', { name: 'Wycofaj', exact: true }).click();
  await expect.poll(async () => (await storedRows(page, 'withdrawals'))[0]?.retry_at)
    .toBeGreaterThanOrEqual(now + 3_600_000);
  expect((await storedRows(page, 'withdrawals'))[0].retry_at).toBeLessThan(now + 3_610_000);
  await page.reload();
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  expect(deletes).toBe(1);
  await page.clock.fastForward(3_600_001);
  await expect.poll(async () => (await storedRows(page, 'withdrawals')).length).toBe(0);
  expect(deletes).toBe(2);
});

test('committed POST with lost response cannot recreate Report after offline withdrawal', async ({ page, context }) => {
  let committed!: () => void;
  const posted = new Promise<void>(resolve => { committed = resolve; });
  await page.route('**/api/reports', async route => {
    if (route.request().method() !== 'POST') return route.continue();
    const response = await route.fetch();
    expect(response.status()).toBe(201);
    committed();
    await route.abort('failed');
  });
  await capture(page);
  const saved = await page.evaluate(() => new Promise<{ report: Report; token: string }>((resolve, reject) => {
    const request = indexedDB.open('bor-czuwa');
    request.onsuccess = () => {
      const db = request.result;
      const row = db.transaction('reports').objectStore('reports').getAll();
      row.onsuccess = () => { db.close(); resolve(row.result[0]); };
      row.onerror = () => reject(row.error);
    };
    request.onerror = () => reject(request.error);
  }));
  await posted;
  await context.setOffline(true);
  await page.getByRole('button', { name: 'Wycofaj zgłoszenie' }).click();
  await page.getByRole('button', { name: 'Wycofaj', exact: true }).click();
  expect(await storedRows(page, 'reports')).toEqual([]);
  expect(await storedRows(page, 'withdrawals')).toMatchObject([{ id: saved.report.id, token: saved.token }]);
  await page.reload();
  await page.unroute('**/api/reports');
  await context.setOffline(false);
  await expect.poll(async () => (await storedRows(page, 'withdrawals')).length).toBe(0);
  expect((await postReport(base, saved.report)).status).toBe(410);
  const database = new Client({ connectionString: testDatabaseUrl() });
  await database.connect();
  try { expect((await database.query('SELECT 1 FROM report WHERE id = $1', [saved.report.id])).rowCount).toBe(0); }
  finally { await database.end(); }
});

test('lost DELETE response keeps intent until retry confirms server absence', async ({ page }) => {
  await capture(page);
  await expect(page.getByText('Zapisano na serwerze.', { exact: true })).toBeVisible({ timeout: 30_000 });
  const [{ id, token }] = await storedRows(page, 'reports');
  let deleted!: () => void;
  const firstDelete = new Promise<void>(resolve => { deleted = resolve; });
  await page.route(`**/api/reports/${id}`, async route => {
    const response = await route.fetch();
    expect(response.status()).toBe(204);
    deleted();
    await route.abort('failed');
  });
  await page.getByRole('button', { name: 'Wycofaj zgłoszenie' }).click();
  await page.getByRole('button', { name: 'Wycofaj', exact: true }).click();
  await firstDelete;
  expect(await storedRows(page, 'withdrawals')).toMatchObject([{ id, token }]);
  await page.unroute(`**/api/reports/${id}`);
  await page.reload();
  await expect.poll(async () => (await storedRows(page, 'withdrawals')).length).toBe(0);
  expect((await fetch(`${base}/api/reports/${id}/findings`, { headers: { authorization: `Bearer ${token}` } })).status).toBe(404);
});

test('two tabs cannot upload after another tab withdraws', async ({ page, context }) => {
  let uploadStarted!: () => void;
  let releaseUpload!: () => void;
  const started = new Promise<void>(resolve => { uploadStarted = resolve; });
  const released = new Promise<void>(resolve => { releaseUpload = resolve; });
  await page.route('**/api/reports', async route => {
    if (route.request().method() !== 'POST') return route.continue();
    uploadStarted();
    await released;
    await route.continue();
  });
  await capture(page);
  const [{ id, token }] = await storedRows(page, 'reports');
  await started;
  const other = await context.newPage();
  await other.route('**/api/reports', route => route.request().method() === 'POST' ? route.abort('failed') : route.continue());
  await other.goto('/');
  await other.getByRole('button', { name: 'Moje zapisy' }).click();
  await expect(other.getByRole('heading', { name: 'Moje zapisy' })).toBeVisible();
  await other.getByRole('button', { name: /^Człowiek z bronią, / }).click();
  await other.getByRole('button', { name: 'Wycofaj zgłoszenie' }).click();
  await other.getByRole('button', { name: 'Wycofaj', exact: true }).click();
  expect(await storedRows(other, 'reports')).toEqual([]);
  expect(await storedRows(page, 'reports')).toEqual([]);
  await expect(page.getByRole('heading', { name: 'Moje zapisy' })).toBeVisible();
  await other.reload();
  await expect.poll(async () => (await storedRows(other, 'withdrawals')).length).toBe(0);
  releaseUpload();
  expect(await storedRows(page, 'reports')).toEqual([]);
  expect((await fetch(`${base}/api/reports/${id}/findings`, { headers: { authorization: `Bearer ${token}` } })).status).toBe(404);
});


test('Android completes Withdrawal only after clearing attachment copies; cleanup failure retries', async ({ page, context }) => {
  await android(context);
  await context.addInitScript(() => {
    const native = window as any;
    const original = native.Capacitor.nativePromise;
    native.mailCleanup = { calls: 0, fails: true };
    native.Capacitor.PluginHeaders.push({ name: 'NoticeMail', methods: [{ name: 'clear', rtype: 'promise' }] });
    native.Capacitor.nativePromise = async (plugin: string, method: string, options: unknown) => {
      if (plugin !== 'NoticeMail') return original(plugin, method, options);
      native.mailCleanup.calls++;
      if (native.mailCleanup.fails) throw new Error('mail_cache_cleanup_failed');
      return {};
    };
  });
  await page.route('**/api/challenge', route => route.fulfill({ status: 503, body: '{}' }));
  await capture(page);
  const [{ id }] = await storedRows(page, 'reports');
  let deleted = false;
  await page.route(`**/api/reports/${id}`, route => {
    deleted = true; return route.fulfill({ status: 200, body: '{}' });
  });
  await page.getByRole('button', { name: 'Wycofaj zgłoszenie' }).click();
  await page.getByRole('button', { name: 'Wycofaj', exact: true }).click();
  await expect.poll(() => deleted).toBe(true);
  await expect.poll(() => page.evaluate(() => (window as any).mailCleanup.calls)).toBeGreaterThan(0);
  expect(await storedRows(page, 'withdrawals')).toMatchObject([{ id }]);
  await expect(page.locator('#withdrawal-result')).toContainText('Usunięcie z serwera potwierdzimy');
  await page.evaluate(async () => {
    (window as any).mailCleanup.fails = false;
    const request = indexedDB.open('bor-czuwa');
    const db = await new Promise<IDBDatabase>(resolve => { request.onsuccess = () => resolve(request.result); });
    const tx = db.transaction('withdrawals', 'readwrite');
    const rows = tx.objectStore('withdrawals').getAll();
    rows.onsuccess = () => { for (const row of rows.result) tx.objectStore('withdrawals').put({ ...row, retry_at: 0 }); };
    await new Promise<void>(resolve => { tx.oncomplete = () => resolve(); });
    db.close();
    window.dispatchEvent(new Event('online'));
  });
  await expect.poll(async () => (await storedRows(page, 'withdrawals')).length).toBe(0);
  await expect(page.locator('#withdrawal-result')).toHaveText('Zgłoszenie wycofane. Dane usunięto z telefonu i serwera.');
});

test('Withdrawal leaves remembered signer details in place, and the Menu row still removes them', async ({ page }) => {
  await capture(page);
  await expect(page.getByText('Zapisano na serwerze.', { exact: true })).toBeVisible({ timeout: 30_000 });
  const [{ id }] = await storedRows(page, 'reports');
  await page.getByRole('button', { name: 'Przygotuj powiadomienie' }).click();
  await page.getByRole('button', { name: 'Nie wiem, która gmina' }).click();
  await page.getByRole('button', { name: 'Wybierz jednostkę po nazwie', exact: true }).click();
  await page.getByLabel('Nazwa lub miejscowość').fill('Monkach');
  await page.getByRole('button', { name: /Komenda Powiatowa Policji w Mońkach/ }).click();
  await page.getByRole('button', { name: 'Dalej: podpis' }).click();
  await page.getByRole('radio', { name: 'Z podpisem' }).check();
  await page.getByLabel('Imię i nazwisko').fill('Anna Nowak');
  await page.getByLabel('Adres do korespondencji').fill('ul. Polna 2');
  await page.getByLabel('Telefon (opcjonalnie)').fill('600100299');
  await page.getByLabel('Zapamiętaj te dane na tym telefonie').check();
  await page.getByRole('button', { name: 'Przygotuj powiadomienia' }).click();
  await expect.poll(() => signerRows(page)).toEqual([{ id: 'mine', details: { name: 'Anna Nowak', address: 'ul. Polna 2', phone: '600100299' } }]);

  await page.getByRole('button', { name: 'Moje zapisy' }).click();
  await page.getByRole('button', { name: /^Człowiek z bronią, / }).click();
  const deletion = page.waitForResponse(response => new URL(response.url()).pathname === `/api/reports/${id}`
    && response.request().method() === 'DELETE' && response.status() === 204);
  await page.getByRole('button', { name: 'Wycofaj zgłoszenie' }).click();
  await page.getByRole('button', { name: 'Wycofaj', exact: true }).click();
  await deletion;
  await expect.poll(async () => (await storedRows(page, 'reports')).length).toBe(0);
  await expect.poll(async () => (await storedRows(page, 'withdrawals')).length).toBe(0);
  expect(await signerRows(page)).toHaveLength(1);

  await page.getByRole('button', { name: 'Menu' }).click();
  const row = page.getByRole('region', { name: 'Zapamiętane dane podpisu' });
  await expect(row).toBeVisible();
  await row.getByRole('button', { name: 'Usuń zapamiętane dane podpisu' }).click();
  await page.getByRole('group', { name: 'Usunąć zapamiętane dane podpisu?' }).getByRole('button', { name: 'Usuń', exact: true }).click();
  await expect(row).toHaveCount(0);
  expect(await signerRows(page)).toEqual([]);
});

function signerRows(page: Page) {
  return page.evaluate(() => new Promise<unknown[]>((resolve, reject) => {
    const request = indexedDB.open('bor-czuwa');
    request.onsuccess = () => {
      const db = request.result;
      const rows = db.transaction('signer').objectStore('signer').getAll();
      rows.onsuccess = () => { db.close(); resolve(rows.result); };
      rows.onerror = () => reject(rows.error);
    };
    request.onerror = () => reject(request.error);
  }));
}

test('a quick Tab after opening the Withdrawal confirm does not walk into it or lose focus to Anuluj', async ({ page }) => {
  await page.route('**/api/reports', route => route.fulfill({ status: 201, body: '{}' }));
  await page.route('**/api/reports/*/findings', route => route.fulfill({ json: { status: 'pending' } }));
  await capture(page);
  await expectQuickTabStaysOut(page, page.getByRole('button', { name: 'Wycofaj zgłoszenie' }), '.withdrawal-confirm');
});
