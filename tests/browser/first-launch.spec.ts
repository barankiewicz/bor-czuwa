import { expect, test } from '@playwright/test';
import { stubReportServer } from './stages.ts';
import { openLegalDraft } from './demo.ts';

test.use({ storageState: { cookies: [], origins: [] } });

test('first launch appears once and stays available from menu', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Zanim zaczniesz' })).toBeVisible();
  await expect(page.getByText('Zgłoszenie nie sprowadza pomocy.')).toBeVisible();
  await expect(page.getByRole('link', { name: 'Polityka prywatności' })).toHaveAttribute('href', '/legal/privacy/v1/');
  await page.getByRole('button', { name: 'Dalej bez lokalizacji' }).click();
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Co się stało?' })).toBeVisible();
  await page.getByRole('button', { name: 'Menu' }).click();
  await page.getByRole('button', { name: 'Informacje na początek' }).click();
  await expect(page.getByRole('heading', { name: 'Zanim zaczniesz' })).toBeVisible();
});

test('language switch changes capture flow and legal links remain available', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'English' }).click();
  await expect(page.getByRole('heading', { name: 'Before you begin' })).toBeVisible();
  await page.getByRole('button', { name: 'Allow location access' }).click();
  await expect(page.getByRole('heading', { name: 'What happened?' })).toBeVisible();
  await page.getByRole('button', { name: 'Person with a gun', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'When did it happen?' })).toBeVisible();
  await expect(page.locator('.steps li')).toHaveText(['When', 'Where', 'Check']);
  await expect(page.getByText('Do not approach or interfere.', { exact: false })).toBeVisible();
  await page.getByRole('button', { name: 'Menu' }).click();
  await expect(page.getByRole('link', { name: 'Privacy policy' })).toHaveAttribute('href', '/legal/privacy/v1/');
  await page.getByRole('link', { name: 'Privacy policy' }).click();
  await expect(page.getByRole('link', { name: 'Back to the app' })).toBeVisible();
});

test('legal drafts are readable and reported-person anchor is stable', async ({ page }) => {
  await page.goto('/legal/privacy/v1/');
  await openLegalDraft(page);
  await expect(page.getByRole('heading', { name: 'Polityka prywatności' })).toBeVisible();
  await expect(page.locator('#jesli-zgloszenie-dotyczy-ciebie')).toHaveText('Jeśli zgłoszenie dotyczy ciebie');
  await page.goto('/legal/terms/v1/');
  await openLegalDraft(page);
  await expect(page.getByRole('heading', { name: 'Regulamin serwisu' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'polityka prywatności' })).toHaveAttribute('href', '/legal/privacy/v1/');
});

test('Android web explains app extras quietly', async ({ page }) => {
  await page.addInitScript(() => Object.defineProperty(navigator, 'userAgent', { value: 'Mozilla/5.0 (Linux; Android 15)', configurable: true }));
  await page.goto('/');
  const extras = page.getByText('Aplikacja na Androida dodaje załączniki zdjęć do wiadomości i przypomina o szkicu następnego dnia i trzy dni po jego zapisaniu.');
  // Said once, in Menu; welcome no longer repeats it (ticket 29 filler cut).
  await page.getByText('Co dzieje się ze zgłoszeniem', { exact: true }).click();
  await expect(extras).toHaveCount(0);
  await page.getByRole('button', { name: 'Dalej bez lokalizacji' }).click();
  await page.getByRole('button', { name: 'Menu' }).click();
  await expect(extras).toBeVisible();
});

test('English interface keeps Notice wording in Polish', async ({ page, context }) => {
  await context.setGeolocation({ latitude: 52.1, longitude: 19.4, accuracy: 12 });
  // The Notice is composed on the phone, so the upload spends no daily Report.
  await stubReportServer(page);
  await page.goto('/');
  await page.getByRole('button', { name: 'English' }).click();
  await page.getByRole('button', { name: 'Allow location access' }).click();
  await page.getByRole('button', { name: 'Shot', exact: true }).click();
  await page.getByRole('button', { name: /^Now/ }).click();
  await page.locator('.screen-foot').getByRole('button', { name: 'Skip' }).click();
  await expect(page.getByRole('heading', { name: 'Check and save' })).toBeVisible();
  await page.locator('#home-check').getByRole('button', { name: 'No', exact: true }).click();
  await page.getByRole('button', { name: 'Save Report' }).click();
  await page.locator('summary').filter({ hasText: 'Report details' }).click();
  await expect(page.locator('.facts')).toContainText('The area was marked without estimating direction and distance.');
  await page.getByText('Location description for Notice').click();
  await expect(page.getByText('I do not know the exact place where the shot was fired.', { exact: false })).toBeVisible();
  await page.getByRole('button', { name: 'Prepare Notice', exact: true }).click();
  await page.getByRole('button', { name: 'Choose an authority by name', exact: true }).click();
  await page.getByLabel('Name or town').fill('Monkach');
  await page.getByRole('button', { name: /Komenda Powiatowa Policji w Mońkach/ }).click();
  await page.getByRole('button', { name: 'Next: signature', exact: true }).click();
  await page.getByRole('radio', { name: 'Unsigned' }).check();
  await page.getByRole('button', { name: 'Prepare Notices', exact: true }).click();
  await page.getByText('Review the Notice text', { exact: true }).click();
  await expect(page.locator('.notice-body')).toContainText('Obszar wskazano bez oszacowania kierunku i odległości.');
});
