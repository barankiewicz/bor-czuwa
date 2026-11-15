import { test, expect } from '@playwright/test';
import { choosePoint, finishFromWhen } from './stages.ts';
import { readFile } from 'node:fs/promises';

const points = JSON.parse(await readFile(new URL('../../data/fixtures/protected/acceptance.json', import.meta.url), 'utf8'));

async function capturePoint(page: import('@playwright/test').Page) {
  await page.getByRole('button', { name: 'Człowiek z bronią', exact: true }).click();
  await finishFromWhen(page, false);
  await page.getByRole('button', { name: 'Zapisz zgłoszenie' }).click();
}
// The Report screen's protected-area fact, and the one value that asserts a ban (ADR-0007).
const protectedFact = (page: import('@playwright/test').Page) => page.locator('[data-fact="protected"]');
const ban = (page: import('@playwright/test').Page) => protectedFact(page).locator('.fact-value', { hasText: 'Zakaz polowania' });
async function openSources(page: import('@playwright/test').Page) {
  await page.getByRole('button', { name: 'Skąd te wyniki' }).click();
  return page.getByRole('dialog', { name: 'Skąd te wyniki' }).getByRole('region', { name: 'Obszary chronione' });
}


test('park boundary margin and clear interior produce different wording after sync', async ({ page, context }) => {
  await page.addInitScript(() => {
    const watch = navigator.geolocation.watchPosition.bind(navigator.geolocation);
    navigator.geolocation.watchPosition = (success, failure, options) => watch(position => {
      (window as typeof window & { latestSensorPoint?: { lat: number; lon: number } }).latestSensorPoint =
        { lat: position.coords.latitude, lon: position.coords.longitude };
      success(position);
    }, failure, options);
  });
  await context.setGeolocation({ latitude: points.park_margin.point.lat, longitude: points.park_margin.point.lon, accuracy: 15 });
  await page.goto('/');
  await capturePoint(page);
  await expect(protectedFact(page)).toContainText('Testowy Park Narodowy', { timeout: 20_000 });
  await expect(protectedFact(page)).toContainText('Granica mieści się w marginesie dokładności.');
  await expect(ban(page)).toHaveCount(0);
  await context.setGeolocation({ latitude: points.park_inside.point.lat, longitude: points.park_inside.point.lon, accuracy: 15 });
  // Wait for the shared watch to receive the moved device's measurement.
  await page.waitForFunction(point => {
    const latest = (window as typeof window & { latestSensorPoint?: { lat: number; lon: number } }).latestSensorPoint;
    return latest?.lat === point.lat && latest?.lon === point.lon;
  }, points.park_inside.point);
  await page.getByRole('button', { name: 'Bór czuwa', exact: true }).click();
  const submitted = page.waitForRequest(request => request.method() === 'POST' && new URL(request.url()).pathname === '/api/reports');
  await capturePoint(page);
  expect((await submitted).postDataJSON().incident_location).toMatchObject(points.park_inside.point);
  await expect(ban(page)).toBeVisible({ timeout: 20_000 });
});

for (const [point, expected, banned] of [
  ['reserve_neither', 'Według migawki CRFOP rezerwat nie ma planu ochrony ani zadań ochronnych.', true],
  ['reserve_tasks', 'Zadania ochronne w CRFOP', false],
  ['reserve_missing', 'Brak rezerwatu w tej migawce CRFOP. Nie ustalono dokumentów ochronnych.', false],
  ['reserve_plan', 'Plan ochrony w CRFOP', false],
  ['otulina', 'Testowy Park Narodowy', false],
  ['context', 'Testowy obszar siedliskowy', false]
] as const) {
  test(`${point} shows membership and its document or context state`, async ({ page, context }) => {
    await context.setGeolocation({ latitude: points[point].point.lat, longitude: points[point].point.lon, accuracy: 15 });
    await page.goto('/');
    await capturePoint(page);
    await expect(protectedFact(page)).toBeVisible({ timeout: 20_000 });
    await expect(ban(page)).toHaveCount(banned ? 1 : 0);
    if (point === 'otulina') await expect(protectedFact(page).locator('.fact-value')).toHaveText('Otulina');
    if (point === 'context') await expect(protectedFact(page)).toContainText('Drugi obszar ptasi');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    const areas = await openSources(page);
    await expect(areas.getByText(expected, { exact: false }).first()).toBeVisible();
    if (point === 'reserve_tasks') await expect(areas.getByRole('link', { name: 'Zadania ochronne w CRFOP' })).toHaveAttribute('href', /fop=fixture\.4$/);
    if (point === 'reserve_plan') await expect(areas.getByRole('link', { name: 'Zadania ochronne w CRFOP' })).toBeVisible();
  });
}

