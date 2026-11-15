import { openNoticeRow, otherWays } from './stages.ts';
import { test, expect } from '@playwright/test';
import { finishFromWhen, reportPost, stubReportServer } from './stages.ts';
import { readFile } from 'node:fs/promises';
import { untilOfflineReady } from '../helpers/offline.ts';
import { demoRecipient, expectedRecipient, expectedSubject, expectDemoDestination } from './demo.ts';

const points = JSON.parse(await readFile(new URL('../../data/fixtures/acceptance.json', import.meta.url), 'utf8'));

// No journey here reads server state, so uploads are answered in the page and spend no daily Reports.
test.beforeEach(async ({ page }) => { await stubReportServer(page); });

test('offline Reporter picks police and PSŁ by name and opens their Notices', async ({ page, context }) => {
  await context.setGeolocation({ latitude: points.edge.point.lat, longitude: points.edge.point.lon, accuracy: 8 });
  await context.grantPermissions(['geolocation', 'clipboard-read', 'clipboard-write']);
  await page.goto('/');
  await untilOfflineReady(page);
  await context.setOffline(true);
  await page.reload();
  await page.getByRole('button', { name: 'Człowiek z bronią', exact: true }).click();
  await finishFromWhen(page, false);
  await page.getByRole('button', { name: 'Zapisz zgłoszenie' }).click();
  await page.getByRole('button', { name: 'Przygotuj powiadomienie' }).click();
  await expect(page.getByText('Podpowiedzi urzędów dla tego miejsca wymagają połączenia z internetem.')).toBeVisible();
  await expect(page.locator('.screen-foot .primary')).toHaveText('Dokończę później');
  await expect(page.getByLabel('Nazwa lub miejscowość')).not.toBeVisible();
  await page.getByText('Wybierz jednostkę po nazwie', { exact: true }).click();
  await page.getByLabel('Nazwa lub miejscowość').fill('Monkach');
  await page.getByRole('button', { name: /Komenda Powiatowa Policji w Mońkach/ }).click();
  await page.getByLabel('Rodzaj urzędu').selectOption('psl');
  await page.getByLabel('Nazwa lub miejscowość').fill('podlaskie');
  await page.getByRole('button', { name: /Państwowa Straż Łowiecka - podlaskie/ }).click();
  await page.getByRole('button', { name: 'Dalej: podpis' }).click();
  await page.getByRole('radio', { name: 'Bez podpisu' }).check();
  await page.getByRole('button', { name: 'Przygotuj powiadomienia' }).click();
  await openNoticeRow(page, 'Komenda Powiatowa Policji w Mońkach');
  await expect(page.getByRole('heading', { name: 'Komenda Powiatowa Policji w Mońkach' })).toBeVisible();
  await expect(page.locator('p.route-address')).toHaveText(expectedRecipient('komendant.kpp@monki.bk.policja.gov.pl'));
  await expect(page.locator('.notice-subject')).toHaveText(expectedSubject('Informacja o zdarzeniu łowieckim'));
  await expect(page.locator('.notice-body')).toContainText('Ustalenia nie są jeszcze dostępne');
  await expect(page.locator('.notice-body')).toContainText('Państwowa Straż Łowiecka - podlaskie');
  await otherWays(page);
  await page.getByRole('button', { name: 'Kopiuj adres' }).click();
  await expect(page.getByRole('status')).toHaveText('Adres skopiowany.');
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(expectedRecipient('komendant.kpp@monki.bk.policja.gov.pl'));
  expectDemoDestination(await page.locator('.notice-body').textContent() ?? '', ['komendant.kpp@monki.bk.policja.gov.pl']);
  await page.getByRole('button', { name: 'Wszystkie powiadomienia' }).click();
  await openNoticeRow(page, 'Państwowa Straż Łowiecka - podlaskie');
  await expect(page.locator('p.route-address')).toHaveText(expectedRecipient('sekretariatWR@bialystok.uw.gov.pl'));
  await expect(page.locator('.notice-body')).toContainText('Komenda Powiatowa Policji w Mońkach');
});

