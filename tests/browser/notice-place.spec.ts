import { test, expect, type Page } from '@playwright/test';
import { untilOfflineReady } from '../helpers/offline.ts';
import type { RecipientUnit } from '../../src/lib/recipient-resolver.ts';
type SavedReport = { report: { incident_location: unknown }; findings: unknown; noticePreparation?: {
  choices: unknown[]; gminaAnswer?: string | null; gminaCorrection?: RecipientUnit;
} };
import { toReview, save, openNoticeRow } from './stages.ts';

const single = {
  candidates: [
    { kind: 'gmina', id: '2008063', name: 'Urząd Miejski w Mońkach', catalog: 'matched' },
    { kind: 'police', id: 'c753fb0c-78e2-419d-ad48-d7bf3b5218ac', name: 'Policja', catalog: 'matched' }
  ],
  places: { gmina: 'Mońki', powiat: 'powiat moniecki', nadlesnictwo: 'NADLEŚNICTWO KNYSZYN' },
  ambiguity: { ambiguous: false, roles: [], unresolved: [] }
};

async function localReport(page: Page) {
  return page.evaluate(() => new Promise<SavedReport>((resolve, reject) => {
    const opening = indexedDB.open('bor-czuwa');
    opening.onerror = () => reject(opening.error);
    opening.onsuccess = () => {
      const db = opening.result;
      const request = db.transaction('reports').objectStore('reports').getAll();
      request.onsuccess = () => { resolve(request.result[0]); db.close(); };
    };
  }));
}

test.beforeEach(async ({ page, context }) => {
  await context.setGeolocation({ latitude: 53.45, longitude: 22.8, accuracy: 8 });
  await page.route('**/api/challenge', route => route.abort());
  await page.route('**/api/recipients', route => route.fulfill({ json: single }));
  await page.goto('/');
  await toReview(page, 'Człowiek z bronią', false);
  await save(page);
  await page.getByRole('button', { name: 'Przygotuj powiadomienie', exact: true }).click();
  await expect(page.locator('.recipient-place')).toContainText('Mońki');
});

test('single proposal can be corrected to rural or municipal gmina, reopened, made unknown and restored', async ({ page }) => {
  const original = await localReport(page);
  await page.getByRole('button', { name: 'Zmień gminę', exact: true }).click();
  const search = page.getByLabel('Nazwa gminy');
  await expect(search).toBeFocused();
  await search.fill('Boleslawiec');
  const rural = page.getByRole('button', { name: 'Bolesławiec gmina wiejska · powiat bolesławiecki · woj. dolnośląskie', exact: true });
  const municipal = page.getByRole('button', { name: 'Bolesławiec gmina miejska · powiat bolesławiecki · woj. dolnośląskie', exact: true });
  await expect(rural).toBeVisible();
  await expect(municipal).toBeVisible();
  await rural.click();
  await expect(page.locator('.recipient-place')).toContainText('gmina wiejska');
  await expect(page.getByRole('button', { name: 'Zmień gminę', exact: true })).toBeFocused();
  await expect.poll(async () => (await localReport(page)).noticePreparation?.gminaCorrection?.jstType).toBe('GW');
  await page.reload();
  await expect(page.locator('.recipient-place')).toContainText('Bolesławiec');
  await expect(page.locator('.recipient-place')).toContainText('gmina wiejska');
  const corrected = await localReport(page);
  expect(corrected.report.incident_location).toEqual(original.report.incident_location);
  expect(corrected.findings).toEqual(original.findings);
  expect(corrected.noticePreparation?.choices).toEqual(original.noticePreparation?.choices);
  await page.getByRole('button', { name: 'Nie wiem, która gmina', exact: true }).click();
  await expect(page.locator('.recipient-place')).toContainText('Nie ustalono');
  await expect.poll(async () => (await localReport(page)).noticePreparation?.gminaAnswer).toBeNull();
  await page.reload();
  await expect(page.locator('.recipient-place')).toContainText('Nie ustalono');
  await page.getByRole('button', { name: 'Przywróć podpowiedź z miejsca zdarzenia', exact: true }).click();
  await expect(page.locator('.recipient-place')).toContainText('Mońki');
  await page.getByRole('button', { name: 'Zmień gminę', exact: true }).click();
  await search.fill('Bolesławiec');
  await municipal.click();
  await expect(page.locator('.recipient-place')).toContainText('gmina miejska');
  await page.getByRole('button', { name: 'Dalej: podpis' }).click();
  await page.getByRole('radio', { name: 'Bez podpisu', exact: true }).check();
  await page.getByRole('button', { name: 'Przygotuj powiadomienia', exact: true }).click();
  await openNoticeRow(page);
  await expect(page.locator('.notice-body')).toContainText('Gmina: Bolesławiec (gmina miejska). Powiat: powiat bolesławiecki.');
  await expect(page.locator('.notice-body')).toContainText('Gminę wskazał zgłaszający.');
  await expect(page.locator('.notice-body')).toContainText('Podpowiedź według zapisanego miejsca: Mońki.');
});

