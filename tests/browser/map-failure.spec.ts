import { test, expect, type Page } from '@playwright/test';
import { answerHome, answerNow, footer, openMap, reportPost, save, settled, startEvent } from './stages.ts';

test.use({ serviceWorkers: 'block' });
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/58BAwAI/AL+hc2rNAAAAABJRU5ErkJggg==', 'base64');
async function start(page: Page) {
  await page.goto('/');
  await startEvent(page, 'Człowiek z bronią');
  await answerNow(page);
  await openMap(page);
  await stillMap(page);
}
/** A forced click during a view transition or while the retry notice slides in misses the map and proves nothing. */
async function stillMap(page: Page) {
  await settled(page);
  await page.waitForFunction(() => document.getAnimations().every(animation => animation.playState !== 'running'));
}

for (const action of ['pointer', 'Enter', 'Space']) test(`failed first imagery refuses ${action} selection`, async ({ page, context }) => {
  await context.clearPermissions();
  await page.route('https://tile.openstreetmap.org/**', route => route.fulfill({ status: 503 }));
  await start(page);
  await expect(page.getByRole('button', { name: 'Wczytaj mapę ponownie' })).toBeVisible();
  // Nothing was chosen yet, so the notice must not claim a kept point, and it names the search before coordinates.
  await expect(page.getByText('Bez mapy też wskażesz miejsce: wyszukaj znane miejsce albo wpisz współrzędne. Możesz też dokończyć później.', { exact: true })).toBeVisible();
  await expect(page.getByText(/zostaje w szkicu/)).toHaveCount(0);
  const map = page.locator('.map-surface');
  if (action === 'pointer') await map.click({ position: { x: 80, y: 80 }, force: true });
  else { await map.focus(); await page.keyboard.press(action); }
  // The picker writes its fields synchronously on a choice; the Draft summary updates later, so check the fields first.
  await expect(page.getByLabel('Szerokość geograficzna')).toHaveValue('');
  await expect(page.getByText('Miejsce niewskazane', { exact: true })).toBeVisible();
  await expect(page.getByLabel('Jak dokładnie?')).toHaveCount(0);
});

test('new failed tiles after panning cannot replace the chosen point', async ({ page, context }) => {
  await context.clearPermissions();
  let fail = false;
  await page.route('https://tile.openstreetmap.org/**', route => route.fulfill({ status: fail ? 503 : 200, contentType: 'image/png', body: fail ? '' : png }));
  await start(page);
  await expect.poll(() => page.locator('.tile').evaluateAll(images => images.every(image => (image as HTMLImageElement).naturalWidth > 0))).toBe(true);
  const map = page.locator('.map-surface');
  await map.focus();
  await page.keyboard.press('Enter');
  await page.getByText('Wpisz współrzędne', { exact: true }).click();
  const lat = await page.getByLabel('Szerokość geograficzna').inputValue();
  const lon = await page.getByLabel('Długość geograficzna').inputValue();
  fail = true;
  await map.focus();
  for (let i = 0; i < 5; i++) await page.keyboard.press('Shift+ArrowRight');
  await page.keyboard.press('Enter');
  await expect(page.getByLabel('Szerokość geograficzna')).toHaveValue(lat);
  await expect(page.getByLabel('Długość geograficzna')).toHaveValue(lon);
});