test('hand-placed park point never asserts a ban, including after offline reload', async ({ page, context }) => {
  await context.setGeolocation({ latitude: points.park_inside.point.lat, longitude: points.park_inside.point.lon, accuracy: 0 });
  await page.goto('/');
  await page.getByRole('button', { name: 'Człowiek z bronią', exact: true }).click();
  await finishFromWhen(page, false);
  // Hand placing is for an Event made earlier; one seen now is placed by its dial.
  await page.getByRole('button', { name: 'Zmień: Kiedy' }).click();
  await page.getByRole('button', { name: 'Kilka godzin temu' }).click();
  await page.locator('.screen-foot').getByRole('button', { name: 'Dalej' }).click();
  await choosePoint(page, points.park_inside.point.lat, points.park_inside.point.lon, true);
  await expect(page.locator('#place-row')).toContainText('miejsce wskazane na mapie');
  await page.locator('#home-check').getByRole('button', { name: 'Nie', exact: true }).click();
  await page.getByRole('button', { name: 'Zapisz zgłoszenie' }).click();
  const manual = 'Bez dokładności GPS nie da się potwierdzić położenia względem granicy.';
  await expect(protectedFact(page)).toContainText(manual, { timeout: 20_000 });
  await expect(ban(page)).toHaveCount(0);
  await page.evaluate(() => navigator.serviceWorker.ready);
  await context.setOffline(true);
  await page.reload();
  await page.getByRole('button', { name: 'Moje zapisy' }).click();
  await page.getByRole('button', { name: /^Człowiek z bronią, / }).click();
  await expect(protectedFact(page)).toContainText(manual);
  await expect(ban(page)).toHaveCount(0);
});

test('distance equal to Accuracy stays in the margin, without rounding the comparison', async ({ page, context }) => {
  await context.setGeolocation({ latitude: points.park_inside.point.lat, longitude: points.park_inside.point.lon, accuracy: 15 });
  await page.route('**/api/reports/*/findings', async route => {
    const response = await route.fetch();
    const result = await response.json();
    if (result.status === 'computed') result.accuracy_m = result.protected_areas.park_narodowy[0].boundary_distance.value_m;
    await route.fulfill({ response, json: result });
  });
  await page.goto('/');
  await capturePoint(page);
  await expect(protectedFact(page)).toContainText('Granica mieści się w marginesie dokładności.', { timeout: 20_000 });
  await expect(ban(page)).toHaveCount(0);
});

test('display uses protected-area treatment from Findings Rule set', async ({ page, context }) => {
  await context.setGeolocation({ latitude: points.park_inside.point.lat, longitude: points.park_inside.point.lon, accuracy: 15 });
  await page.route('**/api/reports/*/findings', async route => {
    const response = await route.fetch();
    const result = await response.json();
    if (result.status === 'computed') result.protected_areas.rules.treatment.park_narodowy = 'context';
    await route.fulfill({ response, json: result });
  });
  await page.goto('/');
  await capturePoint(page);
  await expect(protectedFact(page)).toContainText('Testowy Park Narodowy', { timeout: 20_000 });
  await expect(ban(page)).toHaveCount(0);
});

for (const kind of ['park_krajobrazowy', 'natura_2000_oso', 'natura_2000_soo', 'otulina'] as const) {
  test(`${kind} remains context when the Rule set incorrectly says ban`, async ({ page, context }) => {
    await context.setGeolocation({ latitude: points.park_inside.point.lat, longitude: points.park_inside.point.lon, accuracy: 15 });
    await page.route('**/api/reports', route => route.fulfill({ status: 201, json: { id: 'accepted' } }));
    const fixture = JSON.parse(await readFile(new URL('./computed-findings.json', import.meta.url), 'utf8'));
    const protectedAreas = fixture.protected_areas;
    for (const key of ['park_narodowy', 'rezerwat', 'otulina', 'park_krajobrazowy', 'natura_2000_oso', 'natura_2000_soo']) protectedAreas[key] = [];
    protectedAreas[kind] = [{ name: 'Obszar kontekstowy', inspire_id: 'context', boundary_distance: { status: 'measured', value_m: 30, search_radius_m: null } }];
    protectedAreas.rules.treatment[kind] = 'ban';
    fixture.accuracy_m = 15;
    await page.route('**/api/reports/*/findings', route => route.fulfill({ status: 200, json: fixture }));
    await page.goto('/');
    await capturePoint(page);
    await expect(protectedFact(page)).toContainText('Obszar kontekstowy');
    await expect(protectedFact(page)).toContainText('Ta forma ochrony nie zakazuje polowania.');
    await expect(ban(page)).toHaveCount(0);
    await expect(await openSources(page)).toContainText('Ta forma ochrony sama nie ustanawia zakazu polowania.');
  });
}
