import { expect, test, type Page } from '@playwright/test';
import { finishFromWhen } from './stages.ts';
import { readFile } from 'node:fs/promises';

const points = JSON.parse(await readFile(new URL('../../data/fixtures/acceptance.json', import.meta.url), 'utf8'));

// The Findings are open on the Report screen; rules and sources live in the "Skąd te wyniki" sheet.
const findingsBlock = (page: Page) => page.locator('section.findings');
const sources = (page: Page) => page.getByRole('dialog');

for (const [state, night, expected] of [
  ['night', true, 'Noc'],
  ['day', false, 'Poza nocą'],
  ['boundary', null, 'noc (obszar obejmuje i noc, i dzień)']
] as const) test(`whole-area ${state} Findings show certainty without point solar times`, async ({ page, context }) => {
  await context.setGeolocation({ latitude: points.edge.point.lat, longitude: points.edge.point.lon, accuracy: 12 });
  const fixture = JSON.parse(await readFile(new URL('./computed-findings.json', import.meta.url), 'utf8'));
  fixture.noc = night === null ? { status: 'not_computed', reason: 'incident_area' } : {
    status: 'computed', spatial_basis: 'incident_area', at_night: night, species_huntable_at_night: null, citation: 'Dz.U. 2022 poz. 2323',
    sunrise_range: { earliest: '2026-03-14T05:39:00+01:00', latest: '2026-03-14T06:00:00+01:00' },
    sunset_range: { earliest: '2026-03-14T17:20:00+01:00', latest: '2026-03-14T17:41:00+01:00' }
  };
  fixture.area_bounds = [22.635, 53.42, 22.66, 53.435];
  fixture.dwelling_distance = { status: 'not_computed', value_m: null, search_radius_m: null, reason: 'incident_area' };
  await page.route('**/api/reports', route => route.fulfill({ status: 201, json: { id: 'accepted' } }));
  await page.route('**/api/reports/*/findings', route => route.fulfill({ json: fixture }));
  await page.route('https://tile.openstreetmap.org/**', route => route.abort());
  await page.goto('/');
  await page.getByRole('button', { name: 'Strzał', exact: true }).click();
  await finishFromWhen(page, false);
  const uploaded = page.waitForRequest(request => request.method() === 'POST' && request.url().endsWith('/api/reports'));
  await page.getByRole('button', { name: 'Zapisz zgłoszenie' }).click();
  expect((await uploaded).postDataJSON().incident_location.type).toBe('area');
  const measurements = findingsBlock(page);
  if (night === null) await expect(measurements.locator('.unchecked')).toContainText(expected);
  else {
    await expect(measurements.locator('[data-fact="noc"] .fact-value')).toHaveText(expected);
    await expect(measurements.locator('[data-fact="noc"]')).toContainText('W całym wskazanym obszarze.');
  }
  await expect(measurements).not.toContainText(/Wschód słońca \d\d:\d\d|zachód \d\d:\d\d/);
});

test('historical citation and uncertain distance stay readable from keyboard in both languages', async ({ page, context }) => {
  await context.setGeolocation({ latitude: points.edge.point.lat, longitude: points.edge.point.lon, accuracy: 12 });
  await page.route('**/api/reports/*/findings', async route => {
    const response = await route.fetch();
    const result = await response.json();
    if (result.status === 'computed') {
      result.rule_set_id = 'pl-2018-04-01-v2-protected-v1';
      result.dwelling_distance = { status: 'measured', value_m: 145, search_radius_m: 1000 };
      result.accuracy_m = 12;
      result.noc = { status: 'not_computed', reason: 'incident_area' };
    }
    await route.fulfill({ response, json: result });
  });
  await page.goto('/');
  await page.getByRole('button', { name: 'Człowiek z bronią', exact: true }).click();
  await finishFromWhen(page, false);
  await page.getByRole('button', { name: 'Zapisz zgłoszenie' }).click();
  const dwelling = page.locator('[data-fact="dwelling"]');
  await expect(dwelling).toContainText('145 m', { timeout: 20_000 });
  await expect(dwelling).toContainText('±12 m');
  await expect(dwelling).toContainText('Przy tej dokładności nie wiadomo, po której stronie progu.');
  await expect(page.locator('[data-fact="ambona"]')).toContainText('Ambona oznaczona w OpenStreetMap');
  await expect(page.locator('.unchecked')).toContainText('noc (obszar obejmuje i noc, i dzień)');
  await expect(page.locator('.unchecked')).toContainText('okres ochronny (nie podano gatunku)');
  const opener = page.getByRole('button', { name: 'Skąd te wyniki' });
  await opener.focus();
  await page.keyboard.press('Enter');
  await expect(sources(page)).toBeVisible();
  await expect(sources(page)).toContainText('pomiar nie pozwala ustalić');
  await expect(sources(page)).toContainText('Dz.U. 2018 poz. 651');
  await expect(sources(page)).toContainText('Pokrycie OpenStreetMap jest niepełne.');
  await expect(sources(page)).not.toContainText('Datę porównano');
  await expect(sources(page).getByRole('link', { name: 'Pobierz zbiór oznaczonych ambon (ODbL)' })).toHaveAttribute('href', /\/api\/geodata\/.*\/ambony$/);
  await page.keyboard.press('Escape');
  await expect(sources(page)).toBeHidden();
  await page.getByRole('button', { name: 'Menu' }).click();
  await page.getByRole('button', { name: 'English' }).click();
  await page.getByRole('button', { name: 'Bór czuwa', exact: true }).click();
  await page.getByRole('banner').getByRole('button', { name: 'My records' }).click();
  await page.getByRole('button', { name: /^Person with a gun, / }).click();
  await expect(page.getByRole('heading', { name: 'Measurements', level: 2 })).toBeVisible();
  await expect(page.locator('[data-fact="dwelling"]')).toContainText('About 150 m. At this accuracy it is unclear which side of the threshold.');
  await page.getByRole('button', { name: 'Where these results come from' }).click();
  await expect(sources(page)).toContainText('OpenStreetMap coverage is incomplete.');
  await expect(sources(page)).toContainText('cannot tell which side');
  await expect(sources(page)).toContainText('Dz.U. 2018 poz. 651');
});

