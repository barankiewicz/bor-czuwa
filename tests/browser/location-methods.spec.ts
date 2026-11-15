import { test, expect, type Page } from '@playwright/test';
import { answerNow, answerHome, blankTiles, footer, heading, reportPost, save, setEstimate, startEvent } from './stages.ts';

test.use({ serviceWorkers: 'block', hasTouch: true, isMobile: true });

async function delayedGps(page: Page) {
  await page.addInitScript(() => {
    let callback: PositionCallback;
    navigator.geolocation.watchPosition = success => { callback = success; return 1; };
    navigator.geolocation.clearWatch = () => {};
    Object.assign(window, { releaseGps: () => callback({ timestamp: Date.now(), coords: {
      latitude: 52.2297, longitude: 21.0122, accuracy: 12
    } } as GeolocationPosition) });
  });
}
async function coordinates(page: Page, lat = '52.25', lon = '21.03') {
  const details = page.locator('details.advanced');
  if (!await details.evaluate(node => (node as HTMLDetailsElement).open)) await details.locator('summary').click();
  await page.getByLabel('Szerokość geograficzna').fill(lat);
  await page.getByLabel('Długość geograficzna').fill(lon);
  await page.getByRole('button', { name: 'Wskaż wpisany punkt' }).click();
}

test('late GPS keeps manual selection required and offers direction without moving controls or focus', async ({ page }) => {
  await delayedGps(page);
  await page.goto('/');
  await startEvent(page, 'Strzał');
  await answerNow(page);
  const direction = page.getByRole('button', { name: 'Kierunek', exact: true });
  const manual = page.getByRole('button', { name: 'Wskaż miejsce', exact: true });
  await expect(direction).toHaveAttribute('aria-disabled', 'true');
  await expect(manual).toHaveAttribute('aria-pressed', 'true');
  await manual.focus();
  const before = await manual.boundingBox();
  await page.evaluate(() => (window as unknown as { releaseGps(): void }).releaseGps());
  await expect(direction).toHaveAttribute('aria-disabled', 'false');
  await expect(manual).toBeFocused();
  expect(await manual.boundingBox()).toEqual(before);
  await expect(footer(page).getByRole('button', { name: 'Dalej', exact: true })).toHaveAttribute('aria-disabled', 'true');
  await expect(page.locator('.tile')).toHaveCount(0);
  await coordinates(page);
  await direction.click();
  await expect(page.getByRole('slider', { name: 'Tarcza kierunku' })).toHaveAttribute('aria-valuetext', 'Kierunek nie wybrany');
  await manual.click();
  await page.locator('details.advanced summary').click();
  await expect(page.getByLabel('Szerokość geograficzna')).toHaveValue('52.25000');
  await expect(page.getByLabel('Długość geograficzna')).toHaveValue('21.03000');
  await expect(footer(page).getByRole('button', { name: 'Dalej', exact: true })).toHaveAttribute('aria-disabled', 'false');
});

