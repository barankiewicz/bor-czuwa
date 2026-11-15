import { test, expect, type Page } from '@playwright/test';
import { answerNow, footer } from './stages.ts';

test.use({ storageState: { cookies: [], origins: [] }, permissions: [], locale: 'pl-PL', serviceWorkers: 'block' });

async function location(page: Page, permission: PermissionState | 'missing' = 'prompt') {
  await page.addInitScript(permission => {
    let requested = 0;
    let failed: PositionErrorCallback | null | undefined;
    let received: PositionCallback;
    if (permission === 'missing') Object.defineProperty(navigator, 'permissions', { value: undefined });
    else {
      const query = navigator.permissions.query.bind(navigator.permissions);
      navigator.permissions.query = ((options: PermissionDescriptor) => options.name === 'geolocation'
        ? Promise.resolve({ state: permission } as PermissionStatus) : query(options)) as typeof query;
    }
    navigator.geolocation.watchPosition = (success, failure) => { requested++; received = success; failed = failure; return requested; };
    navigator.geolocation.clearWatch = () => {};
    Object.assign(window, {
      locationRequests: () => requested,
      refuseLocation: () => failed?.({ code: 1 } as GeolocationPositionError),
      grantLocation: () => received({ timestamp: Date.now(), coords: { latitude: 52.2297, longitude: 21.0122, accuracy: 17 } } as GeolocationPosition)
    });
  }, permission);
}
const requests = (page: Page) => page.evaluate(() => (window as unknown as { locationRequests(): number }).locationRequests());
const welcome = (page: Page) => page.getByRole('heading', { name: 'Zanim zaczniesz', exact: true });
const capture = (page: Page) => footer(page).getByRole('button', { name: 'Zapisz miejsce i czas', exact: true });
const allow = (page: Page) => page.getByRole('button', { name: 'Zezwól na lokalizację', exact: true });
const skip = (page: Page) => page.getByRole('button', { name: 'Dalej bez lokalizacji', exact: true });

for (const permission of ['prompt', 'granted', 'missing'] as const) {
  test(`first launch requests GPS only after consent (${permission}) and keeps quick capture local`, async ({ page }) => {
    await location(page, permission);
    const uploads: string[] = [];
    page.on('request', request => {
      if (request.method() === 'POST' && new URL(request.url()).pathname === '/api/reports') uploads.push(request.url());
    });
    await page.goto('/');
    await expect(welcome(page)).toBeVisible();
    expect(await requests(page)).toBe(0);
    await expect(page.getByText('Zgłoszenie nie sprowadza pomocy.', { exact: true })).toBeVisible();
    await allow(page).click();
    await expect(capture(page)).toBeVisible();
    await expect.poll(() => requests(page)).toBe(1);
    expect(await page.evaluate(() => localStorage.getItem('first-launch-seen'))).toBe('1');
    await page.evaluate(() => (window as unknown as { grantLocation(): void }).grantLocation());
    const started = await page.evaluate(() => Date.now());
    await capture(page).click();
    await expect(page.locator('#receipt')).toBeVisible();
    const draftId = new URL(page.url()).searchParams.get('draft');
    expect(draftId).toBeTruthy();
    const saved = await page.evaluate(() => new Promise<{ drafts: { capturedAt: string }[]; reports: number; at: number }>((resolve, reject) => {
      const opening = indexedDB.open('bor-czuwa');
      opening.onerror = () => reject(opening.error);
      opening.onsuccess = () => {
        const db = opening.result;
        const transaction = db.transaction(['drafts', 'reports']);
        const drafts = transaction.objectStore('drafts').getAll();
        const reports = transaction.objectStore('reports').count();
        transaction.oncomplete = () => {
          db.close();
          resolve({ drafts: drafts.result, reports: reports.result, at: Date.now() });
        };
        transaction.onerror = () => { db.close(); reject(transaction.error); };
      };
    }));
    expect(saved.drafts).toHaveLength(1);
    expect(saved.drafts[0]).toMatchObject({ id: draftId, eventType: null, quickCapture: true,
      fix: { lat: 52.2297, lon: 21.0122, accuracy_m: 17 } });
    expect(Date.parse(saved.drafts[0].capturedAt)).toBeGreaterThanOrEqual(started);
    expect(Date.parse(saved.drafts[0].capturedAt)).toBeLessThanOrEqual(saved.at);
    expect(saved.reports).toBe(0);
    expect(uploads).toEqual([]);
    expect(await requests(page)).toBe(1);
  });
}

