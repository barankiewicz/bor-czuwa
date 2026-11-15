import { test, expect, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { clockedGeolocation, openMap, answerHome, blankTiles, chooseHours, footer, heading, reportPost, save, startEvent } from './stages.ts';

test.use({ serviceWorkers: 'block' });

const points = JSON.parse(await readFile(new URL('../../data/fixtures/acceptance.json', import.meta.url), 'utf8'));

/** On Gdzie's map, puts the point at the map centre (the recording fix) with the keyboard and moves on. */
async function pointAtFix(page: Page) {
  await expect(heading(page, /^(Gdzie to było\?|Skąd padł strzał\?)$/)).toBeVisible();
  await openMap(page);
  await expect(page.locator('.map-surface')).toHaveAttribute('aria-disabled', 'false');
  await page.locator('.map-surface').focus();
  await page.keyboard.press('Enter');
  await footer(page).getByRole('button', { name: 'Dalej' }).click();
  await expect(heading(page, 'Sprawdź i zapisz')).toBeVisible();
}

test.beforeEach(async ({ page }) => { await blankTiles(page); });

test('a day and a Species survive leaving the Draft and reach Findings', async ({ page, context }) => {
  await context.setGeolocation({ latitude: points.barn.point.lat, longitude: points.barn.point.lon, accuracy: 8 });
  await page.clock.install({ time: new Date('2026-09-24T10:00:00+02:00') });
  await clockedGeolocation(page);
  await page.goto('/');
  await startEvent(page, 'Ranne zwierzę');
  await page.getByRole('button', { name: 'Innego dnia' }).click();
  await page.getByLabel('Którego dnia?').fill('2026-03-15');
  await footer(page).getByRole('button', { name: 'Dalej' }).click();
  await pointAtFix(page);
  await answerHome(page, false);
  await page.locator('summary', { hasText: 'Gatunek' }).click();
  await page.getByRole('radio', { name: 'Sarna', exact: true }).check();
  await expect(page.locator('summary', { hasText: 'Gatunek' })).toContainText('Sarna');
  await footer(page).getByRole('button', { name: 'Dokończę później' }).click();
  await page.getByRole('button', { name: /^Dokończ zgłoszenie/ }).click();
  await expect(heading(page, 'Sprawdź i zapisz')).toBeVisible();
  await expect(page.locator('#when-row')).toContainText('Innego dnia, 15 marca');
  await expect(page.locator('summary', { hasText: 'Gatunek' })).toContainText('Sarna');
  await expect(page.locator('#draft-next')).toHaveCount(0);
  await save(page);
  await expect(page.getByText('Zapisano na serwerze.', { exact: true })).toBeVisible({ timeout: 20_000 });
  await expect(page.locator('[data-fact="season"]')).toContainText('Data zdarzenia przypada w okresie ochronnym.');
  await expect(page.locator('[data-fact="season"] .fact-value')).toHaveText('Tak');
});

test('finishing a Draft later keeps the captured time as the end of an earlier-hours window', async ({ page, context }) => {
  await context.setGeolocation({ latitude: points.edge.point.lat, longitude: points.edge.point.lon, accuracy: 8 });
  await page.clock.install({ time: new Date('2026-06-15T12:00:00Z') });
  await clockedGeolocation(page);
  await page.goto('/');
  await startEvent(page, 'Strzał');
  await page.getByRole('button', { name: 'Kilka godzin temu' }).click();
  await chooseHours(page, 3);
  await footer(page).getByRole('button', { name: 'Dalej' }).click();
  await pointAtFix(page);
  await answerHome(page, false);
  await page.clock.fastForward(48 * 3_600_000);
  const posted = await reportPost(page);
  await save(page);
  const payload = (await posted.request).postDataJSON();
  expect(payload.captured_at.slice(0, 16)).toBe('2026-06-15T12:00');
  expect(payload.occurred_at.window_end).toBe(payload.captured_at);
  expect(new Date(payload.occurred_at.window_end).getTime() - new Date(payload.occurred_at.at).getTime()).toBe(3 * 3_600_000);
  expect(payload.occurred_at.source).toBe('entered_by_reporter');
  expect(payload.occurred_at.coarseness).toBe('within_hours');
  // A point chosen for an earlier shot is an area the Reporter drew, with no hearing estimate.
  expect(payload.incident_location).toMatchObject({ type: 'area', basis: 'reporter_selected_area', precise_fix_withheld: null });
});