test('both methods survive reload and correction, and only active point reaches saved Report and HTTP', async ({ page, context }) => {
  await context.setGeolocation({ latitude: 52.2297, longitude: 21.0122, accuracy: 12 });
  await blankTiles(page);
  await page.goto('/');
  await startEvent(page, 'Strzał');
  await expect(page.getByText('Miejsce zapisane w szkicu.')).toBeAttached();
  await answerNow(page);
  await setEstimate(page, 0, 3000);
  await page.getByRole('button', { name: 'Wskaż miejsce', exact: true }).click();
  await coordinates(page);
  await page.getByLabel('Jak dokładnie?').press('Home');
  await expect(page.getByLabel('Jak dokładnie?')).toHaveValue('0');
  await expect.poll(() => page.evaluate(() => new Promise<number>(resolve => {
    const request = indexedDB.open('bor-czuwa');
    request.onsuccess = () => { const db = request.result; const read = db.transaction('drafts').objectStore('drafts').getAll();
      read.onsuccess = () => { resolve(read.result[0].pointRadiusM); db.close(); }; };
  }))).toBe(0);
  await page.reload();
  await expect(page.getByRole('button', { name: 'Wskaż miejsce', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await page.getByRole('button', { name: 'Kierunek', exact: true }).click();
  await expect(page.getByRole('slider', { name: 'Tarcza kierunku' })).toHaveAttribute('aria-valuenow', '0');
  await expect(page.getByRole('slider', { name: 'Tarcza kierunku' })).toHaveAttribute('aria-valuetext', 'na północ, 0°, około 3 km');
  await page.getByRole('button', { name: 'Wskaż miejsce', exact: true }).click();
  await footer(page).getByRole('button', { name: 'Dalej', exact: true }).click();
  await expect(heading(page, 'Sprawdź i zapisz')).toBeVisible();
  await page.getByRole('button', { name: 'Zmień: Gdzie', exact: true }).click();
  await coordinates(page, '52.26', '21.04');
  await footer(page).getByRole('button', { name: 'Dalej', exact: true }).click();
  await answerHome(page, false);
  const posted = await reportPost(page);
  await save(page);
  const payload = (await posted.request).postDataJSON();
  expect(payload.incident_location).toEqual({ lat: 52.26, lon: 21.04, source: 'moved_by_reporter' });
  expect(payload.device_fix).toBeNull();
  expect(JSON.stringify(payload)).not.toMatch(/hearing_|locationMethod|manualLat/);
});

test('manual map opens centered on GPS without selecting it, then reopening centers the chosen point', async ({ page, context }) => {
  await context.setGeolocation({ latitude: 52.2297, longitude: 21.0122, accuracy: 12 });
  await blankTiles(page);
  const paths: string[] = [];
  page.on('request', request => { if (request.url().includes('tile.openstreetmap.org')) paths.push(new URL(request.url()).pathname); });
  await page.goto('/');
  await startEvent(page, 'Strzał');
  await expect(page.getByText('Miejsce zapisane w szkicu.')).toBeAttached();
  await answerNow(page);
  await page.getByRole('button', { name: 'Wskaż miejsce', exact: true }).click();
  expect(paths).toEqual([]);
  await page.getByRole('button', { name: 'Pokaż mapę', exact: true }).click();
  await expect(page.locator('.tile')).toHaveCount(9);
  // Independent slippy-map calculation; a Poland overview or saved home must not seed these tiles.
  const x = Math.floor((21.0122 + 180) / 360 * 2 ** 14);
  const lat = 52.2297 * Math.PI / 180;
  const y = Math.floor((1 - Math.asinh(Math.tan(lat)) / Math.PI) / 2 * 2 ** 14);
  expect(paths.sort()).toEqual([x - 1, x, x + 1].flatMap(col => [y - 1, y, y + 1].map(row => `/14/${col}/${row}.png`)).sort());
  await expect(page.locator('.marker')).toHaveCount(0);
  await expect(footer(page).getByRole('button', { name: 'Dalej', exact: true })).toHaveAttribute('aria-disabled', 'true');
  await coordinates(page);
  await page.getByRole('button', { name: 'Ukryj mapę', exact: true }).click();
  await page.getByRole('button', { name: 'Pokaż mapę', exact: true }).click();
  const marker = page.locator('.marker');
  await expect(marker).toHaveCSS('left', await page.locator('.map-surface').evaluate(node => `${node.clientWidth / 2}px`));
});

for (const method of ['map', 'reporter'] as const) test(`home ${method} method sends only fixed privacy grid after switching`, async ({ page, context }) => {
  await context.setGeolocation({ latitude: 52.2297, longitude: 21.0122, accuracy: 12 });
  await page.goto('/');
  await startEvent(page, 'Strzał');
  await expect(page.getByText('Miejsce zapisane w szkicu.')).toBeAttached();
  await answerNow(page);
  await setEstimate(page, 0, 100);
  await page.getByRole('button', { name: 'Wskaż miejsce', exact: true }).click();
  await coordinates(page);
  if (method === 'reporter') await page.getByRole('button', { name: 'Kierunek', exact: true }).click();
  await footer(page).getByRole('button', { name: 'Dalej', exact: true }).click();
  await answerHome(page, true);
  const posted = await reportPost(page);
  await save(page);
  const payload = (await posted.request).postDataJSON();
  const origin = method === 'map' ? { lat: 52.25, lon: 21.03 } : { lat: 52.2297 + 100 / 111320, lon: 21.0122 };
  const south = Math.floor(origin.lat / (4 / 111)) * (4 / 111);
  const west = Math.floor(origin.lon / (4 / 70)) * (4 / 70);
  expect(payload.incident_location.bounds).toEqual([west, south, west + 4 / 70, south + 4 / 111].map(value => Number(value.toFixed(6))));
  expect(payload.incident_location.precise_fix_withheld).toBe('home_privacy');
  expect(payload.device_fix).toBeNull();
  expect(JSON.stringify(payload)).not.toMatch(/hearing_|52\.2297|21\.0122|manualLat|locationMethod/);
});

test('GPS arriving after manual selection preserves point and radius', async ({ page }) => {
  await delayedGps(page);
  await page.goto('/');
  await startEvent(page, 'Strzał');
  await answerNow(page);
  await coordinates(page);
  await page.getByLabel('Jak dokładnie?').press('End');
  await page.evaluate(() => (window as unknown as { releaseGps(): void }).releaseGps());
  await expect(page.getByRole('button', { name: 'Wskaż miejsce', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByLabel('Szerokość geograficzna')).toHaveValue('52.25000');
  await expect(page.getByLabel('Długość geograficzna')).toHaveValue('21.03000');
  await expect(page.getByLabel('Jak dokładnie?')).toHaveAttribute('aria-valuetext', 'w promieniu około 3 km');
});

test('denied GPS leaves coordinate selection available without map requests', async ({ page }) => {
  await page.addInitScript(() => {
    const query = navigator.permissions.query.bind(navigator.permissions);
    navigator.permissions.query = ((descriptor: PermissionDescriptor) => descriptor.name === 'geolocation'
      ? Promise.resolve({ state: 'denied' } as PermissionStatus) : query(descriptor)) as typeof query;
  });
  const requests: string[] = [];
  page.on('request', request => { if (request.url().includes('tile.openstreetmap.org')) requests.push(request.url()); });
  await page.goto('/');
  await startEvent(page, 'Strzał');
  await answerNow(page);
  await expect(page.getByRole('button', { name: 'Kierunek', exact: true })).toHaveAttribute('aria-disabled', 'true');
  await expect(page.getByText('Brak zgody na lokalizację.', { exact: true })).toBeVisible();
  await coordinates(page);
  await footer(page).getByRole('button', { name: 'Dalej', exact: true }).click();
  await expect(heading(page, 'Sprawdź i zapisz')).toBeVisible();
  expect(requests).toEqual([]);
});