async function correctToRural(page: Page) {
  await page.getByRole('button', { name: 'Zmień gminę', exact: true }).click();
  await page.getByLabel('Nazwa gminy').fill('Bolesławiec');
  await page.getByRole('button', { name: 'Bolesławiec gmina wiejska · powiat bolesławiecki · woj. dolnośląskie', exact: true }).click();
  await expect.poll(async () => (await localReport(page)).noticePreparation?.gminaCorrection?.jstType).toBe('GW');
}

test('failed lookup preserves correction and recipients and offers finishing later', async ({ page }) => {
  await correctToRural(page);
  const saved = await localReport(page);
  await page.route('**/api/recipients', route => route.fulfill({ status: 503, json: {} }));
  await page.reload();
  await expect(page.getByText('Nie udało się pobrać podpowiedzi urzędów. Spróbuj ponownie lub dokończ później.')).toBeVisible();
  await expect(page.locator('.recipient-place')).toContainText('Bolesławiec');
  await expect(page.locator('.screen-foot .primary')).toHaveText('Dokończę później');
  expect((await localReport(page)).noticePreparation?.choices).toEqual(saved.noticePreparation?.choices);
  await page.locator('.screen-foot .primary').click();
  expect((await localReport(page)).noticePreparation?.gminaCorrection).toEqual(saved.noticePreparation?.gminaCorrection);
});

test.describe('without a cached catalog', () => {
  test.use({ serviceWorkers: 'block' });

test('missing catalog preserves readable correction without inventing a replacement', async ({ page }) => {
  await correctToRural(page);
  await page.route(/\/(police|regional|parks|gminy)[^/]*\.json/, route => route.abort());
  await page.reload();
  await expect(page.getByText('Nie udało się wczytać katalogu urzędów.')).toBeVisible();
  await expect(page.locator('.recipient-place')).toContainText('Bolesławiec');
  await expect(page.locator('.recipient-place')).toContainText('gmina wiejska · powiat bolesławiecki · woj. dolnośląskie');
  await expect(page.getByRole('button', { name: 'Dokończę później', exact: true }).filter({ visible: true })).toBeVisible();
});

test('saved proposal choice stays named when the catalog cannot load', async ({ page }) => {
  await page.route('**/api/recipients', route => route.fulfill({ json: {
    candidates: [single.candidates[1],
      { kind: 'gmina', id: '0201011', name: 'Bolesławiec', catalog: 'matched' },
      { kind: 'gmina', id: '0201022', name: 'Bolesławiec', catalog: 'matched' }],
    ambiguity: { ambiguous: true, roles: ['gmina'], unresolved: [] }
  } }));
  await page.reload();
  const question = page.getByRole('group', { name: /W której gminie to było/ });
  await question.getByRole('radio', { name: /Bolesławiec gmina wiejska/ }).check();
  await expect.poll(async () => (await localReport(page)).noticePreparation?.gminaAnswer).toBe('0201022');
  await page.route(/\/(police|regional|parks|gminy)[^/]*\.json/, route => route.abort());
  await page.reload();
  await expect(page.getByText('Nie udało się wczytać katalogu urzędów.')).toBeVisible();
  await expect(page.locator('.recipient-place')).toContainText('Bolesławiec');
  await expect(page.locator('.recipient-place')).toContainText('gmina wiejska · powiat bolesławiecki · woj. dolnośląskie');
});

});