test('point lookup preselects police and PSŁ but leaves gmina unchecked', async ({ page, context }) => {
  await context.setGeolocation({ latitude: points.edge.point.lat, longitude: points.edge.point.lon, accuracy: 8 });
  await page.goto('/');
  await page.getByRole('button', { name: 'Człowiek z bronią', exact: true }).click();
  await finishFromWhen(page, false);
  await page.getByRole('button', { name: 'Zapisz zgłoszenie' }).click();
  await page.getByRole('button', { name: 'Przygotuj powiadomienie' }).click();
  await expect(page.locator('.recipient-place')).toBeVisible();
  await expect(page.getByLabel(/Komenda Powiatowa Policji w Mońkach/)).toBeChecked();
  await expect(page.getByLabel(/Państwowa Straż Łowiecka - podlaskie/)).toBeChecked();
  await expect(page.getByLabel(/Urząd Miejski w Mońkach/)).not.toBeChecked();
});

test('unknown catalog id falls back to searchable recipient choices', async ({ page, context }) => {
  await context.setGeolocation({ latitude: points.edge.point.lat, longitude: points.edge.point.lon, accuracy: 8 });
  await page.route('**/api/recipients', route => route.fulfill({ status: 200, json: {
    candidates: [{ kind: 'gmina', id: 'unknown-unit', name: 'Unknown gmina', catalog: 'unknown' }],
    ambiguity: { ambiguous: false, roles: [], unresolved: ['police', 'psl'] },
    inside: { nationalPark: false, reserve: false },
    places: { gmina: null, powiat: null, nadlesnictwo: null }
  } }));
  await page.goto('/');
  await page.getByRole('button', { name: 'Człowiek z bronią', exact: true }).click();
  await finishFromWhen(page, false);
  await page.getByRole('button', { name: 'Zapisz zgłoszenie' }).click();
  await page.getByRole('button', { name: 'Przygotuj powiadomienie' }).click();
  await expect(page.getByText('Nie znaleziono właściwych urzędów dla tego miejsca. Możesz wybrać je po nazwie.')).toBeVisible();
  // With nothing suggested the search opens from the button under the sentence (Faza 7/28).
  await page.getByRole('button', { name: 'Wybierz jednostkę po nazwie', exact: true }).click();
  await expect(page.getByLabel('Nazwa lub miejscowość')).toBeVisible();
});