test('continue without location persists and Menu information never requests it', async ({ page }) => {
  await location(page);
  await page.goto('/');
  await skip(page).click();
  await expect(capture(page)).toBeVisible();
  expect(await requests(page)).toBe(0);
  await page.reload();
  await expect(capture(page)).toBeVisible();
  expect(await requests(page)).toBe(0);
  await page.getByRole('button', { name: 'Menu', exact: true }).click();
  await page.getByRole('button', { name: 'Informacje na początek', exact: true }).click();
  await expect(welcome(page)).toBeVisible();
  await expect(allow(page)).toHaveCount(0);
  await expect(skip(page)).toHaveCount(0);
  await page.getByRole('button', { name: 'Wróć do aplikacji', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Menu', exact: true })).toBeVisible();
  expect(await requests(page)).toBe(0);
  expect(await page.evaluate(() => localStorage.getItem('first-launch-seen'))).toBe('1');
});

for (const action of ['refuse', 'dismiss', 'unavailable'] as const) {
  test(`${action} leaves capture and manual location usable`, async ({ page }) => {
    await location(page);
    if (action === 'unavailable') await page.addInitScript(() => Object.defineProperty(navigator, 'geolocation', { value: undefined }));
    await page.goto('/');
    await allow(page).click();
    await expect(capture(page)).toBeVisible();
    if (action === 'refuse') await page.evaluate(() => (window as unknown as { refuseLocation(): void }).refuseLocation());
    await page.getByRole('button', { name: 'Strzał', exact: true }).click();
    await answerNow(page);
    await expect(page.getByRole('heading', { name: 'Skąd padł strzał?', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Pokaż mapę', exact: true })).toBeVisible();
    if (action === 'refuse') {
      await expect(page.getByText('Aby włączyć GPS, otwórz ustawienia uprawnień tej strony w przeglądarce', { exact: false })).toBeVisible();
      await expect(page.getByRole('button', { name: 'Spróbuj ustalić miejsce ponownie', exact: true })).toHaveCount(0);
    }
    if (action !== 'unavailable') expect(await requests(page)).toBe(1);
  });
}

test('blocked preferences stay visible without trapping the introduction or capture', async ({ page }) => {
  await location(page);
  await page.addInitScript(() => {
    Storage.prototype.setItem = () => { throw new DOMException('blocked', 'SecurityError'); };
  });
  await page.goto('/');
  await skip(page).click();
  await expect(capture(page)).toBeVisible();
  await expect(page.getByRole('alert')).toContainText('Nie udało się zapamiętać ustawień.');
  await capture(page).click();
  await expect(page.locator('#receipt')).toBeVisible();
});

test('returning launch starts one GPS session immediately', async ({ page }) => {
  await location(page, 'granted');
  await page.addInitScript(() => localStorage.setItem('first-launch-seen', '1'));
  await page.goto('/');
  await expect(capture(page)).toBeVisible();
  await expect(welcome(page)).toHaveCount(0);
  await expect.poll(() => requests(page)).toBe(1);
});

test('device English is the default and an explicit Polish preference survives reload', async ({ page }) => {
  await page.addInitScript(() => Object.defineProperty(navigator, 'language', { value: 'en-GB' }));
  await page.goto('/');
  await expect(page.locator('html')).toHaveAttribute('lang', 'en');
  await page.getByRole('button', { name: 'Polski', exact: true }).click();
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('lang', 'pl');
});

test('a Draft deep link survives the introduction, reload and Back', async ({ page }) => {
  await location(page);
  await page.goto('/');
  await skip(page).click();
  await page.getByRole('button', { name: 'Strzał', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Kiedy to się stało?' })).toBeVisible();
  const url = page.url();
  await page.evaluate(() => localStorage.removeItem('first-launch-seen'));
  await page.reload();
  await expect(welcome(page)).toBeVisible();
  expect(page.url()).toBe(url);
  expect(await requests(page)).toBe(0);
  await page.reload();
  await skip(page).click();
  await expect(page.getByRole('heading', { name: 'Kiedy to się stało?' })).toBeVisible();
  expect(page.url()).toBe(url);
  await page.getByRole('button', { name: 'Wróć', exact: true }).click();
  await expect(welcome(page)).toHaveCount(0);
  await expect(capture(page)).toBeVisible();
  await page.getByRole('button', { name: 'Moje zapisy', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Usuń szkic', exact: true })).toHaveCount(1);
});

test('refused access is not asked again after foreground return or reload', async ({ page }) => {
  await location(page, 'denied');
  await page.goto('/');
  await allow(page).click();
  await expect(capture(page)).toBeVisible();
  await page.evaluate(() => (window as unknown as { refuseLocation(): void }).refuseLocation());
  await page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
    document.dispatchEvent(new Event('visibilitychange'));
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  expect(await requests(page)).toBe(1);
  await page.reload();
  await expect(capture(page)).toBeVisible();
  expect(await requests(page)).toBe(0);
});
