import { test, expect, type Browser, type Page } from '@playwright/test';
import { answerHome, answerNow, footer, heading, leaveCompass, setEstimate, startEvent } from './stages.ts';

const web = process.env.TEST_WEB_URL ?? 'http://127.0.0.1:3000';
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/58BAwAI/AL+hc2rNAAAAABJRU5ErkJggg==', 'base64');

/** A fresh browser context, so the two runs share neither Drafts nor a saved home. */
async function phoneAt(browser: Browser, latitude: number, longitude: number) {
  const context = await browser.newContext({ locale: 'pl-PL', viewport: { width: 390, height: 844 }, serviceWorkers: 'block',
    permissions: ['geolocation'], geolocation: { latitude, longitude, accuracy: 12 }, baseURL: web,
    storageState: { cookies: [], origins: [{ origin: web, localStorage: [{ name: 'first-launch-seen', value: '1' }] }] } });
  const page = await context.newPage();
  await page.route('https://tile.openstreetmap.org/**', route => route.fulfill({ status: 200, contentType: 'image/png', body: png }));
  return { context, page };
}

/** Opens the map on Sprawdź if the picker has not already, and reads the tiles its images point at and the area it drew. */
async function keptMap(page: Page) {
  const show = page.getByRole('button', { name: 'Pokaż mapę', exact: true });
  await expect(show.or(page.getByRole('button', { name: 'Ukryj mapę', exact: true }))).toBeVisible();
  if (await show.count()) await show.click();
  const area = page.locator('.kept-map [data-bounds]');
  await expect(area).toBeVisible();
  const images = page.locator('.kept-map img.tile');
  await expect(images).toHaveCount(9);
  await expect.poll(() => images.evaluateAll(list => list.every(image => (image as HTMLImageElement).complete))).toBe(true);
  const tiles = await images.evaluateAll(list => list.map(image => new URL((image as HTMLImageElement).src).pathname).sort());
  return { tiles, bounds: (await area.getAttribute('data-bounds'))! };
}

/** The Reporter's own mark is drawn: the Report comes from the phone's fix, optionally with a heard estimate. */
async function withMark(browser: Browser, fix: { lat: number; lon: number }, heard: boolean) {
  const { context, page } = await phoneAt(browser, fix.lat, fix.lon);
  await page.goto('/');
  await startEvent(page, 'Strzał');
  await answerNow(page);
  if (heard) {
    // Due east, 2 km.
    await setEstimate(page, 90, 2000);
  }
  await leaveCompass(page);
  await answerHome(page, true);
  await expect(page.locator('.kept-place')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Pokaż mapę', exact: true })).toBeVisible();
  const result = await keptMap(page);
  await expect(page.locator('.kept-map .mark')).toHaveCount(1);
  await context.close();
  return result;
}

/** No mark: the Reporter typed the place themselves, so the same 4 km cell is kept without a phone fix to draw. */
async function withoutMark(browser: Browser, fix: { lat: number; lon: number }, place: { lat: number; lon: number }) {
  const { context, page } = await phoneAt(browser, fix.lat, fix.lon);
  await page.goto('/');
  await startEvent(page, 'Strzał');
  await answerNow(page);
  await page.getByRole('button', { name: 'Wskaż miejsce', exact: true }).click();
  await page.getByRole('button', { name: 'Pokaż mapę', exact: true }).click();
  await page.getByText('Wpisz współrzędne', { exact: true }).click();
  await page.getByLabel('Szerokość geograficzna').fill(String(place.lat));
  await page.getByLabel('Długość geograficzna').fill(String(place.lon));
  await page.getByRole('button', { name: 'Wskaż wpisany punkt' }).click();
  await footer(page).getByRole('button', { name: 'Dalej' }).click();
  await expect(heading(page, 'Sprawdź i zapisz')).toBeVisible();
  await answerHome(page, true);
  await expect(page.locator('.kept-place')).toBeVisible();
  const result = await keptMap(page);
  await expect(page.locator('.kept-map .mark')).toHaveCount(0);
  await context.close();
  return result;
}

// The 4 km cell west 19.314286, centre 19.34286 at 52.2297 N. Its centre lies 0.007 degrees east of a zoom 11 tile
// edge, so a view stretched west to a phone outside the cell would centre on the next tile over.
const lat = 52.2297;
const inside = { lat, lon: 19.34286 };
// Heard 2 km due east, the estimate falls 0.003 degrees inside the cell while the phone stands 1.9 km west of its edge.
const beyond = { lat, lon: 19.28795 };
const estimate = { lat, lon: 19.31729 };

test('the kept-area map asks for the same tiles with and without the Reporter’s mark, for a phone inside the 4 km cell', async ({ browser }) => {
  const marked = await withMark(browser, inside, false);
  const unmarked = await withoutMark(browser, inside, inside);
  expect(marked.bounds).toBe(unmarked.bounds);
  expect(marked.tiles).toEqual(unmarked.tiles);
});

test('the kept-area map asks for the same tiles with and without the Reporter’s mark, for a phone beyond the 4 km cell’s edge', async ({ browser }) => {
  const marked = await withMark(browser, beyond, true);
  const unmarked = await withoutMark(browser, beyond, estimate);
  expect(marked.bounds).toBe(unmarked.bounds);
  const [west, south, east, north] = marked.bounds.split(',').map(Number);
  expect(beyond.lon < west || beyond.lon > east || beyond.lat < south || beyond.lat > north).toBe(true);
  expect(marked.tiles).toEqual(unmarked.tiles);
});