test('ambiguous proposals expose regional labels, allow catalog correction and restore the unanswered choice', async ({ page }) => {
  await page.route('**/api/recipients', route => route.fulfill({ json: {
    candidates: [single.candidates[1],
      { kind: 'gmina', id: '0201011', name: 'Bolesławiec', catalog: 'matched' },
      { kind: 'gmina', id: '0201022', name: 'Bolesławiec', catalog: 'matched' }],
    ambiguity: { ambiguous: true, roles: ['gmina'], unresolved: [] }
  } }));
  await page.reload();
  const question = page.getByRole('group', { name: /W której gminie to było/ });
  await expect(question.getByText('gmina miejska · powiat bolesławiecki · woj. dolnośląskie', { exact: true })).toBeVisible();
  await expect(question.getByText('gmina wiejska · powiat bolesławiecki · woj. dolnośląskie', { exact: true })).toBeVisible();
  const municipal = question.getByRole('radio', { name: 'Bolesławiec gmina miejska · powiat bolesławiecki · woj. dolnośląskie', exact: true });
  const rural = question.getByRole('radio', { name: 'Bolesławiec gmina wiejska · powiat bolesławiecki · woj. dolnośląskie', exact: true });
  await municipal.focus();
  await page.keyboard.press('ArrowDown');
  await expect(rural).toBeChecked();
  await expect(rural).toBeFocused();
  await page.keyboard.press('ArrowUp');
  await expect(municipal).toBeChecked();
  await expect(municipal).toBeFocused();
  await correctToRural(page);
  await page.getByRole('button', { name: 'Przywróć podpowiedź z miejsca zdarzenia', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Dalej: podpis', exact: true })).toBeDisabled();
  await question.getByRole('radio', { name: 'Nie wiem', exact: true }).check();
  await page.getByRole('button', { name: 'Dalej: podpis', exact: true }).click();
  await page.getByRole('radio', { name: 'Bez podpisu', exact: true }).check();
  await page.getByRole('button', { name: 'Przygotuj powiadomienia', exact: true }).click();
  await openNoticeRow(page);
  await expect(page.locator('.notice-body')).toContainText('Gmina: nie ustalono (miejsce zdarzenia leży na granicy gmin: Bolesławiec, Bolesławiec)');
});

test('signed corrected Notice keeps signer identity and catalog correction out of app requests', async ({ page }) => {
  const requests: string[] = [];
  page.on('request', request => { if (request.url().includes('/api/')) requests.push(`${request.url()} ${request.postData() ?? ''}`); });
  await correctToRural(page);
  await page.route('**/api/recipients', route => route.fulfill({ status: 503, json: {} }));
  await page.reload();
  await expect(page.getByText('Nie udało się pobrać podpowiedzi urzędów. Spróbuj ponownie lub dokończ później.')).toBeVisible();
  await page.getByRole('button', { name: 'Dalej: podpis', exact: true }).click();
  await page.getByRole('radio', { name: 'Z podpisem', exact: true }).check();
  await page.getByLabel('Imię i nazwisko').fill('Testowa Osoba');
  await page.getByLabel('Adres do korespondencji').fill('Adres testowy 271');
  await page.getByLabel('Telefon (opcjonalnie)').fill('600000027');
  const beforeReturn = requests.filter(value => value.includes('/api/recipients')).length;
  await page.getByRole('button', { name: 'Wróć', exact: true }).click();
  await expect(page.locator('.recipient-place')).toContainText('Bolesławiec');
  await expect.poll(() => requests.filter(value => value.includes('/api/recipients')).length).toBeGreaterThan(beforeReturn);
  await page.getByRole('button', { name: 'Dalej: podpis', exact: true }).click();
  await page.getByRole('button', { name: 'Przygotuj powiadomienia', exact: true }).click();
  await openNoticeRow(page);
  await expect(page.locator('.notice-body')).toContainText('Testowa Osoba');
  await expect(page.locator('.notice-body')).toContainText('Telefon: 600000027');
  await page.reload();
  const saved = await localReport(page);
  expect(JSON.stringify(saved.noticePreparation)).not.toContain('Testowa Osoba');
  for (const secret of ['Testowa Osoba', 'Adres testowy 271', '600000027', 'Bolesławiec', 'gminaCorrection']) {
    expect(requests.join('\n')).not.toContain(secret);
  }
});


test('offline reopening keeps correction and local search available', async ({ page, context }) => {
  await correctToRural(page);
  await untilOfflineReady(page);
  await context.setOffline(true);
  await page.reload();
  await expect(page.locator('.recipient-place')).toContainText('Bolesławiec');
  await expect(page.getByText('Podpowiedzi urzędów dla tego miejsca wymagają połączenia z internetem.')).toBeVisible();
  await page.getByRole('button', { name: 'Zmień gminę', exact: true }).click();
  await page.getByLabel('Nazwa gminy').fill('Bolesławiec');
  await expect(page.getByRole('button', { name: 'Bolesławiec gmina miejska · powiat bolesławiecki · woj. dolnośląskie', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Zamknij wyszukiwanie', exact: true }).click();
  await page.locator('.screen-foot .primary').click();
  expect((await localReport(page)).noticePreparation?.gminaCorrection?.jstType).toBe('GW');
});
