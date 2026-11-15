import { test, expect, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { answerHome, answerNow, blankTiles, chooseHours, choosePoint, footer, heading, leaveCompass, reportPost, save, setEstimate, startEvent } from './stages.ts';

const points = JSON.parse(await readFile(new URL('../../data/fixtures/acceptance.json', import.meta.url), 'utf8'));
const here = points.barn.point;

/** Marks a point south, 500 m away, on the target. */
async function southAt500(page: Page) {
  await setEstimate(page, 180, 500);
}

test.beforeEach(async ({ page, context }) => {
  await blankTiles(page);
  await context.setGeolocation({ latitude: here.lat, longitude: here.lon, accuracy: 8 });
});

const seen = [
  ['Człowiek z bronią', 'person_with_gun', 'Gdzie widzisz człowieka z bronią?'],
  ['Ranne zwierzę', 'injured_animal', 'Gdzie widzisz ranne zwierzę?'],
  ['Kłusownictwo', 'poaching', 'Gdzie to widzisz?']
] as const;

for (const [label] of seen) {
  test(`${label}: late GPS offers direction without replacing manual location`, async ({ page }) => {
    await page.addInitScript(() => {
      navigator.geolocation.watchPosition = success => {
        window.addEventListener('test-location', event => {
          const { lat, lon } = (event as CustomEvent).detail;
          success({ coords: { latitude: lat, longitude: lon, accuracy: 8 }, timestamp: Date.now() } as GeolocationPosition);
        }, { once: true });
        return 1;
      };
      navigator.geolocation.clearWatch = () => {};
    });
    await page.goto('/');
    await startEvent(page, label);
    await answerNow(page);
    const direction = page.getByRole('button', { name: 'Kierunek', exact: true });
    const manual = page.getByRole('button', { name: 'Wskaż miejsce', exact: true });
    await expect(direction).toHaveAttribute('aria-disabled', 'true');
    await expect(manual).toHaveAttribute('aria-pressed', 'true');
    await manual.focus();
    await page.evaluate(point => window.dispatchEvent(new CustomEvent('test-location', { detail: point })), here);
    await expect(direction).toHaveAttribute('aria-disabled', 'false');
    await expect(manual).toHaveAttribute('aria-pressed', 'true');
    await expect(manual).toBeFocused();
    await direction.click();
    await expect(page.getByRole('slider', { name: 'Tarcza kierunku' })).toBeVisible();
    await expect(direction).toHaveAttribute('aria-pressed', 'true');
    await expect(footer(page).getByRole('button', { name: 'Pomiń kierunek i odległość', exact: true })).toBeVisible();
    await leaveCompass(page);
    await expect(page.locator('#place-row')).toContainText('tam, gdzie jesteś');
  });
}

for (const [label, type, question] of seen) {
  test(`${label} happening now is placed by direction and distance from the Reporter`, async ({ page }) => {
    const upload = await reportPost(page);
    await page.goto('/');
    await startEvent(page, label);
    await answerNow(page);
    await expect(heading(page, question)).toBeVisible();
    await expect(page.getByText('słychać', { exact: false })).toHaveCount(0);
    await southAt500(page);
    await leaveCompass(page);
    await answerHome(page, false);
    await expect(page.locator('#place-row')).toContainText('około 500 m na południe od Ciebie');
    await save(page);
    const payload = (await upload.request).postDataJSON();
    expect(payload.event_type).toBe(type);
    expect(payload.device_fix).toBeNull();
    expect(payload.incident_location).toMatchObject({ type: 'area', basis: 'estimated_from_sighting',
      precise_fix_withheld: null, hearing_bearing_deg: 180, hearing_distance_m: 500 });
  });
}

test('from home a seen Event says "od domu" and sends only the grid cell', async ({ page }) => {
  const upload = await reportPost(page);
  await page.goto('/');
  await startEvent(page, 'Ranne zwierzę');
  await answerNow(page);
  await southAt500(page);
  await leaveCompass(page);
  await answerHome(page, true);
  await expect(page.locator('#place-row')).toContainText('około 500 m na południe od domu');
  await save(page);
  const payload = (await upload.request).postDataJSON();
  expect(payload.incident_location).toMatchObject({ type: 'area', basis: 'estimated_from_sighting', precise_fix_withheld: 'home_privacy' });
  for (const field of ['hearing_bearing_deg', 'hearing_distance_m']) expect(payload.incident_location[field]).toBeUndefined();
  expect(JSON.stringify(payload)).not.toContain(String(here.lat));
});

test('Pomiń keeps the phone position as the point it is', async ({ page }) => {
  const upload = await reportPost(page);
  await page.goto('/');
  await startEvent(page, 'Człowiek z bronią');
  await answerNow(page);
  await expect(footer(page).getByRole('button', { name: 'Pomiń kierunek i odległość', exact: true })).toBeVisible();
  await leaveCompass(page);
  await answerHome(page, false);
  await expect(page.locator('#place-row')).toContainText('tam, gdzie jesteś');
  await save(page);
  const payload = (await upload.request).postDataJSON();
  expect(payload.incident_location).toEqual({ lat: here.lat, lon: here.lon, source: 'device_fix' });
});

test('Szczątki w lesie now, and every seen Event made earlier, keep their old places', async ({ page }) => {
  await page.goto('/');
  await startEvent(page, 'Szczątki w lesie');
  await answerNow(page);
  await expect(heading(page, 'Sprawdź i zapisz')).toBeVisible();
  await expect(page.locator('#place-row')).toContainText('tam, gdzie jesteś');

  await page.goto('/');
  await startEvent(page, 'Kłusownictwo');
  await page.getByRole('button', { name: /^Kilka godzin temu/ }).click();
  await chooseHours(page, 2);
  await footer(page).getByRole('button', { name: 'Dalej' }).click();
  await expect(heading(page, 'Gdzie to było?')).toBeVisible();
  await expect(page.getByRole('slider', { name: 'Tarcza kierunku' })).toHaveCount(0);
  await choosePoint(page, here.lat + 0.02, here.lon);
  await expect(page.locator('#place-row')).toContainText('w promieniu około 500 m od wskazanego miejsca');
});

test('a sighting syncs, and the saved Report and its Notice say it was seen', async ({ page }) => {
  await page.goto('/');
  await startEvent(page, 'Człowiek z bronią');
  await answerNow(page);
  await southAt500(page);
  await leaveCompass(page);
  await answerHome(page, false);
  await save(page);
  await expect(page.getByText('Zapisano na serwerze.', { exact: true })).toBeVisible();
  await page.getByText('Szczegóły zgłoszenia', { exact: true }).click();
  await expect(page.locator('.facts')).toContainText('Obszar oszacowano z obserwacji: ok. 500 m od Ciebie, kierunek ok. 180° (południe).');
  await expect(page.locator('.facts')).toContainText('Odległość od zabudowań podają pomiary powyżej.');
  await page.getByText('Opis miejsca do powiadomienia').click();
  await expect(page.getByText('Obszar oszacowano z obserwacji (kierunek ok. 180° (południe), odległość ok. 500 m). Nie jest to pomiar GPS miejsca zdarzenia.',
    { exact: false })).toBeVisible();
});