test('a failed map keeps the chosen point, can be corrected without imagery, recovers without choosing, and finish-later keeps the Draft', async ({ page, context }) => {
  await context.clearPermissions();
  let recover = false;
  await page.route('https://tile.openstreetmap.org/**', route => route.fulfill(recover
    ? { status: 200, contentType: 'image/png', headers: { 'cache-control': 'no-store' }, body: png } : { status: 503 }));
  await page.route('**/api/places', route => route.fulfill({ json: { places: [{ name: 'Leśniczówka Testowa', lat: 52.25, lon: 21.03 }] } }));
  await page.goto('/');
  await startEvent(page, 'Człowiek z bronią');
  await answerNow(page);
  await page.getByText('Wpisz współrzędne', { exact: true }).click();
  const latitude = page.getByLabel('Szerokość geograficzna');
  const longitude = page.getByLabel('Długość geograficzna');
  await latitude.fill('52.24');
  await longitude.fill('21.03');
  await page.getByRole('button', { name: 'Wskaż wpisany punkt' }).click();
  await openMap(page);
  const status = page.locator('#map-status');
  const failed = 'Nie wczytano całej mapy. Wybór na mapie jest wyłączony.';
  await expect(status).toHaveText(failed);
  await expect(page.getByText('Wskazane miejsce zostaje w szkicu. Bez mapy też je poprawisz: wyszukaj znane miejsce albo wpisz współrzędne. Możesz też dokończyć później.', { exact: true })).toBeVisible();
  const draftPoint = () => page.evaluate(() => new Promise(resolve => {
    const request = indexedDB.open('bor-czuwa');
    request.onsuccess = () => { const db = request.result; const read = db.transaction('drafts').objectStore('drafts').getAll();
      read.onsuccess = () => { resolve(read.result.map(draft => [Number(draft.manualLat), Number(draft.manualLon)])); db.close(); }; };
  }));
  const keeps = async (lat: string, point: number[]) => {
    // The picker writes its fields synchronously on a choice; the Draft follows asynchronously.
    await expect(latitude).toHaveValue(lat);
    await expect(longitude).toHaveValue('21.03000');
    await expect.poll(draftPoint).toEqual([point]);
  };
  // Pointer only: Enter and Space choose the map centre, which here is the saved point, so the
  // first-opening cases above own their refusal.
  await stillMap(page);
  const map = page.locator('.map-surface');
  await map.click({ position: { x: 80, y: 80 }, force: true });
  await keeps('52.24000', [52.24, 21.03]);
  // Search orients the failed map and confirms nothing; the described place is the correction.
  await page.getByLabel('Szukaj miejscowości lub miejsca').fill('Leśniczówka');
  await page.getByRole('button', { name: 'Szukaj', exact: true }).click();
  await page.getByRole('button', { name: 'Leśniczówka Testowa', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Miejsce względem punktu orientacyjnego' })).toBeFocused();
  await keeps('52.24000', [52.24, 21.03]);
  await page.getByLabel('Kierunek od punktu orientacyjnego').selectOption('0');
  await page.getByLabel('Odległość od punktu orientacyjnego w metrach').fill('1000');
  await page.getByRole('button', { name: 'Wskaż opisane miejsce' }).click();
  await keeps('52.25898', [52.25898, 21.03]);
  await expect(status).toHaveText(failed);
  // Coordinates stay available while imagery is failed.
  await latitude.fill('52.26');
  await page.getByRole('button', { name: 'Wskaż wpisany punkt' }).click();
  await keeps('52.26000', [52.26, 21.03]);
  await expect(status).toHaveText(failed);
  recover = true;
  await page.getByRole('button', { name: 'Wczytaj mapę ponownie' }).focus();
  await page.keyboard.press('Enter');
  await expect(status).toHaveText('Mapa wczytana. Możesz wskazać miejsce.');
  await expect(map).toBeFocused();
  await expect(map).toHaveAttribute('aria-disabled', 'false');
  await keeps('52.26000', [52.26, 21.03]);
  // Imagery fails again after panning; leaving from the failed map keeps the Draft.
  recover = false;
  for (let i = 0; i < 5; i++) await page.keyboard.press('Shift+ArrowRight');
  await expect(status).toHaveText(failed);
  await footer(page).getByRole('button', { name: 'Dokończę później', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Co się stało?' })).toBeVisible();
  await expect.poll(draftPoint).toEqual([[52.26, 21.03]]);
});

for (const failure of ['loading', 'partial']) test(`${failure} imagery refuses all map selection until recovery`, async ({ page, context }) => {
  await context.clearPermissions();
  let release!: () => void;
  const waiting = new Promise<void>(resolve => { release = resolve; });
  let requested = 0;
  await page.route('https://tile.openstreetmap.org/**', async route => {
    requested++;
    if (failure === 'loading' || requested === 1) await waiting;
    await route.fulfill({ status: 200, contentType: 'image/png', body: png });
  });
  await start(page);
  await expect.poll(() => requested).toBe(9);
  const map = page.locator('.map-surface');
  // The reveal is still growing the page; a forced click at a stale offset can land on the toggle above the map.
  await map.scrollIntoViewIfNeeded();
  await map.click({ position: { x: 80, y: 80 }, force: true });
  await map.focus();
  await page.keyboard.press('Enter');
  await page.keyboard.press('Space');
  await expect(page.getByLabel('Szerokość geograficzna')).toHaveValue('');
  await expect(page.getByText('Miejsce niewskazane', { exact: true })).toBeVisible();
  release();
  await expect(map).toHaveAttribute('aria-disabled', 'false');
  await expect(page.getByText('Miejsce niewskazane', { exact: true })).toBeVisible();
  await page.keyboard.press('Enter');
  await expect(page.locator('.location-selection[role="status"]')).toContainText('Miejsce wskazane');
  await expect(page.getByLabel('Jak dokładnie?')).toBeVisible();
  await expect(footer(page).getByRole('button', { name: 'Dalej', exact: true })).toHaveAttribute('aria-disabled', 'false');
});

test('known place can be selected, corrected and reviewed without imagery or coordinates', async ({ page, context }) => {
  await context.clearPermissions();
  const tileRequests: string[] = [];
  page.on('request', request => { if (request.url().includes('tile.openstreetmap.org')) tileRequests.push(request.url()); });
  await page.route('**/api/places', route => route.fulfill({ json: { places: [{ name: 'Leśniczówka Testowa', lat: 52.25, lon: 21.03 }] } }));
  await page.goto('/');
  await startEvent(page, 'Człowiek z bronią');
  await answerNow(page);
  await page.getByLabel('Szukaj miejscowości lub miejsca').fill('Leśniczówka');
  await page.getByRole('button', { name: 'Szukaj', exact: true }).press('Enter');
  await page.getByRole('button', { name: 'Leśniczówka Testowa', exact: true }).press('Enter');
  await expect(page.getByRole('heading', { name: 'Miejsce względem punktu orientacyjnego' })).toBeFocused();
  await expect(page.getByText('Miejsce niewskazane', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Wskaż opisane miejsce' })).toBeDisabled();
  await page.getByLabel('Kierunek od punktu orientacyjnego').selectOption('0');
  await page.getByLabel('Odległość od punktu orientacyjnego w metrach').fill('1000');
  await page.getByRole('button', { name: 'Wskaż opisane miejsce' }).press('Enter');
  await expect(page.locator('.location-selection[role="status"]')).toContainText('około 1 km na północ od: Leśniczówka Testowa');
  await page.getByLabel('Jak dokładnie?').press('Home');
  await expect.poll(() => page.evaluate(() => new Promise(resolve => {
    const request = indexedDB.open('bor-czuwa');
    request.onsuccess = () => {
      const db = request.result;
      const read = db.transaction('drafts').objectStore('drafts').getAll();
      read.onsuccess = () => {
        const draft = read.result[0];
        resolve({ reference: draft?.manualReference, lat: draft?.manualLat, lon: draft?.manualLon, radius: draft?.pointRadiusM });
        db.close();
      };
    };
  }))).toEqual({ reference: { name: 'Leśniczówka Testowa', lat: 52.25, lon: 21.03, bearing: 0, distanceM: 1000 },
    lat: '52.25898', lon: '21.03', radius: 0 });
  await page.reload();
  await expect(page.locator('.location-selection[role="status"]')).toContainText('Leśniczówka Testowa');
  await page.getByLabel('Odległość od punktu orientacyjnego w metrach').fill('2000');
  await page.getByRole('button', { name: 'Wskaż opisane miejsce' }).press('Enter');
  await footer(page).getByRole('button', { name: 'Dalej', exact: true }).press('Enter');
  await expect(page.locator('#place-row')).toContainText('około 2 km na północ od: Leśniczówka Testowa');
  await answerHome(page, false);
  expect(tileRequests).toEqual([]);
  await page.getByRole('button', { name: 'Zmień: Gdzie', exact: true }).click();
  await page.getByText('Wpisz współrzędne', { exact: true }).click();
  await expect(page.getByLabel('Szerokość geograficzna')).toHaveValue('52.26797');
  await expect(page.getByLabel('Długość geograficzna')).toHaveValue('21.03000');
  await page.getByLabel('Szerokość geograficzna').fill('52.26');
  await page.getByRole('button', { name: 'Wskaż wpisany punkt' }).click();
  await expect(page.locator('.location-selection[role="status"]')).not.toContainText('Leśniczówka Testowa');
});

for (const atHome of [false, true]) test(`reference correction saves only geometry and preserves home privacy: ${atHome}`, async ({ page, context }) => {
  await context.clearPermissions();
  await page.route('**/api/places', route => route.fulfill({ json: { places: [{ name: 'Leśniczówka Testowa', lat: 52.25, lon: 21.03 }] } }));
  await page.goto('/');
  await startEvent(page, 'Człowiek z bronią');
  await answerNow(page);
  await page.getByLabel('Szukaj miejscowości lub miejsca').fill('Leśniczówka');
  await page.getByRole('button', { name: 'Szukaj', exact: true }).click();
  await page.getByRole('button', { name: 'Leśniczówka Testowa', exact: true }).click();
  await page.getByLabel('Kierunek od punktu orientacyjnego').selectOption('0');
  await page.getByLabel('Odległość od punktu orientacyjnego w metrach').fill('2000');
  await page.getByRole('button', { name: 'Wskaż opisane miejsce' }).click();
  await page.getByLabel('Jak dokładnie?').press('Home');
  await footer(page).getByRole('button', { name: 'Dalej', exact: true }).click();
  await answerHome(page, atHome);
  const posted = await reportPost(page);
  await save(page);
  const payload = (await posted.request).postDataJSON();
  expect(payload.incident_location).toEqual(atHome
    ? { type: 'area', bounds: [21.028571, 52.252252, 21.085714, 52.288288], basis: 'reporter_selected_area', precise_fix_withheld: 'home_privacy' }
    : { lat: 52.26797, lon: 21.03, source: 'moved_by_reporter' });
  expect(payload.device_fix).toBeNull();
  expect(JSON.stringify(payload)).not.toMatch(/Leśniczówka|manualReference|hearing_|referenceBearing/);
  const saved = await page.evaluate(() => new Promise<unknown>(resolve => {
    const request = indexedDB.open('bor-czuwa');
    request.onsuccess = () => { const db = request.result; const read = db.transaction('reports').objectStore('reports').getAll();
      read.onsuccess = () => { resolve(read.result[0].report.incident_location); db.close(); }; };
  }));
  expect(saved).toEqual(payload.incident_location);
});


test('returning to an earlier map area waits for its current images', async ({ page, context }) => {
  await context.clearPermissions();
  let hold = false;
  let heldRequests = 0;
  let release!: () => void;
  const waiting = new Promise<void>(resolve => { release = resolve; });
  await page.route('https://tile.openstreetmap.org/**', async route => {
    if (hold) { heldRequests++; await waiting; }
    await route.fulfill({ status: 200, contentType: 'image/png', headers: { 'cache-control': 'no-store' }, body: png });
  });
  await start(page);
  const map = page.locator('.map-surface');
  await expect(map).toHaveAttribute('aria-disabled', 'false');
  await map.focus();
  for (let i = 0; i < 10; i++) await page.keyboard.press('Shift+ArrowRight');
  await expect(map).toHaveAttribute('aria-disabled', 'false');
  await page.keyboard.press('Enter');
  await page.getByText('Wpisz współrzędne', { exact: true }).click();
  const chosenLongitude = await page.getByLabel('Długość geograficzna').inputValue();
  // Revisiting must request fresh images instead of reusing decoded tiles.
  const cdp = await context.newCDPSession(page);
  await cdp.send('Network.clearBrowserCache');
  await cdp.detach();
  hold = true;
  await map.focus();
  for (let i = 0; i < 10; i++) await page.keyboard.press('Shift+ArrowLeft');
  await expect.poll(() => heldRequests).toBeGreaterThan(0);
  await expect(map).toHaveAttribute('aria-disabled', 'true');
  await page.keyboard.press('Enter');
  await expect(page.getByLabel('Długość geograficzna')).toHaveValue(chosenLongitude);
  release();
  await expect(map).toHaveAttribute('aria-disabled', 'false');
});

test('search before opening imagery orients the map instead of returning to GPS', async ({ page, context }) => {
  await context.setGeolocation({ latitude: 52.2297, longitude: 21.0122, accuracy: 12 });
  const paths: string[] = [];
  await page.route('https://tile.openstreetmap.org/**', route => {
    paths.push(new URL(route.request().url()).pathname);
    return route.fulfill({ status: 200, contentType: 'image/png', body: png });
  });
  await page.route('**/api/places', route => route.fulfill({ json: { places: [{ name: 'Białystok', lat: 53.1325, lon: 23.1688 }] } }));
  await page.goto('/');
  await startEvent(page, 'Człowiek z bronią');
  await expect(page.getByText('Miejsce zapisane w szkicu.')).toBeAttached();
  await answerNow(page);
  await page.getByRole('button', { name: 'Wskaż miejsce', exact: true }).click();
  await page.getByLabel('Szukaj miejscowości lub miejsca').fill('Białystok');
  await page.getByRole('button', { name: 'Szukaj', exact: true }).click();
  await page.getByRole('button', { name: 'Białystok', exact: true }).click();
  expect(paths).toEqual([]);
  await openMap(page);
  await expect(page.locator('.map-surface')).toHaveAttribute('aria-disabled', 'false');
  // Published slippy-map formula, independently evaluated for the search point.
  expect(paths.sort()).toEqual([9245, 9246, 9247].flatMap(x => [5326, 5327, 5328].map(y => `/14/${x}/${y}.png`)).sort());
  await expect(page.getByText('Miejsce niewskazane', { exact: true })).toBeVisible();
});

test('coordinate browser reveal preserves visible chrome, keyboard focus and Draft geometry', async ({ page, context }) => {
  await context.clearPermissions();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.route('https://tile.openstreetmap.org/**', route => route.fulfill({ status: 200, contentType: 'image/png', body: png }));
  await start(page);
  await expect(page.locator('#map-status')).toHaveText('Mapa wczytana. Możesz wskazać miejsce.');
  await page.waitForFunction(() => !document.documentElement.matches(':active-view-transition'));
  await page.evaluate(async () => { await document.fonts.ready; });
  const summary = page.locator('details.advanced summary');
  await summary.focus();
  await page.keyboard.press('Enter');
  await page.keyboard.press('Tab');
  const latitude = page.getByLabel('Szerokość geograficzna', { exact: true });
  const longitude = page.getByLabel('Długość geograficzna', { exact: true });
  await expect(latitude).toBeFocused();
  // Native programmatic reveal must not move fixed chrome; this is not a physical-gesture assertion.
  await latitude.evaluate(input => input.scrollIntoView({ block: 'start', behavior: 'instant' }));
  await expect(latitude).toBeFocused();
  const framing = await latitude.evaluate(input => {
    const pane = document.querySelector('.screen-body')!.getBoundingClientRect();
    const header = document.querySelector('.masthead')!.getBoundingClientRect();
    const field = input.getBoundingClientRect();
    return { headerTop: header.top, headerBottom: header.bottom,
      viewportHeight: innerHeight, documentWidth: document.documentElement.scrollWidth, viewportWidth: innerWidth,
      fieldTop: field.top, fieldBottom: field.bottom, paneTop: pane.top, paneBottom: pane.bottom };
  });
  expect(framing.headerTop).toBeGreaterThanOrEqual(0);
  expect(framing.headerBottom).toBeLessThanOrEqual(framing.viewportHeight);
  expect(framing.fieldTop).toBeGreaterThanOrEqual(framing.paneTop);
  expect(framing.fieldBottom).toBeLessThanOrEqual(framing.paneBottom);
  expect(framing.documentWidth).toBeLessThanOrEqual(framing.viewportWidth);
  await page.keyboard.type('89');
  await page.keyboard.press('Tab');
  await expect(longitude).toBeFocused();
  await page.keyboard.type('21.03');
  const choose = page.getByRole('button', { name: 'Wskaż wpisany punkt', exact: true });
  await expect(choose).toBeDisabled();
  await page.keyboard.press('Shift+Tab');
  await expect(latitude).toBeFocused();
  await page.keyboard.press('ControlOrMeta+A');
  await page.keyboard.type('52.26');
  await page.keyboard.press('Tab');
  await page.keyboard.press('Tab');
  await expect(choose).toBeFocused();
  await page.keyboard.press('Enter');
  expect(Number(await latitude.inputValue())).toBe(52.26);
  expect(Number(await longitude.inputValue())).toBe(21.03);
  await page.getByLabel('Jak dokładnie?').press('Home');
  await footer(page).getByRole('button', { name: 'Dalej', exact: true }).press('Enter');
  await expect(page.getByRole('heading', { name: 'Sprawdź i zapisz', exact: true })).toBeVisible();
  await answerHome(page, false);
  const persistedGeometry = () => page.evaluate(() => new Promise(resolve => {
    const request = indexedDB.open('bor-czuwa');
    request.onsuccess = () => {
      const db = request.result, read = db.transaction('drafts').objectStore('drafts').getAll();
      read.onsuccess = () => {
        const draft = read.result[0];
        resolve({ lat: Number(draft?.manualLat), lon: Number(draft?.manualLon), fromHome: draft?.fromHome,
          radius: draft?.pointRadiusM, reference: draft?.manualReference });
        db.close();
      };
    };
  }));
  const expectedGeometry = { lat: 52.26, lon: 21.03, fromHome: false, radius: 0, reference: undefined };
  // Reload only after the chosen home answer is durably stored, not while its write is still pending.
  await expect.poll(persistedGeometry).toEqual(expectedGeometry);
  await page.reload();
  await expect.poll(persistedGeometry).toEqual(expectedGeometry);
});
