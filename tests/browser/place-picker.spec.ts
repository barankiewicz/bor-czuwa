import { test, expect, type Page } from '@playwright/test';
import { answerHome, answerNow, blankTiles, openMap, pastCompass, press, footer, heading, startEvent } from './stages.ts';

/** No GPS: an Event happening now goes straight from Kiedy to the map. */
async function toMap(page: Page) {
  await page.goto('/');
  await startEvent(page, 'Człowiek z bronią');
  await page.getByRole('button', { name: /^Teraz/ }).click();
  await expect(heading(page, 'Gdzie to było?')).toBeVisible();
  await expect(page.getByText('Brak pozycji GPS.', { exact: true })).toBeVisible();
}

test('a search result only moves the map; the point is the Reporter’s own choice', async ({ page, context }) => {
  await context.grantPermissions([]);
  const requests: string[] = [];
  page.on('request', request => {
    if (request.url().includes('tile.openstreetmap.org') || request.url().includes('/api/places')) requests.push(request.url());
  });
  await blankTiles(page);
  await page.route('**/api/places', route => {
    expect(route.request().postDataJSON()).toEqual({ query: 'Białystok' });
    return route.fulfill({ status: 200, contentType: 'application/json',
      body: JSON.stringify({ places: [{ name: 'Białystok, Polska', lat: 53.1325, lon: 23.1688 }] }) });
  });
  await page.goto('/');
  await startEvent(page, 'Człowiek z bronią');
  // Nothing reaches the map supplier before the map step.
  expect(requests).toEqual([]);
  await page.getByRole('button', { name: /^Teraz/ }).click();
  await openMap(page);
  await expect(page.locator('.map-surface')).toHaveAttribute('aria-disabled', 'false');
  await page.getByLabel('Szukaj miejscowości lub miejsca').fill('Białystok');
  await page.getByRole('button', { name: 'Szukaj', exact: true }).click();
  await page.getByRole('button', { name: 'Białystok, Polska' }).click();
  await expect(page.getByLabel('Jak dokładnie?')).toHaveCount(0);
  await expect(page.locator('#where-next')).toContainText('Wskaż miejsce, aby przejść dalej.');
  await expect(page.locator('.map-surface')).toHaveAttribute('aria-disabled', 'false');
  await page.locator('.map-surface').click({ position: { x: 60, y: 60 } });
  await expect(page.getByLabel('Jak dokładnie?')).toBeVisible();

  await footer(page).getByRole('button', { name: 'Dalej' }).click();
  await expect(page.locator('#place-row')).toContainText('w promieniu około 500 m od wskazanego miejsca');
  expect(requests.filter(url => url.includes('/api/places'))).toHaveLength(1);
  expect(requests.some(url => url.includes('53.1325') || url.includes('23.1688'))).toBe(false);
});

