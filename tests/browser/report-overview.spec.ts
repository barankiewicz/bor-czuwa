import { test, expect, type Page } from '@playwright/test';
import { finishFromWhen } from './stages.ts';

test.use({ serviceWorkers: 'block' });

async function saveReport(page: Page, upload = false) {
  await page.context().setGeolocation({ latitude: 53.45, longitude: 22.8, accuracy: 8 });
  if (!upload) await page.route('**/api/challenge', route => route.abort());
  await page.goto('/');
  await page.getByRole('button', { name: 'Człowiek z bronią', exact: true }).click();
  await finishFromWhen(page, false);
  await page.getByRole('button', { name: 'Zapisz zgłoszenie' }).click();
}

test('saved Report explains independent states and reopens as a record', async ({ page }, testInfo) => {
  await saveReport(page);
  await expect(page.getByRole('heading', { name: 'Zgłoszenie', exact: true })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('saved-report.png') });
  await expect(page.getByRole('list', { name: 'Stan zgłoszenia' }).getByRole('status')).toHaveCount(1);
  await expect(page.getByText('Zapisano. Wrócisz w Moich zapisach.', { exact: true })).toHaveCount(0);
  await expect(page.getByText(/Ponowna próba:/)).toContainText(/dziś \d{2}:\d{2}/);
  // Findings own their results now; the status list says only where the Report is saved.
  await expect(page.getByRole('list', { name: 'Stan zgłoszenia' })).not.toContainText('Pomiary');
  await expect(page.getByText('Powiadomienie jest opcjonalne. Nie musisz czekać na pomiary.', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Gotowe, wróć do początku' }).click();
  await page.getByRole('button', { name: 'Moje zapisy', exact: true }).click();
  await page.getByRole('button', { name: /^Człowiek z bronią, / }).click();
  await expect(page.getByRole('heading', { name: 'Zgłoszenie', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Przygotuj powiadomienie' })).toBeVisible();
  await expect(page.getByText('Jeśli zgłoszenie jest pomyłką', { exact: false })).toHaveCount(0);
});

test('preparation survives Back and restart and opens handoff without duplicate Notices', async ({ page }) => {
  await saveReport(page);
  await page.getByRole('button', { name: 'Przygotuj powiadomienie' }).click();
  await expect(page.getByRole('heading', { name: 'Do kogo napisać?' })).toBeVisible();
  await expect(page.getByLabel(/Komenda Powiatowa Policji w Mońkach/)).toBeChecked();
  await page.getByLabel(/Państwowa Straż Łowiecka - podlaskie/).uncheck();
  await page.getByRole('button', { name: 'Dalej: podpis' }).click();
  await page.getByRole('radio', { name: 'Z podpisem' }).check();
  await page.getByLabel('Imię i nazwisko').fill('Jan Testowy');
  await page.getByLabel('Adres do korespondencji').fill('ul. Testowa 1');
  await page.goBack();
  await expect(page.getByLabel(/Państwowa Straż Łowiecka - podlaskie/)).not.toBeChecked();
  await page.getByRole('button', { name: 'Dalej: podpis' }).click();
  await expect(page.getByRole('radio', { name: 'Z podpisem' })).toBeChecked();
  await expect(page.getByLabel('Imię i nazwisko')).toHaveValue('Jan Testowy');
  await page.getByRole('radio', { name: 'Bez podpisu' }).check();
  await expect(page.getByRole('button', { name: 'Przygotuj powiadomienia' })).toBeEnabled();
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Jak chcesz się podpisać?' })).toBeVisible();
  await expect(page.getByRole('radio', { name: 'Bez podpisu' })).toBeChecked();
  await page.getByRole('button', { name: 'Przygotuj powiadomienia' }).click();
  await expect(page.getByRole('heading', { name: 'Komenda Powiatowa Policji w Mońkach' })).toBeVisible();
  await expect(page.locator('.notice-body')).toContainText('Ustalenia nie są jeszcze dostępne');
  await page.goBack();
  await expect(page.getByRole('heading', { name: 'Do kogo napisać?' })).toBeVisible();
  await page.getByRole('button', { name: 'Dalej: podpis' }).click();
  await page.getByRole('button', { name: 'Przygotuj powiadomienia' }).click();
  await page.getByRole('button', { name: 'Moje zapisy', exact: true }).click();
  await page.getByRole('button', { name: /^Człowiek z bronią, / }).click();
  await expect(page.locator('.report-notices .row')).toHaveCount(1);
  await expect(page.locator('.report-action .primary')).toHaveText('Powiadomienia do urzędów');
});

test('delayed jurisdiction lookup retains an explicit recipient override', async ({ page }) => {
  let release!: () => void;
  const delayed = new Promise<void>(resolve => { release = resolve; });
  await page.route('**/api/recipients', async route => {
    await delayed;
    await route.fulfill({ json: { candidates: [
      { kind: 'police', id: 'c753fb0c-78e2-419d-ad48-d7bf3b5218ac', catalog: 'matched' },
      { kind: 'psl', id: '20', catalog: 'matched' }
    ] } });
  });
  await saveReport(page);
  await page.getByRole('button', { name: 'Przygotuj powiadomienie' }).click();
  await page.getByRole('button', { name: 'Wybierz inną jednostkę po nazwie' }).click();
  await page.getByLabel('Nazwa lub miejscowość').fill('Monkach');
  await page.getByRole('button', { name: /Komenda Powiatowa Policji w Mońkach/ }).click();
  await page.getByRole('group', { name: 'Wybrane po nazwie' }).getByRole('checkbox').uncheck();
  release();
  await expect(page.getByRole('group', { name: 'Policja' }).getByRole('checkbox')).not.toBeChecked();
  await expect(page.getByLabel(/Państwowa Straż Łowiecka - podlaskie/)).toBeChecked();
  await page.reload();
  await expect(page.getByRole('group', { name: 'Policja' }).getByRole('checkbox')).not.toBeChecked();
});

test('Withdrawal confirmation focuses Cancel and Escape and Back cancel without deleting', async ({ page }) => {
  await saveReport(page);
  await page.getByRole('button', { name: 'Wycofaj zgłoszenie' }).click();
  await expect(page.getByRole('button', { name: 'Anuluj', exact: true })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('button', { name: 'Wycofaj zgłoszenie' })).toBeFocused();
  await expect(page.getByRole('group', { name: 'Wycofać to zgłoszenie?' })).toHaveCount(0);
  await page.getByRole('button', { name: 'Wycofaj zgłoszenie' }).click();
  await page.getByRole('button', { name: 'Wróć', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Zgłoszenie', exact: true })).toBeVisible();
  await expect(page.getByRole('group', { name: 'Wycofać to zgłoszenie?' })).toHaveCount(0);
});

for (const state of ['pending', 'failed', 'refused'] as const) {
  test(`${state} Findings never block optional preparation`, async ({ page }) => {
    await page.route('**/api/reports', route => route.fulfill({ status: state === 'refused' ? 400 : 201, json: {} }));
    await page.route('**/api/reports/*/findings', route => route.fulfill({ json: state === 'failed'
      ? { status: 'failed', reason: 'test' } : { status: 'pending' } }));
    await page.route('**/api/reports/*/events', route => route.fulfill({ status: 204 }));
    await saveReport(page, true);
    await expect(page.getByRole('list', { name: 'Stan zgłoszenia' }).or(page.locator('section.findings')).filter({ hasText: state === 'refused' ? 'Serwer nie przyjął zgłoszenia' : state === 'failed'
      ? 'Nie udało się obliczyć ustaleń' : 'Czekamy na pomiary' }).first()).toBeVisible();
    await page.getByRole('button', { name: 'Przygotuj powiadomienie' }).click();
    await expect(page.getByLabel(/Komenda Powiatowa Policji w Mońkach/)).toBeChecked();
    await page.getByRole('button', { name: 'Dalej: podpis' }).click();
    await page.getByRole('radio', { name: 'Bez podpisu' }).check();
    await page.getByRole('button', { name: 'Przygotuj powiadomienia' }).click();
    await expect(page.locator('.notice-body')).toContainText(state === 'failed' ? 'Nie udało się obliczyć ustaleń' : 'Ustalenia nie są jeszcze dostępne');
    await expect(page.getByRole('link', { name: 'Otwórz w poczcie' })).toBeVisible();
  });
}


test('editing a reused Signed Notice updates its signer and recipient context', async ({ page }) => {
  await page.route('**/api/recipients', route => route.fulfill({ json: { candidates: [
    { kind: 'police', id: 'c753fb0c-78e2-419d-ad48-d7bf3b5218ac', catalog: 'matched' },
    { kind: 'psl', id: '20', catalog: 'matched' },
    { kind: 'gmina', id: '2008032', catalog: 'matched' },
    { kind: 'gmina', id: '2008063', catalog: 'matched' }
  ] } }));
  await saveReport(page);
  await page.getByRole('button', { name: 'Przygotuj powiadomienie' }).click();
  await expect(page.getByLabel(/Komenda Powiatowa Policji w Mońkach/)).toBeChecked();
  await page.getByRole('radio', { name: /^Jaświły/ }).check();
  await page.getByRole('button', { name: 'Dalej: podpis' }).click();
  await page.getByRole('radio', { name: 'Z podpisem', exact: true }).check();
  await page.getByLabel('Imię i nazwisko').fill('Jan Pierwszy');
  await page.getByLabel('Adres do korespondencji').fill('ul. Pierwsza 1');
  await page.getByRole('button', { name: 'Przygotuj powiadomienia' }).click();
  await expect(page.locator('.notice-body')).toContainText('Jan Pierwszy');
  await page.goBack();
  await page.getByRole('radio', { name: /^Mońki/ }).check();
  await page.getByLabel(/Państwowa Straż Łowiecka - podlaskie/).uncheck();
  await page.getByRole('button', { name: 'Dalej: podpis' }).click();
  await page.getByLabel('Imię i nazwisko').fill('Jan Drugi');
  await page.getByLabel('Adres do korespondencji').fill('ul. Druga 2');
  await page.getByRole('button', { name: 'Przygotuj powiadomienia' }).click();
  await expect(page.locator('.notice-body')).toContainText('Jan Drugi');
  await expect(page.locator('.notice-body')).toContainText('ul. Druga 2');
  await expect(page.locator('.notice-body')).toContainText('Gmina: Mońki, wskazana przez zgłaszającego');
  await expect(page.locator('.notice-body')).not.toContainText('Państwowa Straż Łowiecka - podlaskie');
});

test('switching Reports while lookup is pending starts the new Report lookup', async ({ page }) => {
  let lookups = 0;
  let release!: () => void;
  const first = new Promise<void>(resolve => { release = resolve; });
  await page.route('**/api/recipients', async route => {
    if (++lookups === 1) await first;
    await route.fulfill({ json: { candidates: [
      { kind: 'police', id: 'c753fb0c-78e2-419d-ad48-d7bf3b5218ac', catalog: 'matched' }
    ] } });
  });
  await saveReport(page);
  await page.getByRole('button', { name: 'Przygotuj powiadomienie' }).click();
  await expect.poll(() => lookups).toBe(1);
  await page.getByRole('button', { name: 'Bór czuwa', exact: true }).click();
  await page.getByRole('button', { name: 'Człowiek z bronią', exact: true }).click();
  await finishFromWhen(page, false);
  await page.getByRole('button', { name: 'Zapisz zgłoszenie' }).click();
  await page.getByRole('button', { name: 'Przygotuj powiadomienie' }).click();
  await expect(page.getByLabel(/Komenda Powiatowa Policji w Mońkach/)).toBeChecked();
  await expect.poll(() => lookups).toBe(2);
  release();
});