test('directory gap is visible and cannot open an unverified mailbox', async ({ page, context }) => {
  await context.setGeolocation({ latitude: points.edge.point.lat, longitude: points.edge.point.lon, accuracy: 8 });
  await page.goto('/');
  await page.getByRole('button', { name: 'Człowiek z bronią', exact: true }).click();
  await finishFromWhen(page, false);
  await page.getByRole('button', { name: 'Zapisz zgłoszenie' }).click();
  await page.getByRole('button', { name: 'Przygotuj powiadomienie' }).click();
  await page.getByText('Wybierz inną jednostkę po nazwie', { exact: true }).click();
  await page.getByLabel('Rodzaj urzędu').selectOption('psl');
  await page.getByLabel('Nazwa lub miejscowość').fill('małopolskie');
  await page.getByRole('button', { name: /Państwowa Straż Łowiecka - małopolskie/ }).click();
  if (demoRecipient) await expect(page.getByText('Brak potwierdzonego adresu e-mail. Sprawdź stronę urzędu.')).toHaveCount(0);
  else await expect(page.getByText('Brak potwierdzonego adresu e-mail. Sprawdź stronę urzędu.')).toBeVisible();
  await page.getByRole('button', { name: 'Dalej: podpis' }).click();
  await page.getByRole('radio', { name: 'Bez podpisu' }).check();
  await page.getByRole('button', { name: 'Przygotuj powiadomienia' }).click();
  await openNoticeRow(page, 'Państwowa Straż Łowiecka - małopolskie');
  if (demoRecipient) {
    // A directory gap cannot disable the explicitly configured test inbox.
    const mail = page.getByRole('link', { name: 'Otwórz w poczcie' });
    expect(decodeURIComponent(new URL((await mail.getAttribute('href'))!).pathname)).toBe(demoRecipient);
    await otherWays(page);
    await expect(page.getByRole('button', { name: 'Kopiuj adres' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Otwórz stronę urzędu' })).toHaveCount(0);
  } else {
    // Without an address an Unsigned Notice is copied into the authority's own form.
    await expect(page.getByText('Otwórz w poczcie')).toHaveCount(0);
    await expect(page.locator('.screen-foot .primary')).toHaveText('Kopiuj treść');
    await otherWays(page);
    await expect(page.getByRole('button', { name: 'Kopiuj adres' })).toHaveCount(0);
    await expect(page.locator('a[href^="mailto:"]')).toHaveCount(0);
    await expect(page.getByRole('link', { name: 'Otwórz stronę urzędu' })).toBeVisible();
  }
});

test('approximate Incident area sends bounds, proposes its single police unit and leaves uncertain gminy unchecked', async ({ page, context }) => {
  await context.setGeolocation({ latitude: points.edge.point.lat, longitude: points.edge.point.lon, accuracy: 8 });
  const lookups: string[] = [];
  await page.route('**/api/recipients', route => {
    lookups.push(route.request().postData() ?? '');
    return route.fulfill({ status: 200, json: {
      candidates: [
        { kind: 'gmina', id: '2008072', name: 'Urząd Gminy Trzcianne', catalog: 'matched' },
        { kind: 'gmina', id: 'unknown-unit', name: 'Unknown gmina', catalog: 'unknown' },
        { kind: 'police', id: 'c753fb0c-78e2-419d-ad48-d7bf3b5218ac', name: 'Komenda Powiatowa Policji w Mońkach', catalog: 'matched' }
      ], ambiguity: { ambiguous: true, roles: ['gmina'], unresolved: [] },
      provenance: { snapshot_id: 'fixture', directory_version: 'fixture' }
    } });
  });
  await page.goto('/');
  await page.getByRole('button', { name: 'Strzał', exact: true }).click();
  await finishFromWhen(page, false);
  await page.getByRole('button', { name: 'Zapisz zgłoszenie' }).click();
  await page.getByRole('button', { name: 'Przygotuj powiadomienie' }).click();
  await expect(page.getByText('Nie znaleziono części właściwych urzędów dla tego miejsca. Możesz wybrać je po nazwie.')).toBeVisible();
  // One known gmina beside an unknown one: nothing to ask about the place, but the gmina role stays uncertain.
  await expect(page.getByRole('radiogroup')).toHaveCount(0);
  // The gmina role is optional, so its uncertainty needs no separate prompt.
  await expect(page.getByText('Obszar leży na terenie kilku jednostek. Zaznacz, do której chcesz napisać.')).toHaveCount(0);
  const gmina = page.getByLabel(/Urząd Gminy Trzcianne/);
  await expect(gmina).not.toBeChecked();
  await page.locator('summary').filter({ hasText: 'Gmina (do wiadomości):' }).click();
  await gmina.check();
  await expect(gmina).toBeChecked();
  await expect(page.getByLabel(/Komenda Powiatowa Policji w Mońkach/)).toBeChecked();
  await expect(page.getByLabel('Nazwa lub miejscowość')).toBeVisible();
  expect(lookups).toHaveLength(1);
  expect(JSON.parse(lookups[0])).toMatchObject({ type: 'area', bounds: expect.any(Array) });
});

const crossing = {
  candidates: [
    { kind: 'gmina', id: '2008032', name: 'Urząd Gminy Jaświły', catalog: 'matched' },
    { kind: 'gmina', id: '2008063', name: 'Urząd Miejski w Mońkach', catalog: 'matched' },
    { kind: 'police', id: 'c753fb0c-78e2-419d-ad48-d7bf3b5218ac', name: 'Komenda Powiatowa Policji w Mońkach', catalog: 'matched' },
    { kind: 'psl', id: '20', name: 'Państwowa Straż Łowiecka - podlaskie', catalog: 'matched' }
  ], ambiguity: { ambiguous: true, roles: ['gmina'], unresolved: [] },
  provenance: { snapshot_id: 'moniecki-2026-09-25-osm-v1', directory_version: '2026-09-26' }
};

test('home Report gets suggestions from its shared area and never sends the home fix', async ({ page, context }) => {
  const home = points.barn.point;
  await context.setGeolocation({ latitude: home.lat, longitude: home.lon, accuracy: 12 });
  const lookups: string[] = [];
  page.on('request', request => { if (request.url().endsWith('/api/recipients')) lookups.push(request.postData() ?? ''); });
  await page.goto('/');
  await page.getByRole('button', { name: 'Człowiek z bronią', exact: true }).click();
  await finishFromWhen(page, true);
  await page.getByRole('button', { name: 'Zapisz zgłoszenie' }).click();
  await page.getByRole('button', { name: 'Przygotuj powiadomienie' }).click();
  await expect(page.getByRole('heading', { name: 'Proponowane urzędy' })).toBeVisible();
  await expect(page.getByLabel(/Państwowa Straż Łowiecka - podlaskie/)).toBeChecked();
  await expect(page.getByLabel(/Komenda Powiatowa Policji w Mońkach/)).toBeChecked();
  expect(lookups).toHaveLength(1);
  expect(JSON.parse(lookups[0])).toMatchObject({ type: 'area', precise_fix_withheld: 'home_privacy' });
  for (const secret of [String(home.lat), String(home.lon), home.lat.toFixed(5), home.lon.toFixed(5)]) expect(lookups[0]).not.toContain(secret);
});

test('border area asks which gmina it was and the Notice carries the answer with every gmina', async ({ page, context }) => {
  await context.setGeolocation({ latitude: points.edge.point.lat, longitude: points.edge.point.lon, accuracy: 8 });
  await page.route('**/api/recipients', route => route.fulfill({ status: 200, json: crossing }));
  await page.goto('/');
  await page.getByRole('button', { name: 'Strzał', exact: true }).click();
  await finishFromWhen(page, false);
  await page.getByRole('button', { name: 'Zapisz zgłoszenie' }).click();
  await page.getByRole('button', { name: 'Przygotuj powiadomienie' }).click();
  const question = page.getByRole('group', { name: /W której gminie to było\?/ });
  await expect(question.getByRole('radio')).toHaveCount(3);
  await expect(question.getByRole('radio', { name: /Jaświły gmina wiejska · powiat moniecki · woj. podlaskie/ })).not.toBeChecked();
  await expect(page.getByLabel(/Komenda Powiatowa Policji w Mońkach/)).toBeChecked();
  await expect(page.getByLabel(/Urząd Gminy Jaświły/)).not.toBeChecked();
  await expect(page.getByRole('button', { name: 'Dalej: podpis' })).toBeDisabled();
  await expect(page.getByText('Odpowiedz, w której gminie to było.').filter({ visible: true })).toBeVisible();
  await page.getByText('Źródła urzędów', { exact: true }).click();
  await expect(page.getByText('Granice jednostek według migawki danych moniecki-2026-09-25-osm-v1, katalog urzędów z 2026-09-26.')).toBeVisible();
  await question.getByRole('radio', { name: /^Jaświły/ }).check();
  await page.getByLabel(/Państwowa Straż Łowiecka - podlaskie/).uncheck();
  await page.getByRole('button', { name: 'Dalej: podpis' }).click();
  await page.getByRole('radio', { name: 'Bez podpisu' }).check();
  await page.getByRole('button', { name: 'Przygotuj powiadomienia' }).click();
  await openNoticeRow(page, 'Komenda Powiatowa Policji w Mońkach');
  await expect(page.locator('.notice-body')).toContainText(
    'Gmina: Jaświły, wskazana przez zgłaszającego (obszar zdarzenia obejmuje gminy: Jaświły, Mońki). Powiat: powiat moniecki. Nadleśnictwo: nie ustalono.');
});

test('keyboard search finds Łódź and Warszawa, announces counts and chooses and clears a unit', async ({ page, context }) => {
  await context.setGeolocation({ latitude: points.edge.point.lat, longitude: points.edge.point.lon, accuracy: 8 });
  await page.goto('/');
  await page.getByRole('button', { name: 'Człowiek z bronią', exact: true }).click();
  await finishFromWhen(page, false);
  await page.getByRole('button', { name: 'Zapisz zgłoszenie' }).click();
  await page.getByRole('button', { name: 'Przygotuj powiadomienie' }).click();
  await page.getByText('Wybierz inną jednostkę po nazwie', { exact: true }).click();
  await page.getByLabel('Rodzaj urzędu').selectOption('gmina');
  const search = page.getByLabel('Nazwa lub miejscowość');
  const count = page.locator('#recipient-result-count');
  await expect(count).toHaveText('Wpisz co najmniej dwie litery.');
  await expect(count).toHaveAttribute('role', 'status');
  await search.fill('lodz');
  const results = page.locator('.recipient-result');
  await expect(results.first()).toContainText('Urząd Miasta Łodzi');
  await expect(results.first()).toContainText('miasto na prawach powiatu · powiat Łódź · woj. łódzkie');
  await expect(count).toHaveText(/^Znaleziono: \d+\.$/);
  await search.fill('łódź');
  await expect(results.first()).toContainText('Urząd Miasta Łodzi');
  await search.fill('Warszawa');
  await expect(results.first()).toContainText('Urząd Miasta Stołecznego Warszawy');
  await search.fill('Bolesławiec');
  await expect(results.nth(0)).toContainText('gmina wiejska · powiat bolesławiecki · woj. dolnośląskie');
  await expect(results.nth(1)).toContainText('gmina miejska · powiat bolesławiecki · woj. dolnośląskie');
  await expect(results.nth(2)).toContainText('gmina miejsko-wiejska · powiat wieruszowski · woj. łódzkie');
  await search.fill('urząd');
  await expect(results).toHaveCount(25);
  await expect(count).toHaveText(/^Znaleziono: \d+\. Pokazuję pierwsze 25\. Wpisz więcej liter, żeby zawęzić\.$/);
  await search.fill('zzqq');
  await expect(results).toHaveCount(0);
  await expect(count).toHaveText('Nie znaleziono jednostki. Spróbuj innej nazwy.');

  await search.fill('lodz');
  await search.press('Tab');
  const lodz = results.first();
  await expect(lodz).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(lodz).toHaveAttribute('aria-pressed', 'true');
  await expect(lodz).toContainText('Wybrano. Naciśnij, aby usunąć.');
  const chosen = page.getByRole('group', { name: 'Wybrane po nazwie' }).getByLabel(/Urząd Miasta Łodzi/);
  await expect(chosen).toBeChecked();
  await page.keyboard.press('Enter');
  await expect(lodz).toHaveAttribute('aria-pressed', 'false');
  await expect(chosen).not.toBeChecked();
});

test('an area under two police units proposes neither and asks the Reporter to tick one', async ({ page, context }) => {
  await context.setGeolocation({ latitude: points.edge.point.lat, longitude: points.edge.point.lon, accuracy: 8 });
  await page.route('**/api/recipients', route => route.fulfill({ status: 200, json: { ...crossing, candidates: [...crossing.candidates,
    { kind: 'police', id: '74ff4309-57cc-4769-8194-8c35a3057a6e', name: 'Komenda Miejska Policji w Białymstoku', catalog: 'matched' }] } }));
  await page.goto('/');
  await page.getByRole('button', { name: 'Strzał', exact: true }).click();
  await finishFromWhen(page, false);
  await page.getByRole('button', { name: 'Zapisz zgłoszenie' }).click();
  await page.getByRole('button', { name: 'Przygotuj powiadomienie' }).click();
  const police = page.getByRole('group', { name: 'Policja' });
  await expect(police.getByText('Obszar leży na terenie kilku jednostek. Zaznacz, do której chcesz napisać.')).toBeVisible();
  await expect(police.getByRole('checkbox')).toHaveCount(2);
  for (const box of await police.getByRole('checkbox').all()) await expect(box).not.toBeChecked();
  await expect(page.getByLabel(/Państwowa Straż Łowiecka - podlaskie/)).toBeChecked();
});

test.describe('without a service worker', () => {
  test.use({ serviceWorkers: 'block' });

  test('capture saves before the catalog loads, and a catalog that fails to load says so and retries', async ({ page, context }) => {
    await context.setGeolocation({ latitude: points.edge.point.lat, longitude: points.edge.point.lon, accuracy: 8 });
    await page.route('**/api/reports', route => route.fulfill({ status: 201, contentType: 'application/json', body: '{"id":"accepted"}' }));
    let catalogRequests = 0;
    let blockCatalog = true;
    // The directory files are the only JSON build assets.
    await page.route('**/_app/immutable/assets/*.json', route => {
      catalogRequests++;
      return blockCatalog ? route.abort() : route.continue();
    });
    await page.goto('/');
    await page.getByRole('button', { name: 'Człowiek z bronią', exact: true }).click();
    await finishFromWhen(page, false);
    await page.getByRole('button', { name: 'Zapisz zgłoszenie' }).click();
    await expect(page.getByText('Zapisano', { exact: false }).first()).toBeVisible();
    expect(catalogRequests).toBe(0);
    await page.getByRole('button', { name: 'Przygotuj powiadomienie' }).click();
    await expect(page.getByRole('alert')).toContainText('Nie udało się wczytać katalogu urzędów.');
    await expect(page.getByRole('alert')).toContainText('Zgłoszenie jest zapisane.');
    expect(catalogRequests).toBeGreaterThan(0);
    await expect(page.getByRole('button', { name: 'Dalej: podpis' })).toBeDisabled();
    catalogRequests = 0;
    blockCatalog = false;
    await page.getByRole('button', { name: 'Spróbuj ponownie' }).click();
    await expect(page.getByLabel(/Komenda Powiatowa Policji w Mońkach/)).toBeChecked();
    await expect(page.getByRole('alert')).toHaveCount(0);
    expect(catalogRequests).toBe(4);
  });
});

for (const event of ['Strzał', 'Człowiek z bronią']) {
  test(`offline ${event} can leave recipients and resume after reconnecting`, async ({ page, context }) => {
    await reportPost(page);
    await context.setGeolocation({ latitude: points.edge.point.lat, longitude: points.edge.point.lon, accuracy: 8 });
    await page.goto('/');
    await untilOfflineReady(page);
    await context.setOffline(true);
    await page.getByRole('button', { name: event, exact: true }).click();
    await finishFromWhen(page, false);
    await page.getByRole('button', { name: 'Zapisz zgłoszenie' }).click();
    await expect(page).toHaveURL(/screen=report&/);
    const reportUrl = page.url();
    await page.getByRole('button', { name: 'Przygotuj powiadomienie' }).click();
    await expect(page.getByText('Podpowiedzi urzędów dla tego miejsca wymagają połączenia z internetem.')).toBeVisible();
    await expect(page.locator('.screen-foot .primary')).toHaveText('Dokończę później');
    await expect(page.getByLabel('Nazwa lub miejscowość')).not.toBeVisible();
    await page.getByRole('button', { name: 'Dokończę później' }).click();
    await expect(page).toHaveURL(reportUrl);
    await context.setOffline(false);
    await page.getByRole('button', { name: 'Przygotuj powiadomienie' }).click();
    await expect(page.getByLabel(/Komenda Powiatowa Policji w Mońkach/)).toBeChecked();
  });
}

test('unresolved place is distinct from an outage and retry recovers an outage', async ({ page, context }) => {
  await reportPost(page);
  await context.setGeolocation({ latitude: points.edge.point.lat, longitude: points.edge.point.lon, accuracy: 8 });
  let outage = false;
  await page.route('**/api/recipients', route => route.fulfill(outage
    ? { status: 503, json: { error: 'temporarily_unavailable' } }
    : { status: 200, json: { candidates: [], ambiguity: { ambiguous: false, roles: [], unresolved: ['gmina', 'police', 'psl'] } } }));
  await page.goto('/');
  await page.getByRole('button', { name: 'Człowiek z bronią', exact: true }).click();
  await finishFromWhen(page, false);
  await page.getByRole('button', { name: 'Zapisz zgłoszenie' }).click();
  await page.getByRole('button', { name: 'Przygotuj powiadomienie' }).click();
  await expect(page.getByText('Nie znaleziono właściwych urzędów dla tego miejsca. Możesz wybrać je po nazwie.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Spróbuj ponownie' })).toHaveCount(0);
  await page.getByRole('button', { name: 'Dokończę później' }).click();
  outage = true;
  await page.reload();
  await page.getByRole('button', { name: 'Przygotuj powiadomienie' }).click();
  await expect(page.getByText('Nie udało się pobrać podpowiedzi urzędów. Spróbuj ponownie lub dokończ później.')).toBeVisible();
  await expect(page.locator('.screen-foot .primary')).toHaveText('Dokończę później');
  await expect(page.getByLabel('Nazwa lub miejscowość')).not.toBeVisible();
  outage = false;
  await page.getByRole('button', { name: 'Spróbuj ponownie' }).click();
  await expect(page.getByText('Nie znaleziono właściwych urzędów dla tego miejsca. Możesz wybrać je po nazwie.')).toBeVisible();
});

test('a delayed lookup keeps name search open and preserves its selected unit', async ({ page, context }) => {
  await reportPost(page);
  await context.setGeolocation({ latitude: points.edge.point.lat, longitude: points.edge.point.lon, accuracy: 8 });
  let release!: () => void;
  const responseReady = new Promise<void>(resolve => { release = resolve; });
  await page.route('**/api/recipients', async route => {
    await responseReady;
    await route.fulfill({ status: 200, json: crossing });
  });
  await page.goto('/');
  await page.getByRole('button', { name: 'Człowiek z bronią', exact: true }).click();
  await finishFromWhen(page, false);
  await page.getByRole('button', { name: 'Zapisz zgłoszenie' }).click();
  await page.getByRole('button', { name: 'Przygotuj powiadomienie' }).click();
  await page.getByRole('button', { name: 'Wybierz inną jednostkę po nazwie', exact: true }).click();
  const search = page.getByLabel('Nazwa lub miejscowość');
  await search.fill('Monkach');
  await page.getByRole('button', { name: /Komenda Powiatowa Policji w Mońkach/ }).click();
  release();
  await expect(page.getByText('Sprawdzam właściwe urzędy…')).toHaveCount(0);
  await page.waitForFunction(() => document.getAnimations().length === 0);
  await expect(page.getByRole('group', { name: /W której gminie to było/ })).toBeVisible();
  await expect(search).toBeVisible();
  await expect(search).toHaveValue('Monkach');
  await expect(page.getByLabel(/Komenda Powiatowa Policji w Mońkach/)).toBeChecked();
});

for (const viewport of [{ width: 320, height: 740 }, { width: 844, height: 390 }]) {
  for (const reducedMotion of ['reduce', 'no-preference'] as const) {
    test(`offline name search keeps keyboard focus visible at ${viewport.width} px with doubled text and ${reducedMotion} motion`, async ({ page, context }) => {
      await page.emulateMedia({ reducedMotion });
      await context.setGeolocation({ latitude: points.edge.point.lat, longitude: points.edge.point.lon, accuracy: 8 });
      await page.goto('/');
      await untilOfflineReady(page);
      await context.setOffline(true);
      await page.getByRole('button', { name: 'Człowiek z bronią', exact: true }).click();
      await finishFromWhen(page, false);
      await page.getByRole('button', { name: 'Zapisz zgłoszenie' }).click();
      await page.getByRole('button', { name: 'Przygotuj powiadomienie' }).click();
      await page.setViewportSize(viewport);
      await page.evaluate(() => document.documentElement.style.fontSize = '34px');
      await page.getByRole('button', { name: 'Wybierz jednostkę po nazwie', exact: true }).focus();
      await page.keyboard.press('Enter');
      const input = page.getByLabel('Nazwa lub miejscowość');
      await expect(input).toBeFocused();
      await expect.poll(() => input.evaluate(node => {
        const field = node.getBoundingClientRect();
        const body = document.querySelector('.screen-body')!.getBoundingClientRect();
        return field.top >= body.top - 1 && field.bottom <= body.bottom + 1;
      })).toBe(true);
    });
  }
}

// Faza 7/28: outside coverage the way to choose by name is on the first screen. The Hel point lies
// outside the fixture's jurisdiction data, so the lookup suggests nothing. Before the fix the open
// search started 1.3 panes down at 390x844 and 2.6 at 844x390.
for (const viewport of [{ width: 390, height: 844 }, { width: 844, height: 390 }]) {
  test(`outside coverage the name search opener is in the first pane at ${viewport.width}x${viewport.height}`, async ({ page, context }) => {
    // The private demo's test-mail notice sits above the recipients on purpose.
    test.skip(!!demoRecipient, 'private demo notice takes the first pane');
    await context.setGeolocation({ latitude: 54.6, longitude: 18.8, accuracy: 8 });
    await page.setViewportSize(viewport);
    await page.goto('/');
    await page.getByRole('button', { name: 'Człowiek z bronią', exact: true }).click();
    await finishFromWhen(page, false);
    await page.getByRole('button', { name: 'Zapisz zgłoszenie' }).click();
    await page.getByRole('button', { name: 'Przygotuj powiadomienie' }).click();
    const status = page.getByText('Nie znaleziono właściwych urzędów dla tego miejsca. Możesz wybrać je po nazwie.');
    await expect(status).toBeVisible();
    await page.waitForFunction(() => document.getAnimations().every(animation => animation.playState !== 'running'));
    const where = await page.evaluate(() => {
      const body = document.querySelector('.screen-body')!;
      const pane = body.getBoundingClientRect();
      const opener = [...document.querySelectorAll('button')].find(button => button.textContent?.trim() === 'Wybierz jednostkę po nazwie');
      const search = document.querySelector('.recipient-search-panel');
      const panes = (element: Element | null | undefined) => element ? +((element.getBoundingClientRect().top - pane.top) / pane.height).toFixed(2) : null;
      const footer = document.querySelector('.screen-foot')!.getBoundingClientRect();
      return { scrollTop: body.scrollTop, pane: Math.round(pane.height), opener: opener ? { top: opener.getBoundingClientRect().top, bottom: opener.getBoundingClientRect().bottom } : null,
        paneTop: pane.top, paneBottom: Math.min(pane.bottom, footer.top), openerPanes: panes(opener), searchPanes: panes(search) };
    });
    test.info().annotations.push({ type: 'first pane', description: JSON.stringify(where) });
    expect(where.scrollTop).toBe(0);
    expect(where.opener, `no opener; the open search starts ${where.searchPanes} panes down`).not.toBeNull();
    // Whole, not a sliver: the first try at 844x390 left 4 px of it above the footer.
    expect(where.opener!.top).toBeGreaterThanOrEqual(where.paneTop);
    expect(where.opener!.bottom).toBeLessThanOrEqual(where.paneBottom + 0.5);
    // From the sentence, Tab reaches the opener in at most three presses.
    await status.click();
    let presses = 0;
    const opener = page.getByRole('button', { name: 'Wybierz jednostkę po nazwie', exact: true });
    while (presses < 3 && !await opener.evaluate(node => node === document.activeElement)) { await page.keyboard.press('Tab'); presses++; }
    await expect(opener).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(page.getByLabel('Nazwa lub miejscowość')).toBeFocused();
    await expect(page.getByLabel('Rodzaj urzędu')).toBeVisible();
  });
}

// Faza 7/28 review: the name search must outlive the lookup state that placed it.
async function outsideCoverage(page: import('@playwright/test').Page, context: import('@playwright/test').BrowserContext) {
  await context.setGeolocation({ latitude: 54.6, longitude: 18.8, accuracy: 8 });
  await page.goto('/');
  await untilOfflineReady(page);
  await page.getByRole('button', { name: 'Człowiek z bronią', exact: true }).click();
  await finishFromWhen(page, false);
  await page.getByRole('button', { name: 'Zapisz zgłoszenie' }).click();
  await page.getByRole('button', { name: 'Przygotuj powiadomienie' }).click();
  await expect(page.getByText('Nie znaleziono właściwych urzędów dla tego miejsca. Możesz wybrać je po nazwie.')).toBeVisible();
}

test('losing the connection while typing a name keeps the open search, its text and focus', async ({ page, context }) => {
  await outsideCoverage(page, context);
  await page.getByRole('button', { name: 'Wybierz jednostkę po nazwie', exact: true }).click();
  const input = page.getByLabel('Nazwa lub miejscowość');
  // ASCII keys: Playwright types "ń" with insertText, which after a programmatic focus leaves the caret
  // at 0 on d7ace03 as well ("kMoń"); the search folds diacritics, so "Monk" finds Mońki.
  await input.pressSequentially('Monk');
  await context.setOffline(true);
  await expect(page.getByText('Podpowiedzi urzędów dla tego miejsca wymagają połączenia z internetem.')).toBeVisible();
  await page.waitForFunction(() => document.getAnimations().every(animation => animation.playState !== 'running'));
  await expect(input).toBeVisible();
  await expect(input).toHaveValue('Monk');
  await expect(input).toBeFocused();
  // The catalogue on the phone still answers.
  await input.pressSequentially('ach');
  await expect(page.getByRole('button', { name: /Komenda Powiatowa Policji w Mońkach/ })).toBeVisible();
  await context.setOffline(false);
});

test('after a no-suggestion result, going offline and a failed retry both still offer name search', async ({ page, context }) => {
  await outsideCoverage(page, context);
  const opener = page.getByRole('button', { name: 'Wybierz jednostkę po nazwie', exact: true });
  await context.setOffline(true);
  await expect(page.getByText('Podpowiedzi urzędów dla tego miejsca wymagają połączenia z internetem.')).toBeVisible();
  await expect(opener).toBeVisible();
  await context.setOffline(false);
  await expect(page.getByText('Nie znaleziono właściwych urzędów dla tego miejsca. Możesz wybrać je po nazwie.')).toBeVisible();
  await expect(opener).toBeVisible();
  // The same Report again, and this time the lookup fails.
  await page.route('**/api/recipients', route => route.fulfill({ status: 503, json: { error: 'temporarily_unavailable' } }));
  await page.getByRole('button', { name: 'Dokończę później' }).click();
  await page.getByRole('button', { name: 'Przygotuj powiadomienie' }).click();
  await expect(page.getByText('Nie udało się pobrać podpowiedzi urzędów. Spróbuj ponownie lub dokończ później.')).toBeVisible();
  await expect(opener).toBeVisible();
  await page.getByRole('button', { name: 'Spróbuj ponownie' }).click();
  await expect(page.getByText('Nie udało się pobrać podpowiedzi urzędów. Spróbuj ponownie lub dokończ później.')).toBeVisible();
  await opener.click();
  await expect(page.getByLabel('Nazwa lub miejscowość')).toBeFocused();
});