test('keyboard selection and tile recovery keep the current Draft', async ({ page, context }) => {
  await context.grantPermissions([]);
  let recover = false;
  await page.route('https://tile.openstreetmap.org/**', route => route.fulfill({ status: recover ? 200 : 503,
    contentType: 'image/png', body: recover ? Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/lXcAAAAASUVORK5CYII=', 'base64') : '' }));
  await toMap(page);
  await openMap(page);
  await expect(page.getByRole('button', { name: 'Wczytaj mapę ponownie' })).toBeVisible();
  recover = true;
  await page.getByRole('button', { name: 'Wczytaj mapę ponownie' }).click();
  await expect(page.getByRole('button', { name: 'Wczytaj mapę ponownie' })).toHaveCount(0);
  const map = page.getByRole('button', { name: 'Mapa: dotknij miejsca zdarzenia' });
  await map.focus();
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('Enter');
  await expect(page.getByLabel('Jak dokładnie?')).toBeVisible();
  await expect.poll(() => page.evaluate(async () => {
    const request = indexedDB.open('bor-czuwa');
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const query = db.transaction('drafts').objectStore('drafts').getAll();
    const drafts = await new Promise<{ manualLat?: string; manualLon?: string }[]>((resolve, reject) => {
      query.onsuccess = () => resolve(query.result);
      query.onerror = () => reject(query.error);
    });
    db.close();
    return drafts.length === 1 && !!drafts[0].manualLat && !!drafts[0].manualLon;
  })).toBe(true);
  await page.reload();
  await expect(heading(page, 'Gdzie to było?')).toBeVisible();
  await expect(page.getByLabel('Jak dokładnie?')).toBeVisible();
});

test('an edited search ignores a delayed result, and an out-of-range latitude stays off the map', async ({ page, context }) => {
  await context.grantPermissions([]);
  let release: (() => void) | undefined;
  await page.route('**/api/places', async route => {
    await new Promise<void>(resolve => { release = resolve; });
    try {
      await route.fulfill({ status: 200, contentType: 'application/json',
        body: JSON.stringify({ places: [{ name: 'Stary wynik', lat: 53, lon: 23 }] }) });
    } catch { /* edited query aborted request */ }
  });
  await toMap(page);
  await openMap(page);
  const query = page.getByLabel('Szukaj miejscowości lub miejsca');
  await query.fill('Białystok');
  await page.getByRole('button', { name: 'Szukaj', exact: true }).click();
  await expect(page.getByText('Szukam miejsca…')).toBeVisible();
  await query.fill('Warszawa');
  release?.();
  await expect(page.getByRole('button', { name: 'Stary wynik' })).toHaveCount(0);
  await page.getByText('Wpisz współrzędne', { exact: true }).click();
  await page.getByLabel('Szerokość geograficzna').fill('89');
  await page.getByLabel('Długość geograficzna').fill('20');
  await expect(page.getByRole('button', { name: 'Wskaż wpisany punkt' })).toBeDisabled();
});

test('saved home never seeds tiles, and opening the picker is remembered on the preview', async ({ page, context }) => {
  await context.clearPermissions();
  const tiles: { url: string; referer?: string }[] = [];
  await page.route('https://tile.openstreetmap.org/**', async route => {
    tiles.push({ url: route.request().url(), referer: (await route.request().allHeaders()).referer });
    await route.fulfill({ status: 503 });
  });
  await page.goto('/');
  await expect(page.getByRole('button', { name: 'Człowiek z bronią', exact: true })).toBeVisible();
  await page.evaluate(() => new Promise<void>((resolve, reject) => {
    const request = indexedDB.open('bor-czuwa');
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const db = request.result;
      const tx = db.transaction('home', 'readwrite');
      tx.objectStore('home').put({ id: 'mine', fix: { lat: 54.35, lon: 18.65, accuracy_m: 12, captured_at: new Date().toISOString() } });
      tx.oncomplete = () => { db.close(); resolve(); };
      tx.onerror = () => reject(tx.error);
    };
  }));
  await page.reload();
  await startEvent(page, 'Człowiek z bronią');
  await page.getByRole('button', { name: /^Teraz/ }).click();
  await expect(page.getByRole('button', { name: 'Pokaż mapę' })).toBeVisible();
  await press(page, 'Dalej');
  await expect(page.getByRole('button', { name: 'Pokaż mapę' })).toBeFocused();
  expect(tiles).toEqual([]);
  await page.keyboard.press('Enter');
  await expect(page.locator('.map-surface')).toBeVisible();
  await expect.poll(() => tiles.length).toBe(9);
  // Poland at zoom 6, not the saved Gdańsk home at zoom 14.
  expect(tiles.map(tile => new URL(tile.url).pathname).sort()).toEqual(
    [34, 35, 36].flatMap(x => [20, 21, 22].map(y => `/6/${x}/${y}.png`)).sort());
  expect(tiles.every(tile => tile.referer === `${new URL(page.url()).origin}/`)).toBe(true);
  await page.getByText('Wpisz współrzędne', { exact: true }).click();
  await page.getByLabel('Szerokość geograficzna').fill('52.25');
  await page.getByLabel('Długość geograficzna').fill('21.03');
  await page.getByRole('button', { name: 'Wskaż wpisany punkt' }).click();
  await footer(page).getByRole('button', { name: 'Dalej' }).click();
  await expect(page.locator('.kept-map')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Ukryj mapę' })).toBeVisible();
  await page.reload();
  await expect(page.getByRole('button', { name: 'Pokaż mapę' })).toBeVisible();
  const afterReload = tiles.length;
  await expect(page.locator('.kept-map')).toHaveCount(0);
  expect(tiles).toHaveLength(afterReload);
});

test('kept-area preview makes no tile requests before its own tap', async ({ page, context }) => {
  await context.setGeolocation({ latitude: 52.2297, longitude: 21.0122, accuracy: 12 });
  const tiles: string[] = [];
  await page.route('https://tile.openstreetmap.org/**', route => {
    tiles.push(route.request().url());
    return route.fulfill({ status: 503 });
  });
  await page.goto('/');
  await startEvent(page, 'Strzał');
  await page.getByRole('button', { name: /^Teraz/ }).click();
  await footer(page).getByRole('button', { name: 'Pomiń' }).click();
  await page.locator('#home-check').getByRole('button', { name: 'Nie', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Pokaż mapę' })).toBeVisible();
  expect(tiles).toEqual([]);
  await openMap(page);
  await expect(page.locator('.kept-map')).toBeVisible();
  await expect.poll(() => tiles.length).toBeGreaterThan(0);
});

/** Alicja's decision at ticket 30 sign-off: the map button carries no line about what OpenStreetMap sees. */
async function expectNoMapSupplierLine(page: Page) {
  await expect(page.getByText(/OpenStreetMap (dostarcza|widzi)|Po otwarciu .*adres IP|adres IP i/)).toHaveCount(0);
  await expect(page.getByRole('button', { name: /^(Pokaż|Ukryj) mapę$/ })).not.toHaveAttribute('aria-describedby');
}

test('the picker opens around the phone with no line about the map supplier, and asks for nothing before the tap', async ({ page, context }) => {
  await context.setGeolocation({ latitude: 52.2297, longitude: 21.0122, accuracy: 12 });
  const paths: string[] = [];
  page.on('request', request => {
    if (request.url().startsWith('https://tile.openstreetmap.org/')) paths.push(new URL(request.url()).pathname);
  });
  await blankTiles(page);
  await page.goto('/');
  await startEvent(page, 'Człowiek z bronią');
  await expect(page.getByText('Miejsce zapisane w szkicu.')).toBeAttached();
  await answerNow(page);
  await page.getByRole('button', { name: 'Wskaż miejsce', exact: true }).click();
  const show = page.getByRole('button', { name: 'Pokaż mapę', exact: true });
  await expect(show).toBeVisible();
  await expectNoMapSupplierLine(page);
  expect(paths).toEqual([]);
  await show.click();
  await expect.poll(() => paths.length).toBe(9);
  await expect(page.locator('.map-surface')).toHaveAttribute('aria-disabled', 'false');
  // Published slippy-map formula for the recorded fix: the middle of the nine tiles holds it.
  const sin = Math.sin(52.2297 * Math.PI / 180);
  const middleX = Math.floor((21.0122 + 180) / 360 * 2 ** 14);
  const middleY = Math.floor((0.5 - Math.log((1 + sin) / (1 - sin)) / (4 * Math.PI)) * 2 ** 14);
  expect([...new Set(paths)].sort()).toEqual([-1, 0, 1].flatMap(dx => [-1, 0, 1].map(dy => `/14/${middleX + dx}/${middleY + dy}.png`)).sort());
  await expectNoMapSupplierLine(page);
});

test('the kept-area preview on Sprawdź has no line about the map supplier either', async ({ page, context }) => {
  await context.setGeolocation({ latitude: 52.2297, longitude: 21.0122, accuracy: 12 });
  await blankTiles(page);
  await page.goto('/');
  await startEvent(page, 'Człowiek z bronią');
  await answerNow(page);
  await pastCompass(page);
  await answerHome(page, true);
  await expect(page.locator('.kept-place')).toBeVisible();
  await expectNoMapSupplierLine(page);
});

test('a hidden and reopened map goes back to the phone after a search result was opened first', async ({ page, context }) => {
  await context.setGeolocation({ latitude: 52.2297, longitude: 21.0122, accuracy: 12 });
  const paths: string[] = [];
  page.on('request', request => {
    if (request.url().startsWith('https://tile.openstreetmap.org/')) paths.push(new URL(request.url()).pathname);
  });
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/58BAwAI/AL+hc2rNAAAAABJRU5ErkJggg==', 'base64');
  // Not cached, so a reopened map asks again and the requests show where it is centred.
  await page.route('https://tile.openstreetmap.org/**', route => route.fulfill({ status: 200, contentType: 'image/png', body: png,
    headers: { 'Cache-Control': 'no-store' } }));
  await page.route('**/api/places', route => route.fulfill({ json: { places: [{ name: 'Białystok, Polska', lat: 53.1325, lon: 23.1688 }] } }));
  await page.goto('/');
  await startEvent(page, 'Człowiek z bronią');
  await expect(page.getByText('Miejsce zapisane w szkicu.')).toBeAttached();
  await answerNow(page);
  await page.getByRole('button', { name: 'Wskaż miejsce', exact: true }).click();
  await page.getByLabel('Szukaj miejscowości lub miejsca').fill('Białystok');
  await page.getByRole('button', { name: 'Szukaj', exact: true }).click();
  await page.getByRole('button', { name: 'Białystok, Polska', exact: true }).click();
  expect(paths).toEqual([]);
  // The first opening is centred on the search result, not on the phone.
  await page.getByRole('button', { name: 'Pokaż mapę', exact: true }).click();
  await expect.poll(() => paths.length).toBe(9);
  expect(paths.every(path => path.startsWith('/14/9245/') || path.startsWith('/14/9246/') || path.startsWith('/14/9247/'))).toBe(true);
  await page.getByRole('button', { name: 'Ukryj mapę', exact: true }).click();
  paths.length = 0;
  await page.getByRole('button', { name: 'Pokaż mapę', exact: true }).click();
  await expect.poll(() => paths.length).toBe(9);
  const sin = Math.sin(52.2297 * Math.PI / 180);
  const middleX = Math.floor((21.0122 + 180) / 360 * 2 ** 14);
  const middleY = Math.floor((0.5 - Math.log((1 + sin) / (1 - sin)) / (4 * Math.PI)) * 2 ** 14);
  expect([...new Set(paths)].sort()).toEqual([-1, 0, 1].flatMap(dx => [-1, 0, 1].map(dy => `/14/${middleX + dx}/${middleY + dy}.png`)).sort());
});
