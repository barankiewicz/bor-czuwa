import { test, expect, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { openMap, answerHome, answerNow, blankTiles, heading, leaveCompass, save, setEstimate, startEvent } from './stages.ts';

const points = JSON.parse(await readFile(new URL('../../data/fixtures/acceptance.json', import.meta.url), 'utf8'));

async function postedReport(page: Page) {
  const posted = page.waitForRequest(request => request.method() === 'POST' && request.url().endsWith('/api/reports'));
  await save(page);
  return (await posted).postDataJSON();
}
/** Sets the shot's direction in 45-degree turns from north and its distance in stops from the old slider's 750 m rest. */
async function estimate(page: Page, turns: number | undefined, stops: number | undefined) {
  await setEstimate(page, turns === undefined ? undefined : turns * 45,
    stops === undefined ? undefined : [100, 200, 300, 500, 750, 1000, 1500, 2000, 3000][4 + stops]);
}

test.beforeEach(async ({ page }) => { await blankTiles(page); });

test('a heard estimate from home sends a grid cell, never the direction, distance or fix', async ({ page, context }) => {
  const home = points.barn.point;
  await context.setGeolocation({ latitude: home.lat, longitude: home.lon, accuracy: 12 });
  await page.goto('/');
  await startEvent(page, 'Strzał');
  await answerNow(page);
  await estimate(page, 2, 1);
  await leaveCompass(page);
  await answerHome(page, true);
  await expect(page.locator('#place-row')).toContainText('około 1 km na wschód od domu');
  const payload = await postedReport(page);
  expect(payload.device_fix).toBeNull();
  expect(payload.incident_location).toMatchObject({ type: 'area', basis: 'estimated_from_hearing', precise_fix_withheld: 'home_privacy' });
  for (const field of ['hearing_bearing_deg', 'hearing_distance_m', 'hearing_distance_band']) expect(payload.incident_location[field]).toBeUndefined();
  expect(JSON.stringify(payload)).not.toContain(String(home.lat));
  await expect(page.getByText('Zapisano na serwerze.', { exact: true })).toBeVisible();
  await page.getByText('Szczegóły zgłoszenia', { exact: true }).click();
  await expect(page.getByText('Podstawa: oszacowanie ze słuchu.', { exact: false })).toBeVisible();
  await page.getByText('Opis miejsca do powiadomienia').click();
  await expect(page.getByText('Obszar oszacowano ze słuchu. Nie jest to pomiar GPS miejsca oddania strzału.', { exact: false })).toBeVisible();
  // Whole-area closest distance or threshold share; never a point margin or an unmeasured placeholder.
  const dwelling = page.locator('[data-fact="dwelling"]');
  await expect(dwelling).toBeVisible({ timeout: 20_000 });
  await expect(dwelling.locator('.fact-value b')).toHaveText(/^(\d+ m|[\d,]+ km|ok\. \d+%|poniżej 1%|ponad 99%|100%|ponad 1 km)$/);
  await expect(dwelling.locator('.fact-value small')).toHaveCount(0);
  await expect(page.locator('section.findings')).not.toContainText('Nie ustalono odległości');
});

test('away from home the server keeps the estimate in metres and the Notice states it', async ({ page, context }) => {
  const hearing = points.barn.point;
  await context.setGeolocation({ latitude: hearing.lat, longitude: hearing.lon, accuracy: 8 });
  await page.goto('/');
  await startEvent(page, 'Strzał');
  await answerNow(page);
  await estimate(page, 7, 4);
  await leaveCompass(page);
  await answerHome(page, false);
  const payload = await postedReport(page);
  expect(payload.incident_location).toMatchObject({ basis: 'estimated_from_hearing', precise_fix_withheld: null,
    hearing_bearing_deg: 315, hearing_distance_m: 3000 });
  await expect(page.getByText('Zapisano na serwerze.', { exact: true })).toBeVisible();
  await page.getByText('Szczegóły zgłoszenia', { exact: true }).click();
  await expect(page.getByText('Miejsce słyszenia pozostaje na urządzeniu.', { exact: false })).toHaveCount(0);
  await page.getByText('Opis miejsca do powiadomienia').click();
  await expect(page.locator('.facts + details').getByText('Obszar oszacowano ze słuchu (kierunek ok. 315° (północny zachód), odległość ok. 3 km).', { exact: false })).toBeVisible();
});

test('a skipped estimate survives finishing later and sends the kilometre around the fix', async ({ page, context }) => {
  const hearing = points.barn.point;
  await context.setGeolocation({ latitude: hearing.lat, longitude: hearing.lon, accuracy: 8 });
  await page.goto('/');
  await startEvent(page, 'Strzał');
  await answerNow(page);
  await page.getByRole('button', { name: 'Dokończę później' }).click();
  await page.reload();
  await page.getByRole('button', { name: /^Dokończ zgłoszenie/ }).click();
  await expect(heading(page, 'Sprawdź i zapisz')).toBeVisible();
  await expect(page.locator('#place-row')).toContainText('w okolicy, w której jesteś');
  await answerHome(page, false);
  const payload = await postedReport(page);
  expect(payload.device_fix).toBeNull();
  expect(payload.incident_location).toMatchObject({ type: 'area', basis: 'reporter_selected_area', precise_fix_withheld: null });
  expect(payload.incident_location.hearing_bearing_deg).toBeUndefined();
  await expect(page.getByText('Zapisano na serwerze.', { exact: true })).toBeVisible();
  await page.getByText('Szczegóły zgłoszenia', { exact: true }).click();
  await page.getByText('Opis miejsca do powiadomienia').click();
  await expect(page.locator('.facts + details').getByText('Obszar wskazano bez oszacowania kierunku i odległości.', { exact: false })).toBeVisible();
});

test('the map on Sprawdź draws the bounds that are sent, at a cell edge too', async ({ page, context }) => {
  const cellEdge = { lat: 1483 * 4 / 111, lon: 399 * 4 / 70 };
  const cases = [
    { name: 'home estimate', at: points.barn.point, home: true, turns: 2, stops: -1 },
    { name: 'cell edge', at: cellEdge, home: true, turns: undefined, stops: undefined },
    { name: 'far estimate', at: points.barn.point, home: false, turns: 0, stops: 4 }
  ];
  await page.route('**/api/reports', route => route.request().method() === 'POST' ? route.abort() : route.fallback());
  for (const item of cases) {
    await context.setGeolocation({ latitude: item.at.lat, longitude: item.at.lon, accuracy: 9 });
    await page.goto('/');
    // Each case starts without the home the previous one saved, so the home question is asked.
    await page.evaluate(() => new Promise(resolve => { const request = indexedDB.deleteDatabase('bor-czuwa'); request.onsuccess = request.onblocked = resolve; }));
    await page.reload();
    await startEvent(page, 'Strzał');
    await answerNow(page);
    await estimate(page, item.turns, item.stops);
    await leaveCompass(page);
    await answerHome(page, item.home);
    await openMap(page);
    const drawn = (await page.locator('.kept-map [data-bounds]').getAttribute('data-bounds'))!.split(',').map(Number);
    const payload = await postedReport(page);
    expect(payload.incident_location.bounds, item.name).toEqual(drawn);
    expect(payload.device_fix, item.name).toBeNull();
    // A fix on a cell corner is also a bound; elsewhere the fix itself must not appear.
    if (item.name !== 'cell edge') expect(JSON.stringify(payload), item.name).not.toContain(String(item.at.lat).slice(0, 8));
    expect(JSON.stringify(payload), item.name).not.toContain('accuracy');
  }
});

test('changing the direction from Sprawdź redraws the area, and saving sends the new one', async ({ page, context }) => {
  const hearing = points.barn.point;
  await context.setGeolocation({ latitude: hearing.lat, longitude: hearing.lon, accuracy: 8 });
  await page.route('**/api/reports', route => route.request().method() === 'POST' ? route.abort() : route.fallback());
  await page.goto('/');
  await startEvent(page, 'Strzał');
  await answerNow(page);
  await estimate(page, 2, 0);
  await leaveCompass(page);
  await answerHome(page, false);
  await openMap(page);
  const before = await page.locator('.kept-map [data-bounds]').getAttribute('data-bounds');
  await page.getByRole('button', { name: 'Zmień: Gdzie' }).click();
  await expect(page.getByText('Wybrane: na wschód, około 750 m')).toBeVisible();
  await estimate(page, 6, undefined);
  await page.getByRole('button', { name: 'Dalej' }).click();
  await expect(heading(page, 'Sprawdź i zapisz')).toBeVisible();
  // The direction moved the estimate, not the place the Reporter stood, so the home answer holds.
  await expect(page.locator('#home-check')).toHaveCount(0);
  const after = await page.locator('.kept-map [data-bounds]').getAttribute('data-bounds');
  expect(after).not.toBe(before);
  const payload = await postedReport(page);
  expect(payload.incident_location.hearing_bearing_deg).toBe(270);
  expect(payload.incident_location.bounds.join(',')).toBe(after);
});

test('without tiles the Sprawdź map says so, and nothing about the place leaves before saving', async ({ page, context }) => {
  const home = points.barn.point;
  await context.setGeolocation({ latitude: home.lat, longitude: home.lon, accuracy: 12 });
  const outgoing: string[] = [];
  page.on('request', request => {
    if (request.url().includes('/api/') && !request.url().includes('/api/challenge')) outgoing.push(request.url());
  });
  await page.unroute('https://tile.openstreetmap.org/**');
  await page.route('https://tile.openstreetmap.org/**', route => route.fulfill({ status: 503 }));
  await page.route('**/api/reports', route => route.request().method() === 'POST' ? route.abort() : route.fallback());
  await page.goto('/');
  await startEvent(page, 'Strzał');
  await answerNow(page);
  await estimate(page, 4, undefined);
  await leaveCompass(page);
  await answerHome(page, true);
  await openMap(page);
  await expect(page.getByText('Mapa jest niedostępna. Miejsce opisano powyżej.')).toBeVisible();
  await expect(page.locator('.kept-map [data-bounds]')).toBeVisible();
  expect(outgoing.filter(url => !url.endsWith('/api/reports'))).toEqual([]);
  const payload = await postedReport(page);
  expect(payload.incident_location.precise_fix_withheld).toBe('home_privacy');
});