test('pending and failed Findings state why measurements are unavailable', async ({ page, context }) => {
  await context.setGeolocation({ latitude: points.edge.point.lat, longitude: points.edge.point.lon, accuracy: 12 });
  await page.goto('/');
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
    if (!navigator.serviceWorker.controller) await new Promise<void>(resolve =>
      navigator.serviceWorker.addEventListener('controllerchange', () => resolve(), { once: true }));
  });
  await context.setOffline(true);
  await page.getByRole('button', { name: 'Człowiek z bronią', exact: true }).click();
  await finishFromWhen(page, false);
  await page.getByRole('button', { name: 'Zapisz zgłoszenie' }).click();
  await expect(findingsBlock(page).getByRole('paragraph').filter({ hasText: 'Pomiary będą dostępne po zapisie zgłoszenia na serwerze.' })).toBeVisible();
  // Route before reconnecting, or the live worker's real Findings can arrive first.
  await page.route('**/api/reports/*/findings', route => route.fulfill({ json: { status: 'failed', reason: 'computation_failed' } }));
  await context.setOffline(false);
  const failed = findingsBlock(page).getByRole('paragraph').filter({ hasText: 'Nie udało się obliczyć ustaleń.' });
  await expect(failed).toBeVisible({ timeout: 20_000 });
  await expect(failed).toContainText('Możesz przygotować powiadomienie bez pomiarów.');
});

test('a place outside geodata coverage says once what was not checked and keeps the time Findings', async ({ page, context }) => {
  // West of the fixture's coverage, standing in for the sea or a state border.
  await context.setGeolocation({ latitude: 53.42, longitude: 22.63, accuracy: 12 });
  await page.route('**/api/reports/*/findings', async route => {
    const response = await route.fetch();
    const result = await response.json();
    // An older Rule set without the chosen species, as the worker reports it.
    if (result.status === 'computed') result.okres_ochronny = { status: 'not_computed', reason: 'species_not_in_rule_set' };
    await route.fulfill({ response, json: result });
  });
  await page.goto('/');
  await page.getByRole('button', { name: 'Człowiek z bronią', exact: true }).click();
  await finishFromWhen(page, false);
  await page.getByRole('button', { name: 'Zapisz zgłoszenie' }).click();
  const measurements = findingsBlock(page);
  await expect(measurements.locator('.unchecked')).toHaveText('Nie sprawdzono: zabudowania, obszary chronione, obwód łowiecki i ambona (miejsce poza zasięgiem danych); okres ochronny (reguły z tego okresu nie obejmują gatunku).', { timeout: 20_000 });
  await expect(measurements.locator('.facts-list > li')).toHaveCount(1);
  await expect(measurements.locator('[data-fact="noc"]')).toContainText(/Wschód słońca \d\d:\d\d, zachód \d\d:\d\d\./);
  for (const absent of ['Do zabudowań', 'Podano przybliżony obszar', 'Nie wskazano gatunku.'])
    await expect(measurements).not.toContainText(absent, { useInnerText: true });
});
