import { openNoticeRow } from './stages.ts';
import { test, expect, type Page } from '@playwright/test';
import { fileAsPdf, finishFromWhen, settled } from './stages.ts';
import { readFile } from 'node:fs/promises';
import { untilOfflineReady } from '../helpers/offline.ts';
import { execFileSync } from 'node:child_process';
import { demoRecipient, expectedRecipient, expectedSubject, expectDemoDestination, openLegalDraft, pdfConfirmation, pdfSwitch } from './demo.ts';

const points = JSON.parse(await readFile(new URL('../../data/fixtures/acceptance.json', import.meta.url), 'utf8'));
const policeAddress = 'komendant.kpp@monki.bk.policja.gov.pl';

async function offlineReport(page: Page, note = '') {
  await page.goto('/');
  await untilOfflineReady(page);
  await page.context().setOffline(true);
  await page.reload();
  await page.getByRole('button', { name: 'Człowiek z bronią', exact: true }).click();
  await finishFromWhen(page, false);
  if (note) {
    await page.locator('summary', { hasText: 'Notatka' }).click();
    await page.getByLabel('Co jeszcze chcesz przekazać?').fill(note);
  }
  await page.getByRole('button', { name: 'Zapisz zgłoszenie' }).click();
}

const other = (page: Page) => page.locator('summary', { hasText: 'Inne sposoby przekazania' });
async function openOutcome(page: Page) {
  const summary = page.locator('summary', { hasText: 'Wynik zgłoszony przez Ciebie' });
  if (!await summary.locator('xpath=..').evaluate(details => (details as HTMLDetailsElement).open)) await summary.click();
}

async function pickPoliceAndPsl(page: Page) {
  await page.getByRole('button', { name: 'Przygotuj powiadomienie' }).click();
  await page.getByRole('button', { name: 'Wybierz jednostkę po nazwie', exact: true }).click();
  await page.getByLabel('Nazwa lub miejscowość').fill('Monkach');
  await page.getByRole('button', { name: /Komenda Powiatowa Policji w Mońkach/ }).click();
  await page.getByLabel('Rodzaj urzędu').selectOption('psl');
  await page.getByLabel('Nazwa lub miejscowość').fill('podlaskie');
  await page.getByRole('button', { name: /Państwowa Straż Łowiecka - podlaskie/ }).click();
  await page.getByRole('button', { name: 'Dalej: podpis' }).click();
}

test('Signed PDF exports offline with Polish text and only Reporter confirmation enables outcomes', async ({ page, context }, testInfo) => {
  await context.setGeolocation({ latitude: points.edge.point.lat, longitude: points.edge.point.lon, accuracy: 8 });
  const requests: string[] = [];
  const events: Record<string, string>[] = [];
  context.on('request', request => {
    if (!request.url().startsWith('http')) return;
    requests.push(`${request.url()} ${request.postData() ?? ''}`);
    if (request.url().endsWith('/events')) events.push(request.postDataJSON());
  });
  await offlineReport(page, 'Łąka № 12, żółć.\n'.repeat(25));
  await pickPoliceAndPsl(page);
  await page.getByRole('radio', { name: 'Z podpisem' }).check();
  await page.getByLabel('Imię i nazwisko').fill('Łucja Żółkiewska / Олена Коваль');
  await page.getByLabel('Adres do korespondencji').fill('ul. Leśna 1, 19-100 Mońki');
  await page.getByLabel('Telefon (opcjonalnie)').fill('600100201');
  await page.getByRole('button', { name: 'Przygotuj powiadomienia' }).click();
  await openNoticeRow(page, 'Komenda Powiatowa Policji w Mońkach');
  // The police unit has a verified email, so mail is the route and the PDF is one tap away.
  await expect(page.getByRole('link', { name: 'Otwórz w poczcie' })).toBeVisible();
  await page.getByRole('button', { name: pdfSwitch }).first().click();
  await expect(page.getByText('PDF zostaje na tym telefonie.', { exact: false })).toBeVisible();
  await expect(page.getByText('Wpisane dane nie są podpisem elektronicznym.', { exact: false })).toBeVisible();
  // On the PDF route the PDF preview is the Notice text.
  const body = await page.locator('.pdf-body').textContent();
  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Pobierz PDF' }).click();
  const download = await downloadPromise;
  if (demoRecipient) expect(download.suggestedFilename()).toBe('test-powiadomienie.pdf');
  else expect(download.suggestedFilename()).toMatch(/^powiadomienie-.*\.pdf$/);
  const file = await download.path();
  await download.saveAs(testInfo.outputPath('signed-notice.pdf'));
  const text = execFileSync('pdftotext', [file!, '-'], { encoding: 'utf8' });
  const normalized = (value: string) => value.replace(/\s+/g, ' ').trim();
  expect(normalized(text)).toContain(normalized(body!));
  expect(text).toContain('Komenda Powiatowa Policji w Mońkach');
  expect(text).toContain('Łucja Żółkiewska / Олена Коваль');
  expect(text).toContain('№ 12');
  expect(text).toContain('600100201');
  expectDemoDestination(text, [policeAddress, 'sekretariatWR@bialystok.uw.gov.pl']);
  expect(execFileSync('pdfinfo', [file!], { encoding: 'utf8' })).toMatch(/Pages:\s+[2-9]/);
  await expect(page.locator('main .badge')).toHaveCount(0);
  // A saved PDF asks what happened; it never confirms filing by itself.
  await expect(page.getByRole('heading', { name: 'Udało się wysłać?' })).toBeFocused();
  await expect(page.getByRole('heading', { name: 'Udało się wysłać?' })).toBeInViewport();
  if (demoRecipient) {
    await expect(page.getByRole('link', { name: 'Otwórz instrukcję ePUAP' })).toHaveCount(0);
    await expect(page.getByRole('link', { name: 'Otwórz e-Doręczenia' })).toHaveCount(0);
    await expect(page.locator('main')).toContainText('Nie korzystaj z serwisów urzędowych.');
  } else {
    await page.getByText('Jak złożyć przez ePUAP lub e-Doręczenia?', { exact: true }).click();
    await expect(page.getByRole('link', { name: 'Otwórz instrukcję ePUAP' })).toHaveAttribute('href', 'https://www.gov.pl/web/gov/wyslij-pismo-ogolne');
    await expect(page.getByRole('link', { name: 'Otwórz e-Doręczenia' })).toHaveAttribute('href', 'https://www.gov.pl/web/e-doreczenia');
  }
  await expect(page.locator('summary', { hasText: 'Wynik zgłoszony przez Ciebie' })).toHaveCount(0);
  await page.reload();
  await page.getByRole('button', { name: 'Moje zapisy' }).click();
  await page.getByRole('button', { name: /^Człowiek z bronią, / }).click();
  await page.getByRole('button', { name: /Powiadomienia do urzędów/ }).click();
  await openNoticeRow(page, 'Komenda Powiatowa Policji w Mońkach');
  // Filing can be confirmed after returning, without entering identity again.
  await page.getByRole('button', { name: pdfConfirmation, exact: true }).click();
  await expect(page.getByRole('button', { name: 'Następne: Państwowa Straż Łowiecka' })).toBeVisible();
  await openOutcome(page);
  await page.getByLabel('Odpowiedź urzędu').selectOption('reply');
  await page.getByLabel('Dzień wyniku').fill('2026-09-24');
  await page.getByRole('button', { name: 'Zapisz wynik' }).click();
  await expect(page.locator('.outcome-section li')).toHaveCount(1);
  await context.setOffline(false);
  await expect.poll(() => events.length, { timeout: 20_000 }).toBe(4);
  expect(events.map(event => event.kind).sort()).toEqual(['confirmed_by_reporter', 'notice_composed', 'notice_composed', 'outcome_reported']);
  // The Report itself synced, so the requests checked here include its upload.
  expect(requests.some(request => request.includes('/api/reports'))).toBe(true);
  for (const request of requests) {
    expect(request).not.toMatch(/Żółkiewska|Leśna|600100201|Łąka|%PDF|JVBER/);
  }
});

test('signature choice says the recipient sees identity and our server does not, in Polish and English', async ({ page, context }) => {
  await context.setGeolocation({ latitude: points.edge.point.lat, longitude: points.edge.point.lon, accuracy: 8 });
  await offlineReport(page);
  await pickPoliceAndPsl(page);
  // Said before the choice, as the signed option's description, and said once.
  const signed = page.getByRole('radio', { name: 'Z podpisem' });
  await expect(signed).toHaveAccessibleDescription('Odbiorca zobaczy Twoje imię, nazwisko, adres do korespondencji i telefon, jeśli go podasz. Nie wysyłamy tych danych na nasz serwer.');
  await signed.check();
  await expect(page.locator('main')).not.toContainText('Dane zostają na tym telefonie');
  await expect(page.locator('main').getByText(/serwer/)).toHaveCount(1);
  await page.getByRole('button', { name: 'Menu' }).click();
  await page.getByRole('button', { name: 'English' }).click();
  await page.goBack();
  const signedEn = page.getByRole('radio', { name: 'Signed', exact: true });
  await expect(signedEn).toHaveAccessibleDescription('The recipient will see your name, correspondence address and phone number, if you give one. We do not send them to our server.');
  await expect(page.locator('main')).not.toContainText('Details stay on this device');
  await expect(page.locator('main').getByText(/server/)).toHaveCount(1);
});

test('privacy policy draws the same line for Signed Notice identity', async ({ page }) => {
  await page.goto('/legal/privacy/v1/');
  await openLegalDraft(page);
  const item = page.getByRole('listitem').filter({ hasText: 'z powiadomienia podpisanego' });
  await expect(item).toHaveText('twoje dane z powiadomienia podpisanego. Imię, nazwisko i adres zostają w telefonie i idą tylko w powiadomieniu, które wysyłasz,');
});

test('unsupported PDF characters keep the full Notice available instead of exporting missing text', async ({ page, context }) => {
  await context.setGeolocation({ latitude: points.edge.point.lat, longitude: points.edge.point.lon, accuracy: 8 });
  await offlineReport(page, 'Notatka ze znakiem 林.');
  await pickPoliceAndPsl(page);
  await page.getByRole('radio', { name: 'Z podpisem' }).check();
  await page.getByLabel('Imię i nazwisko').fill('Jan Kowalski');
  await page.getByLabel('Adres do korespondencji').fill('Leśna 1');
  await page.getByRole('button', { name: 'Przygotuj powiadomienia' }).click();
  await openNoticeRow(page);
  const downloads: string[] = [];
  page.on('download', download => downloads.push(download.suggestedFilename()));
  await page.getByRole('button', { name: pdfSwitch }).first().click();
  await page.getByRole('button', { name: 'Pobierz PDF' }).click();
  await expect(page.getByRole('alert')).toContainText('Skopiuj treść i przygotuj plik w edytorze dokumentów.');
  await expect(page.getByRole('heading', { name: 'Udało się wysłać?' })).toHaveCount(0);
  await expect(page.locator('.pdf-body')).toContainText('Notatka ze znakiem 林.');
  await expect(page.locator('main .badge')).toHaveCount(0);
  expect(downloads).toEqual([]);
});

test('Reporter flags one Notice address after a confirmed handoff without sharing Notice data', async ({ page, context }) => {
  await context.setGeolocation({ latitude: points.edge.point.lat, longitude: points.edge.point.lon, accuracy: 8 });
  const flags: unknown[] = [];
  await page.route('**/api/recipient-address-flags', async route => {
    flags.push(route.request().postDataJSON());
    await route.fulfill({ status: 201, contentType: 'application/json', body: '{"status":"recorded"}' });
  });
  await offlineReport(page);
  await pickPoliceAndPsl(page);
  await page.getByRole('radio', { name: 'Bez podpisu' }).check();
  await page.getByRole('button', { name: 'Przygotuj powiadomienia' }).click();
  await openNoticeRow(page, 'Komenda Powiatowa Policji w Mońkach');
  await expect(page.getByRole('button', { name: 'Zgłoś adres do sprawdzenia' })).toHaveCount(0);
  await page.getByRole('link', { name: 'Otwórz w poczcie' }).click();
  await expect(page.getByRole('button', { name: 'Zgłoś adres do sprawdzenia' })).toHaveCount(0);
  await page.getByRole('button', { name: 'Potwierdzam przekazanie' }).click();
  await context.setOffline(false);
  if (demoRecipient) {
    await expect(page.locator('summary', { hasText: 'Adres urzędu nie działa?' })).toHaveCount(0);
    expect(flags).toEqual([]);
  } else {
    await page.locator('summary', { hasText: 'Adres urzędu nie działa?' }).click();
    await page.getByRole('button', { name: 'Zgłoś adres do sprawdzenia' }).click();
    await expect(page.getByRole('button', { name: 'Adres zgłoszony do sprawdzenia' })).toBeDisabled();
    expect(flags).toEqual([{ kind: 'police', unit_id: 'c753fb0c-78e2-419d-ad48-d7bf3b5218ac' }]);
  }
});

test('Signed Notice composed before sync opens a mailto with D2 and its events sync without identity', async ({ page, context }) => {
  await context.setGeolocation({ latitude: points.edge.point.lat, longitude: points.edge.point.lon, accuracy: 8 });
  await context.grantPermissions(['geolocation', 'clipboard-read', 'clipboard-write']);
  const requests: string[] = [];
  const events: Record<string, string>[] = [];
  context.on('request', request => {
    // The mailto: handoff goes to the local mail client and is the one place Signed details belong.
    if (!request.url().startsWith('http')) return;
    requests.push(`${request.url()} ${JSON.stringify(request.headers())} ${request.postData() ?? ''}`);
    if (request.url().endsWith('/events')) events.push(request.postDataJSON());
  });
  await offlineReport(page);
  await expect(page.getByText('Powiadomienie jest opcjonalne. Nie musisz czekać na pomiary.', { exact: true })).toBeVisible();
  await pickPoliceAndPsl(page);

  await expect(page.getByRole('radio', { name: 'Z podpisem' })).not.toBeChecked();
  await expect(page.getByRole('radio', { name: 'Bez podpisu' })).not.toBeChecked();
  await expect(page.getByRole('button', { name: 'Przygotuj powiadomienia' })).toBeDisabled();
  await expect(page.getByText('Pomiary nie są jeszcze dostępne.', { exact: false })).toBeVisible();
  await expect(page.getByText('Odbiorca zobaczy adres Twojej poczty.', { exact: false })).toBeVisible();
  await page.getByRole('radio', { name: 'Z podpisem' }).check();
  await page.getByLabel('Imię i nazwisko').fill('Jan Kowalski');
  await page.getByLabel('Adres do korespondencji').fill('ul. Leśna 1, 19-100 Mońki');
  await page.getByLabel('Telefon (opcjonalnie)').fill('600100200');
  await page.getByRole('button', { name: 'Przygotuj powiadomienia' }).click();

  await expect(page.getByRole('heading', { name: 'Komenda Powiatowa Policji w Mońkach' })).toBeVisible();
  await page.getByRole('button', { name: 'Wszystkie powiadomienia' }).click();
  const rows = page.locator('.rows .row');
  await expect(rows).toHaveCount(2);
  // A Notice nothing has happened to yet carries no state.
  await expect(rows.first().locator('.badge')).toHaveCount(0);
  await rows.filter({ hasText: 'Komenda Powiatowa Policji w Mońkach' }).click();
  await expect(page.getByRole('heading', { name: 'Komenda Powiatowa Policji w Mońkach' })).toBeVisible();

  const handoff = page.getByRole('link', { name: 'Otwórz w poczcie' });
  const href = await handoff.getAttribute('href');
  const url = new URL(href!);
  expect(url.protocol).toBe('mailto:');
  expect(decodeURIComponent(url.pathname)).toBe(expectedRecipient(policeAddress));
  expect(url.searchParams.get('subject')).toBe(expectedSubject('Zawiadomienie o podejrzeniu popełnienia przestępstwa łowieckiego'));
  if (!demoRecipient) expect(url.searchParams.has('body')).toBe(true);
  const composedBody = await page.locator('.notice-body').textContent();
  const body = (url.searchParams.get('body') ?? composedBody!).replace(/\r\n/g, '\n');
  expect(body).toBe(composedBody);
  expectDemoDestination(decodeURIComponent(href!), [policeAddress]);
  expectDemoDestination(body, [policeAddress, 'sekretariatWR@bialystok.uw.gov.pl']);
  expect(body).toContain('Ustalenia nie są jeszcze dostępne');
  expect(body).toContain('Pozostali adresaci tego powiadomienia: Państwowa Straż Łowiecka - podlaskie.');
  expect(body).toContain('Jan Kowalski\nAdres do korespondencji: ul. Leśna 1, 19-100 Mońki\nTelefon: 600100200');
  expect(href!.length).toBeLessThanOrEqual(2000);

  await other(page).click();
  await page.getByRole('button', { name: 'Kopiuj treść' }).click();
  await expect(page.getByRole('status')).toHaveText('Treść skopiowana.');
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(body.replace(/\r\n/g, '\n'));
  await page.getByRole('button', { name: 'Kopiuj adres' }).click();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(expectedRecipient(policeAddress));

  await handoff.click();
  await expect(page.getByRole('heading', { name: 'Udało się wysłać?' })).toBeVisible();
  await expect(page.locator('main .badge')).toHaveText('Otwarto pocztę');
  await page.getByRole('button', { name: 'Potwierdzam przekazanie' }).click();
  await expect(page.getByRole('status')).toHaveText('Zapisano Twoje potwierdzenie. To nie jest potwierdzenie doręczenia.');
  await expect(page.locator('main .badge')).toHaveText('Przekazanie potwierdzone przez Ciebie');
  await expect(page.getByRole('heading', { name: 'Udało się wysłać?' })).toHaveCount(0);
  // After a confirmed handoff mail is no longer the footer action; the next authority is.
  await expect(page.locator('.screen-foot')).not.toContainText('Otwórz w poczcie');
  await expect(page.locator('.screen-foot .primary')).toHaveText('Następne: Państwowa Straż Łowiecka');
  await expect(page.locator('main .badge')).not.toContainText(/wysłan|doręczon|dostarczon/i);

  await page.getByRole('button', { name: 'Moje zapisy', exact: true }).click();
  await page.getByRole('button', { name: /^Człowiek z bronią, / }).click();
  await expect(page.locator('.report-notices')).toContainText('Przekazanie potwierdzone przez Ciebie');
  const stored = await page.evaluate(() => new Promise<string>(resolve => {
    const open = indexedDB.open('bor-czuwa');
    open.onsuccess = () => {
      const all = open.result.transaction('reports').objectStore('reports').getAll();
      all.onsuccess = () => { resolve(JSON.stringify(all.result)); open.result.close(); };
    };
  }));
  expect(stored).not.toContain('Kowalski');
  expect(events).toHaveLength(0);

  await context.setOffline(false);
  await expect.poll(() => events.length, { timeout: 20_000 }).toBe(4);
  expect(events.map(event => `${event.kind}:${event.recipient_kind}`).sort()).toEqual([
    'confirmed_by_reporter:police', 'handed_to_mail_client:police', 'notice_composed:police', 'notice_composed:psl'
  ]);
  for (const event of events) {
    expect(event.template_version).toBe('placeholder-2026-09-25');
    expect(event.directory_version).toBe('2026-09-26');
  }
  expect(new Set(events.filter(event => event.recipient_kind === 'police').map(event => event.unit_id)).size).toBe(1);
  expect(requests.some(line => line.includes('/api/reports'))).toBe(true);
  for (const line of requests) {
    expect(line).not.toContain('Kowalski');
    expect(line).not.toContain('Le%C5%9Bna');
    expect(line).not.toContain('Leśna');
    expect(line).not.toContain('600100200');
  }
});

test('a long web Notice copies the full body before mail and focuses the handoff question', async ({ page, context }) => {
  await context.setGeolocation({ latitude: points.edge.point.lat, longitude: points.edge.point.lon, accuracy: 8 });
  await context.grantPermissions(['geolocation', 'clipboard-read', 'clipboard-write']);
  await offlineReport(page, 'Łąka za stodołą, słychać było psy i wołanie. '.repeat(11).slice(0, 500));
  await pickPoliceAndPsl(page);
  await page.getByRole('radio', { name: 'Bez podpisu' }).check();
  await page.getByRole('button', { name: 'Przygotuj powiadomienia' }).click();
  await openNoticeRow(page, 'Komenda Powiatowa Policji w Mońkach');
  await page.getByText('Przejrzyj treść powiadomienia', { exact: true }).click();
  const fullBody = await page.locator('.notice-body').textContent();
  const href = await page.getByRole('link', { name: 'Otwórz w poczcie' }).getAttribute('href');
  const url = new URL(href!);
  expect(decodeURIComponent(url.pathname)).toBe(expectedRecipient(policeAddress));
  expect(url.searchParams.get('subject')).toBe(expectedSubject('Informacja o zdarzeniu łowieckim'));
  expectDemoDestination(decodeURIComponent(href!), [policeAddress]);
  expectDemoDestination(fullBody!, [policeAddress]);
  expect(url.searchParams.has('body')).toBe(false);
  const client = await context.newCDPSession(page);
  await client.send('Page.enable');
  const mailOpened = new Promise<string>(resolve => client.on('Page.frameRequestedNavigation', event => {
    if (event.url.startsWith('mailto:')) resolve(event.url);
  }));
  await page.getByRole('link', { name: 'Otwórz w poczcie' }).focus();
  await page.keyboard.press('Enter');
  expect(await mailOpened).toBe(href);
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(fullBody);
  await expect(page.getByRole('status')).toHaveText('Treść jest w schowku. Wklej ją do wiadomości.');
  await expect(page.getByRole('heading', { name: 'Udało się wysłać?' })).toBeFocused();
  await expect(page.getByRole('heading', { name: 'Udało się wysłać?' })).toBeInViewport();
  await expect(page.locator('.notice-body')).toBeVisible();
  await page.getByRole('button', { name: 'Jeszcze nie' }).click();
  await expect(page.getByRole('heading', { name: 'Udało się wysłać?' })).toHaveCount(0);
  await expect(page.locator('main .badge')).toHaveText('Otwarto pocztę');
  const kinds = await page.evaluate(() => new Promise<string[]>(resolve => {
    const open = indexedDB.open('bor-czuwa');
    open.onsuccess = () => {
      const all = open.result.transaction('reports').objectStore('reports').getAll();
      all.onsuccess = () => {
        resolve(all.result.flatMap(local => local.notices ?? []).flatMap(notice => notice.events.map((event: { kind: string }) => event.kind)));
        open.result.close();
      };
    };
  }));
  expect(kinds.sort()).toEqual(['handed_to_mail_client', 'notice_composed', 'notice_composed']);
});

test('a denied clipboard keeps the Notice available without opening mail or claiming handoff', async ({ page, context }) => {
  await context.setGeolocation({ latitude: points.edge.point.lat, longitude: points.edge.point.lon, accuracy: 8 });
  await context.grantPermissions(['geolocation', 'clipboard-read', 'clipboard-write']);
  await offlineReport(page, 'Łąka za stodołą. '.repeat(30).slice(0, 500));
  await pickPoliceAndPsl(page);
  await page.getByRole('radio', { name: 'Bez podpisu' }).check();
  await page.getByRole('button', { name: 'Przygotuj powiadomienia' }).click();
  const client = await context.newCDPSession(page);
  await client.send('Page.enable');
  const opened: string[] = [];
  client.on('Page.frameRequestedNavigation', event => { if (event.url.startsWith('mailto:')) opened.push(event.url); });
  await page.evaluate(() => {
    const original = navigator.clipboard.writeText.bind(navigator.clipboard);
    navigator.clipboard.writeText = () => {
      navigator.clipboard.writeText = original;
      return Promise.reject(new DOMException('Clipboard denied', 'NotAllowedError'));
    };
  });
  await page.getByRole('link', { name: 'Otwórz w poczcie' }).click();
  await expect(page.getByRole('alert')).toHaveText('Nie udało się skopiować. Zaznacz tekst i skopiuj go ręcznie.');
  await expect(page.getByRole('heading', { name: 'Udało się wysłać?' })).toHaveCount(0);
  expect(opened).toEqual([]);
  await other(page).click();
  await page.getByRole('button', { name: 'Kopiuj treść' }).click();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(await page.locator('.notice-body').textContent());
});

test('each confirmed Notice keeps its own dated outcome and correction history', async ({ page, context }) => {
  await context.setGeolocation({ latitude: points.edge.point.lat, longitude: points.edge.point.lon, accuracy: 8 });
  const events: Record<string, string>[] = [];
  context.on('request', request => {
    if (request.url().endsWith('/events')) events.push(request.postDataJSON());
  });
  await offlineReport(page);
  await pickPoliceAndPsl(page);
  await page.getByRole('radio', { name: 'Bez podpisu' }).check();
  await page.getByRole('button', { name: 'Przygotuj powiadomienia' }).click();
  const police = 'Komenda Powiatowa Policji w Mońkach';
  const psl = 'Państwowa Straż Łowiecka - podlaskie';
  await openNoticeRow(page, police);
  await expect(page.locator('summary', { hasText: 'Wynik zgłoszony przez Ciebie' })).toHaveCount(0);
  await page.getByRole('link', { name: 'Otwórz w poczcie' }).click();
  await expect(page.locator('summary', { hasText: 'Wynik zgłoszony przez Ciebie' })).toHaveCount(0);
  await page.getByRole('button', { name: 'Potwierdzam przekazanie' }).click();
  await openOutcome(page);
  await page.getByLabel('Odpowiedź urzędu').selectOption('no_answer_yet');
  await page.getByLabel('Dzień wyniku').fill('2026-09-23');
  await page.getByRole('button', { name: 'Zapisz wynik' }).click();
  await expect(page.locator('.outcome-section li')).toHaveCount(1);
  await page.getByLabel('Odpowiedź urzędu').selectOption('reply');
  await page.getByLabel('Dzień wyniku').fill('2026-09-24');
  await page.getByRole('button', { name: 'Zapisz korektę' }).click();
  await expect(page.locator('.outcome-section li')).toHaveCount(2);
  await page.getByRole('button', { name: 'Wszystkie powiadomienia' }).click();
  await expect(page.locator('.rows .row').filter({ hasText: police })).toContainText('Przyszła odpowiedź');
  await expect(page.locator('.rows .row').filter({ hasText: psl })).not.toContainText('Przyszła odpowiedź');
  await openNoticeRow(page, psl);
  await expect(page.locator('summary', { hasText: 'Wynik zgłoszony przez Ciebie' })).toHaveCount(0);
  await page.getByRole('link', { name: 'Otwórz w poczcie' }).click();
  await page.getByRole('button', { name: 'Potwierdzam przekazanie' }).click();
  await expect(page.locator('.screen-foot .primary')).toHaveText('Gotowe');
  await openOutcome(page);
  await page.getByLabel('Odpowiedź urzędu').selectOption('refusal');
  await page.getByLabel('Dzień wyniku').fill('2026-09-24');
  await page.getByRole('button', { name: 'Zapisz wynik' }).click();
  await expect(page.locator('.outcome-section li')).toHaveCount(1);
  await page.reload();
  await page.getByRole('button', { name: 'Moje zapisy' }).click();
  await page.getByRole('button', { name: /^Człowiek z bronią, / }).click();
  await page.getByRole('button', { name: /Powiadomienia do urzędów/ }).click();
  await page.getByRole('button', { name: 'Wszystkie powiadomienia' }).click();
  await expect(page.locator('.rows .row').filter({ hasText: police })).toContainText('Przyszła odpowiedź');
  await expect(page.locator('.rows .row').filter({ hasText: psl })).toContainText('Odmowa');
  expect(events).toHaveLength(0);
  await context.setOffline(false);
  await expect.poll(() => events.filter(event => event.kind === 'outcome_reported').length, { timeout: 20_000 }).toBe(3);
  const outcomes = events.filter(event => event.kind === 'outcome_reported');
  expect(outcomes.map(event => event.outcome)).toEqual(['no_answer_yet', 'reply', 'refusal']);
  expect(new Set(outcomes.slice(0, 2).map(event => event.notice_id)).size).toBe(1);
  expect(outcomes[2].notice_id).not.toBe(outcomes[0].notice_id);
  for (const event of outcomes) {
    expect(Object.keys(event).sort()).toEqual(['at', 'id', 'kind', 'notice_id', 'observed_on', 'outcome', 'recipient_kind', 'unit_id']);
  }
});

test('follow-up guidance belongs only to unanswered confirmed Signed Notices and hides release status', async ({ page, context }) => {
  await context.setGeolocation({ latitude: points.edge.point.lat, longitude: points.edge.point.lon, accuracy: 8 });
  await offlineReport(page);
  await pickPoliceAndPsl(page);
  await page.getByRole('radio', { name: 'Z podpisem' }).check();
  await page.getByLabel('Imię i nazwisko').fill('Anna Nowak');
  await page.getByLabel('Adres do korespondencji').fill('Leśna 1');
  await page.getByRole('button', { name: 'Przygotuj powiadomienia' }).click();
  await openNoticeRow(page);
  const followUp = page.getByText('Przypomnienie o sprawdzeniu odpowiedzi przypada sześć tygodni', { exact: false });
  await expect(followUp).toHaveCount(0);
  await page.getByRole('link', { name: 'Otwórz w poczcie' }).click();
  await page.getByRole('button', { name: 'Potwierdzam przekazanie' }).click();
  await openOutcome(page);
  if (process.env.VITE_CHECK_IN_ENABLED === 'true') await expect(followUp).toBeVisible();
  else await expect(followUp).toHaveCount(0);
  await expect(page.getByText('Wzór pisma czeka na sprawdzenie prawne.')).toHaveCount(0);
  await expect(page.getByText('Nie ma jeszcze zatwierdzonej ścieżki', { exact: false })).toHaveCount(0);
  await page.getByLabel('Odpowiedź urzędu').selectOption('reply');
  await page.getByLabel('Dzień wyniku').fill('2026-09-24');
  await page.getByRole('button', { name: 'Zapisz wynik' }).click();
  await expect(followUp).toHaveCount(0);
});

test('Unsigned Notice never gets the follow-up placeholder', async ({ page, context }) => {
  await context.setGeolocation({ latitude: points.edge.point.lat, longitude: points.edge.point.lon, accuracy: 8 });
  await offlineReport(page);
  await pickPoliceAndPsl(page);
  await page.getByRole('radio', { name: 'Bez podpisu' }).check();
  await page.getByRole('button', { name: 'Przygotuj powiadomienia' }).click();
  await openNoticeRow(page);
  await page.getByRole('link', { name: 'Otwórz w poczcie' }).click();
  await page.getByRole('button', { name: 'Potwierdzam przekazanie' }).click();
  await openOutcome(page);
  await expect(page.getByLabel('Odpowiedź urzędu')).toBeVisible();
  await expect(page.getByText('Przypomnienie o sprawdzeniu odpowiedzi', { exact: false })).toHaveCount(0);
});

test('remembered Signed details prefill the next Notice group; forgetting them removes them', async ({ page, context }) => {
  await context.setGeolocation({ latitude: points.edge.point.lat, longitude: points.edge.point.lon, accuracy: 8 });
  await offlineReport(page);
  await pickPoliceAndPsl(page);
  await page.getByRole('radio', { name: 'Z podpisem' }).check();
  await page.getByLabel('Imię i nazwisko').fill('Anna Nowak');
  await page.getByLabel('Adres do korespondencji').fill('ul. Polna 2');
  await page.getByLabel('Zapamiętaj te dane na tym telefonie').check();
  await page.getByRole('button', { name: 'Przygotuj powiadomienia' }).click();
  await page.getByRole('button', { name: 'Wszystkie powiadomienia' }).click();
  await expect(page.locator('.rows .row')).toHaveCount(2);
  await page.reload();
  await page.getByRole('button', { name: 'Moje zapisy' }).click();
  await page.getByRole('button', { name: /^Człowiek z bronią, / }).click();
  await page.getByRole('button', { name: /Powiadomienia do urzędów/ }).click();
  await openNoticeRow(page);
  await expect(page.locator('.notice-body')).toContainText('Anna Nowak');

  await page.getByRole('button', { name: 'Wszystkie powiadomienia' }).click();
  await page.getByRole('button', { name: 'Dodaj powiadomienie' }).click();
  await page.getByRole('button', { name: 'Dalej: podpis' }).click();
  await expect(page.getByRole('radio', { name: 'Z podpisem' })).toBeChecked();
  await expect(page.getByLabel('Imię i nazwisko')).toHaveValue('Anna Nowak');
  await page.getByLabel('Zapamiętaj te dane na tym telefonie').uncheck();
  await page.getByRole('button', { name: 'Przygotuj powiadomienia' }).click();
  await page.getByRole('button', { name: 'Wszystkie powiadomienia' }).click();
  await expect(page.locator('.rows .row')).toHaveCount(2);
  await page.reload();
  await page.getByRole('button', { name: 'Moje zapisy' }).click();
  await page.getByRole('button', { name: /^Człowiek z bronią, / }).click();
  await page.getByRole('button', { name: /Powiadomienia do urzędów/ }).click();
  await openNoticeRow(page);
  await expect(page.getByText('Dane podpisu nie zostały zapamiętane.', { exact: false })).toBeVisible();
  await expect(page.getByLabel('Imię i nazwisko')).toHaveValue('');
  await expect(page.getByRole('link', { name: 'Otwórz w poczcie' })).toHaveCount(0);
});

async function signerRecord(page: Page) {
  return page.evaluate(() => new Promise<unknown[]>((resolve, reject) => {
    const request = indexedDB.open('bor-czuwa');
    request.onsuccess = () => {
      const db = request.result;
      const rows = db.transaction('signer').objectStore('signer').getAll();
      rows.onsuccess = () => { db.close(); resolve(rows.result); };
      rows.onerror = () => reject(rows.error);
    };
    request.onerror = () => reject(request.error);
  }));
}

test('the Menu deletes remembered signer details', async ({ page, context }) => {
  await context.setGeolocation({ latitude: points.edge.point.lat, longitude: points.edge.point.lon, accuracy: 8 });
  const sent: string[] = [];
  context.on('request', request => { if (request.url().startsWith('http')) sent.push(`${request.url()} ${request.postData() ?? ''}`); });
  const menu = () => page.getByRole('button', { name: 'Menu' }).click();
  const row = page.getByRole('region', { name: 'Zapamiętane dane podpisu' });
  const confirm = page.getByRole('group', { name: 'Usunąć zapamiętane dane podpisu?' });
  await offlineReport(page);
  // Control: with no record the Menu has no row.
  await menu();
  await expect(page.getByRole('heading', { name: 'Menu' })).toBeVisible();
  await expect(row).toHaveCount(0);
  await page.goBack();
  await expect(page.getByRole('button', { name: 'Przygotuj powiadomienie' })).toBeVisible();

  await pickPoliceAndPsl(page);
  await page.getByRole('radio', { name: 'Z podpisem' }).check();
  await page.getByLabel('Imię i nazwisko').fill('Anna Nowak');
  await page.getByLabel('Adres do korespondencji').fill('ul. Polna 2');
  await page.getByLabel('Telefon (opcjonalnie)').fill('600100299');
  await page.getByLabel('Zapamiętaj te dane na tym telefonie').check();
  await page.getByRole('button', { name: 'Przygotuj powiadomienia' }).click();
  await page.getByRole('button', { name: 'Wszystkie powiadomienia' }).click();
  await expect(page.locator('.rows .row')).toHaveCount(2);
  expect(await signerRecord(page)).toHaveLength(1);

  // The row appears without a reload.
  await menu();
  await expect(row).toBeVisible();
  const remove = row.getByRole('button', { name: 'Usuń zapamiętane dane podpisu' });
  await remove.click();
  await expect(confirm).toContainText('Zapisane zgłoszenia się nie zmienią.');
  await expect(confirm.getByRole('button', { name: 'Anuluj' })).toBeFocused();
  await confirm.getByRole('button', { name: 'Anuluj' }).click();
  await expect(confirm).toHaveCount(0);
  await expect(remove).toBeFocused();
  expect(await signerRecord(page)).toHaveLength(1);

  await remove.click();
  await confirm.getByRole('button', { name: 'Usuń', exact: true }).click();
  await expect(page.getByText('Dane podpisu usunięte z tego telefonu.')).toBeVisible();
  await expect(page.locator('#signer-result')).toBeFocused();
  await expect(row).toHaveCount(0);
  expect(await signerRecord(page)).toEqual([]);

  // After deleting, the next Signed Notice starts empty and unticked, and Menu has no row.
  await page.goBack();
  await page.getByRole('button', { name: 'Dodaj powiadomienie' }).click();
  await page.getByRole('button', { name: 'Dalej: podpis' }).click();
  await page.getByRole('radio', { name: 'Z podpisem' }).check();
  await expect(page.getByLabel('Imię i nazwisko')).toHaveValue('');
  await expect(page.getByLabel('Adres do korespondencji')).toHaveValue('');
  await expect(page.getByLabel('Telefon (opcjonalnie)')).toHaveValue('');
  await expect(page.getByLabel('Zapamiętaj te dane na tym telefonie')).not.toBeChecked();
  await menu();
  await expect(page.getByRole('heading', { name: 'Menu' })).toBeVisible();
  await expect(row).toHaveCount(0);
  // Nothing in the flow carried the signer values off the phone.
  expect(sent.filter(request => /Anna|Nowak|Polna|600100299/.test(decodeURIComponent(request)))).toEqual([]);
});

test('the Menu row never shows for details a Notice just forgot', async ({ page, context }) => {
  await context.setGeolocation({ latitude: points.edge.point.lat, longitude: points.edge.point.lon, accuracy: 8 });
  await offlineReport(page);
  await pickPoliceAndPsl(page);
  await page.getByRole('radio', { name: 'Z podpisem' }).check();
  await page.getByLabel('Imię i nazwisko').fill('Anna Nowak');
  await page.getByLabel('Adres do korespondencji').fill('ul. Polna 2');
  await page.getByLabel('Zapamiętaj te dane na tym telefonie').check();
  await page.getByRole('button', { name: 'Przygotuj powiadomienia' }).click();
  await page.getByRole('button', { name: 'Wszystkie powiadomienia' }).click();
  await page.getByRole('button', { name: 'Menu' }).click();
  await expect(page.getByRole('region', { name: 'Zapamiętane dane podpisu' })).toBeVisible();
  await page.goBack();
  await page.getByRole('button', { name: 'Dodaj powiadomienie' }).click();
  await page.getByRole('button', { name: 'Dalej: podpis' }).click();
  await page.getByLabel('Zapamiętaj te dane na tym telefonie').uncheck();
  await page.getByRole('button', { name: 'Przygotuj powiadomienia' }).click();
  await expect.poll(() => signerRecord(page)).toEqual([]);
  // The row must not flash while Menu reads the store.
  await page.evaluate(() => {
    (window as unknown as { rowSeen: boolean }).rowSeen = false;
    new MutationObserver(() => { if (document.getElementById('signer-heading')) (window as unknown as { rowSeen: boolean }).rowSeen = true; })
      .observe(document.body, { childList: true, subtree: true });
  });
  await page.getByRole('button', { name: 'Menu' }).click();
  await expect(page.getByRole('heading', { name: 'Menu' })).toBeVisible();
  await page.waitForTimeout(1000);
  expect(await page.evaluate(() => (window as unknown as { rowSeen: boolean }).rowSeen)).toBe(false);
});

test('Polish Notice uses display names while source disclosure retains dataset and Rule set IDs', async ({ page, context }) => {
  await context.setGeolocation({ latitude: points.edge.point.lat, longitude: points.edge.point.lon, accuracy: 8 });
  const fixture = JSON.parse(await readFile(new URL('./computed-findings.json', import.meta.url), 'utf8'));
  await page.route('**/api/reports', route => route.fulfill({ status: 201, json: { id: 'accepted' } }));
  await page.route('**/api/reports/*/findings', route => route.fulfill({ status: 200, json: fixture }));
  await page.route('**/api/reports/*/events', route => route.fulfill({ status: 204 }));
  await page.goto('/');
  await page.getByRole('button', { name: 'Człowiek z bronią', exact: true }).click();
  await finishFromWhen(page, false);
  await page.getByRole('button', { name: 'Zapisz zgłoszenie' }).click();
  await expect(page.locator('[data-fact="protected"]')).toBeVisible();
  await page.getByRole('button', { name: 'Przygotuj powiadomienie', exact: true }).click();
  await expect(page.getByRole('checkbox', { name: /Komenda Powiatowa Policji w Mońkach/ })).toBeChecked();
  await page.getByRole('button', { name: 'Dalej: podpis', exact: true }).click();
  await page.getByRole('radio', { name: 'Bez podpisu' }).check();
  await page.getByRole('button', { name: 'Przygotuj powiadomienia' }).click();
  await openNoticeRow(page, 'Komenda Powiatowa Policji w Mońkach');
  await page.getByText('Przejrzyj treść powiadomienia', { exact: true }).click();
  await expect(page.locator('.notice-body')).toContainText('ambony z OpenStreetMap');
  await expect(page.locator('.notice-body')).toContainText('parki narodowe Generalnej Dyrekcji Ochrony Środowiska');
  for (const identifier of ['OpenStreetMap hunting stands', 'GDOS:ParkiNarodowe', fixture.rule_set_id])
    await expect(page.locator('.notice-body')).not.toContainText(identifier);
  const sources = page.locator('details.disclosure').filter({ has: page.getByText('Źródła danych i reguły', { exact: true }) });
  await sources.locator('summary').focus();
  await page.keyboard.press('Enter');
  await expect(sources).toHaveAttribute('open', '');
  for (const identifier of ['OpenStreetMap hunting stands', 'GDOS:ParkiNarodowe', fixture.rule_set_id])
    await expect(sources).toContainText(identifier);
});

// A Notice handed off while Findings are pending keeps the text that was handed over.
const police = 'Komenda Powiatowa Policji w Mońkach';
const psl = 'Państwowa Straż Łowiecka - podlaskie';
const pendingLine = 'Ustalenia nie są jeszcze dostępne';
const norm = (value: string) => value.replace(/\s+/g, ' ').trim();

/** Holds the Findings response until released, so a Notice can be handed off while Findings are pending. */
async function holdFindings(page: Page) {
  let release!: () => void;
  let arrived!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const reached = new Promise<void>(resolve => { arrived = resolve; });
  await page.route('**/api/reports/*/findings', async route => { arrived(); await gate; await route.continue(); });
  return { release, reached };
}
const storedReport = (page: Page) => page.evaluate(() => new Promise<Record<string, any>>(resolve => {
  const open = indexedDB.open('bor-czuwa');
  open.onsuccess = () => {
    const all = open.result.transaction('reports').objectStore('reports').getAll();
    all.onsuccess = () => { resolve(all.result[0]); open.result.close(); };
  };
}));
async function findingsComputed(page: Page) {
  await expect.poll(async () => (await storedReport(page)).findings.status, { timeout: 30_000 }).toBe('computed');
}
const computedFixture = JSON.parse(await readFile(new URL('./computed-findings.json', import.meta.url), 'utf8'));
/** Findings reach storage while the open screen still holds the pending ones: the race a handoff can lose. */
const arriveInStorage = (page: Page) => page.evaluate(findings => new Promise<void>(resolve => {
  const open = indexedDB.open('bor-czuwa');
  open.onsuccess = () => {
    const transaction = open.result.transaction('reports', 'readwrite');
    const store = transaction.objectStore('reports');
    store.getAll().onsuccess = event => { for (const local of (event.target as IDBRequest).result) { local.findings = findings; store.put(local); } };
    transaction.oncomplete = () => { open.result.close(); resolve(); };
  };
}), computedFixture);
/** The subject and body the mail link carries, or the clipboard text when the body is too long for a link. */
async function mailPayload(page: Page) {
  const url = new URL((await page.getByRole('link', { name: 'Otwórz w poczcie' }).getAttribute('href'))!);
  return { subject: url.searchParams.get('subject')!, body: url.searchParams.get('body')?.replace(/\r\n/g, '\n') };
}
async function readNotice(page: Page) {
  const summary = page.locator('summary', { hasText: 'Przejrzyj treść powiadomienia' });
  if (!await summary.locator('xpath=..').evaluate(details => (details as HTMLDetailsElement).open)) await summary.click();
  return { subject: (await page.locator('.notice-subject').textContent())!, body: (await page.locator('.notice-body').textContent())! };
}
async function reopenNotice(page: Page, name: string) {
  await page.reload();
  await page.getByRole('button', { name: 'Moje zapisy' }).click();
  await page.getByRole('button', { name: /^Człowiek z bronią, / }).click();
  await page.getByRole('button', { name: /Powiadomienia do urzędów/ }).click();
  await page.getByRole('button', { name: 'Wszystkie powiadomienia' }).click();
  await page.locator('.rows .row').filter({ hasText: name }).click();
  await settled(page);
}
async function prepare(page: Page, signed = false) {
  await pickPoliceAndPsl(page);
  if (signed) {
    await page.getByRole('radio', { name: 'Z podpisem' }).check();
    await page.getByLabel('Imię i nazwisko').fill('Jan Kowalski');
    await page.getByLabel('Adres do korespondencji').fill('ul. Leśna 1, 19-100 Mońki');
    await page.getByLabel('Telefon (opcjonalnie)').fill('600100200');
  } else await page.getByRole('radio', { name: 'Bez podpisu' }).check();
  await page.getByRole('button', { name: 'Przygotuj powiadomienia' }).click();
}
/** Samples the open Notice text on every frame, so a repaint with different words cannot hide between assertions. */
const sampleBodies = (page: Page, selector: string) => page.evaluate(sel => {
  const seen = new Set<string>();
  (window as unknown as { seenBodies: Set<string> }).seenBodies = seen;
  const tick = () => { const node = document.querySelector(sel); if (node) seen.add(node.textContent ?? ''); requestAnimationFrame(tick); };
  tick();
}, selector);
const seenBodies = (page: Page) => page.evaluate(() => [...(window as unknown as { seenBodies: Set<string> }).seenBodies]);

test.describe('handed-off Notice text', () => {
  test.beforeEach(async ({ context }) => {
    await context.setGeolocation({ latitude: points.edge.point.lat, longitude: points.edge.point.lon, accuracy: 8 });
    await context.grantPermissions(['geolocation', 'clipboard-read', 'clipboard-write']);
  });

  test('a handed-off Notice keeps the text that was sent', async ({ page, context }) => {
    await offlineReport(page);
    await prepare(page);
    await openNoticeRow(page, police);
    const before = await readNotice(page);
    expect(before.body).toContain(pendingLine);
    const payload = await mailPayload(page);
    if (!demoRecipient) expect(payload).toEqual(before);
    const held = await holdFindings(page);
    await page.getByRole('link', { name: 'Otwórz w poczcie' }).click();
    await page.getByRole('button', { name: 'Potwierdzam przekazanie' }).click();
    await expect(page.locator('main .badge')).toHaveText('Przekazanie potwierdzone przez Ciebie');
    await sampleBodies(page, '.notice-body');
    await context.setOffline(false);
    await held.reached;
    held.release();
    await findingsComputed(page);
    await settled(page);
    expect(await seenBodies(page)).toEqual([before.body]);
    await reopenNotice(page, police);
    const reopened = await readNotice(page);
    expect(reopened).toEqual(before);
    // What the mail client received is what the reopened Notice shows.
    if (!demoRecipient) expect(reopened).toEqual(payload);
  });

  test('Findings reaching storage while the mail opens do not change the Notice that was handed over', async ({ page }) => {
    await offlineReport(page);
    await prepare(page);
    await openNoticeRow(page, police);
    const before = await readNotice(page);
    const payload = await mailPayload(page);
    if (!demoRecipient) expect(payload).toEqual(before);
    await arriveInStorage(page);
    await page.getByRole('link', { name: 'Otwórz w poczcie' }).click();
    await page.getByRole('button', { name: 'Potwierdzam przekazanie' }).click();
    await expect(page.locator('main .badge')).toHaveText('Przekazanie potwierdzone przez Ciebie');
    await reopenNotice(page, police);
    const reopened = await readNotice(page);
    expect(reopened.body).toContain(pendingLine);
    expect(reopened).toEqual(before);
    if (!demoRecipient) expect(reopened).toEqual(payload);
  });

  test('with Findings pending throughout, a confirmed Notice reads the same after reload', async ({ page }) => {
    await offlineReport(page);
    await prepare(page);
    await openNoticeRow(page, police);
    const before = await readNotice(page);
    await page.getByRole('link', { name: 'Otwórz w poczcie' }).click();
    await page.getByRole('button', { name: 'Potwierdzam przekazanie' }).click();
    await expect(page.locator('main .badge')).toHaveText('Przekazanie potwierdzone przez Ciebie');
    await reopenNotice(page, police);
    expect(await readNotice(page)).toEqual(before);
  });

  test('an unsent Notice still recomposes from the latest Findings', async ({ page, context }) => {
    await offlineReport(page);
    await prepare(page);
    await openNoticeRow(page, police);
    const before = await readNotice(page);
    expect(before.body).toContain(pendingLine);
    await context.setOffline(false);
    await findingsComputed(page);
    await expect(page.locator('.notice-body')).not.toContainText(pendingLine);
    await expect(page.locator('.notice-body')).toContainText('Źródła danych:');
  });

  test('a copied Notice keeps the copied text after Findings arrive', async ({ page, context }) => {
    // The private demo sends every Notice to its test inbox, so it has no copy route.
    test.skip(!!demoRecipient, 'private demo has no copy route');
    await offlineReport(page);
    // An authority without a verified address is the copy route.
    await page.getByRole('button', { name: 'Przygotuj powiadomienie' }).click();
    await page.getByRole('button', { name: 'Wybierz jednostkę po nazwie', exact: true }).click();
    await page.getByLabel('Nazwa lub miejscowość').fill('Kaliszu');
    await page.getByRole('button', { name: /Komenda Miejska Policji w Kaliszu/ }).click();
    await page.getByRole('button', { name: 'Dalej: podpis' }).click();
    await page.getByRole('radio', { name: 'Bez podpisu' }).check();
    await page.getByRole('button', { name: 'Przygotuj powiadomienia' }).click();
    await expect(page.locator('.screen-foot .primary')).toHaveText('Kopiuj treść');
    const held = await holdFindings(page);
    await page.locator('.screen-foot .primary').click();
    await expect(page.getByRole('heading', { name: 'Udało się wysłać?' })).toBeVisible();
    const copied = await page.evaluate(() => navigator.clipboard.readText());
    expect(copied).toContain(pendingLine);
    const before = await readNotice(page);
    expect(before.body).toBe(copied);
    await sampleBodies(page, '.notice-body');
    await context.setOffline(false);
    await held.reached;
    held.release();
    await findingsComputed(page);
    await settled(page);
    expect((await readNotice(page)).body).toBe(copied);
    expect(await seenBodies(page)).toEqual([copied]);
  });

  test('a confirmed Notice with no stored snapshot recomposes when Findings arrive', async ({ page, context }) => {
    await offlineReport(page);
    await prepare(page);
    await openNoticeRow(page, police);
    const held = await holdFindings(page);
    await page.getByRole('link', { name: 'Otwórz w poczcie' }).click();
    await page.getByRole('button', { name: 'Potwierdzam przekazanie' }).click();
    await expect(page.locator('main .badge')).toHaveText('Przekazanie potwierdzone przez Ciebie');
    // Records confirmed before this change never had the snapshot.
    await page.evaluate(() => new Promise<void>(resolve => {
      const open = indexedDB.open('bor-czuwa');
      open.onsuccess = () => {
        const transaction = open.result.transaction('reports', 'readwrite');
        const store = transaction.objectStore('reports');
        store.getAll().onsuccess = event => {
          for (const local of (event.target as IDBRequest).result) {
            for (const notice of local.notices ?? []) delete notice.handoffFindings;
            store.put(local);
          }
        };
        transaction.oncomplete = () => { open.result.close(); resolve(); };
      };
    }));
    await context.setOffline(false);
    await held.reached;
    held.release();
    await findingsComputed(page);
    await reopenNotice(page, police);
    const after = await readNotice(page);
    expect(after.body).not.toContain(pendingLine);
    expect(after.body).toContain('Źródła danych:');
    await expect(page.getByRole('alert')).toHaveCount(0);
  });

  test('a legacy handoff confirmed after Findings arrived does not freeze the newer Findings', async ({ page, context }) => {
    await offlineReport(page);
    await prepare(page);
    await openNoticeRow(page, police);
    await page.getByRole('link', { name: 'Otwórz w poczcie' }).click();
    await expect(page.getByRole('heading', { name: 'Udało się wysłać?' })).toBeVisible();
    // An older build recorded this handoff with pending Findings and kept no snapshot.
    await page.evaluate(() => new Promise<void>(resolve => {
      const open = indexedDB.open('bor-czuwa');
      open.onsuccess = () => {
        const transaction = open.result.transaction('reports', 'readwrite');
        const store = transaction.objectStore('reports');
        store.getAll().onsuccess = event => {
          for (const local of (event.target as IDBRequest).result) { for (const notice of local.notices ?? []) delete notice.handoffFindings; store.put(local); }
        };
        transaction.oncomplete = () => { open.result.close(); resolve(); };
      };
    }));
    // The Reporter upgrades, Findings arrive, and only then the handoff is confirmed.
    await context.setOffline(false);
    await findingsComputed(page);
    await reopenNotice(page, police);
    await page.getByRole('button', { name: 'Potwierdzam przekazanie' }).click();
    await expect(page.locator('main .badge')).toHaveText('Przekazanie potwierdzone przez Ciebie');
    const notice = (await storedReport(page)).notices.find((item: { recipient: { name: string } }) => item.recipient.name === police);
    // Confirmation is not the handoff: nothing may be frozen now, so the text keeps following the Findings.
    expect(notice.handoffFindings).toBeUndefined();
    expect((await readNotice(page)).body).not.toContain(pendingLine);
  });

  test('a Signed PDF keeps its text after Findings arrive', async ({ page, context }, testInfo) => {
    await offlineReport(page);
    await prepare(page, true);
    await openNoticeRow(page, police);
    await fileAsPdf(page);
    const preview = async () => {
      const summary = page.locator('summary', { hasText: 'Przejrzyj PDF' });
      if (!await summary.locator('xpath=..').evaluate(details => (details as HTMLDetailsElement).open)) await summary.click();
      return (await page.locator('.pdf-body').textContent())!;
    };
    const before = await preview();
    expect(before).toContain(pendingLine);
    const subjectOf = (await page.locator('details', { has: page.locator('.pdf-body') }).locator('p').nth(1).textContent())!;
    const held = await holdFindings(page);
    const downloadPromise = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Pobierz PDF' }).click();
    const download = await downloadPromise;
    const saved = testInfo.outputPath('signed-notice.pdf');
    await download.saveAs(saved);
    const fileText = () => execFileSync('pdftotext', [saved, '-'], { encoding: 'utf8' });
    // The body in the file is everything after the subject line.
    const fileBody = () => { const text = norm(fileText()), subject = norm(subjectOf); return text.slice(text.indexOf(subject) + subject.length).trim(); };
    expect(fileBody()).toBe(norm(before));
    await expect(page.getByRole('heading', { name: 'Udało się wysłać?' })).toBeVisible();
    // After the file is saved the same text is the Notice body.
    expect(norm((await readNotice(page)).body)).toBe(norm(before));
    await sampleBodies(page, '.notice-body');
    await context.setOffline(false);
    await held.reached;
    held.release();
    await findingsComputed(page);
    await settled(page);
    const after = (await readNotice(page)).body;
    expect(norm(after)).toBe(norm(before));
    expect(fileBody()).toBe(norm(after));
    expect(await seenBodies(page)).toEqual([after]);
  });

  test('Findings reaching storage while the PDF is exported do not change the Notice that was exported', async ({ page }, testInfo) => {
    await offlineReport(page);
    await prepare(page, true);
    await openNoticeRow(page, police);
    await fileAsPdf(page);
    await page.locator('summary', { hasText: 'Przejrzyj PDF' }).click();
    const before = (await page.locator('.pdf-body').textContent())!;
    const subject = norm((await page.locator('details', { has: page.locator('.pdf-body') }).locator('p').nth(1).textContent())!);
    expect(before).toContain(pendingLine);
    await arriveInStorage(page);
    const downloadPromise = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Pobierz PDF' }).click();
    const saved = testInfo.outputPath('race.pdf');
    await (await downloadPromise).saveAs(saved);
    const text = norm(execFileSync('pdftotext', [saved, '-'], { encoding: 'utf8' }));
    const exported = text.slice(text.indexOf(subject) + subject.length).trim();
    expect(exported).toBe(norm(before));
    await expect(page.getByRole('heading', { name: 'Udało się wysłać?' })).toBeVisible();
    expect(norm((await readNotice(page)).body)).toBe(exported);
  });

  test('the stored snapshot holds only Findings, and nothing about it leaves the device', async ({ page, context }) => {
    await offlineReport(page);
    await prepare(page, true);
    await openNoticeRow(page, police);
    const sent: string[] = [];
    await context.setOffline(false);
    await findingsComputed(page);
    context.on('request', request => { if (request.url().startsWith('http')) sent.push(`${request.method()} ${request.url()} ${request.postData() ?? ''}`); });
    await page.getByRole('link', { name: 'Otwórz w poczcie' }).click();
    await page.getByRole('button', { name: 'Potwierdzam przekazanie' }).click();
    await expect(page.locator('main .badge')).toHaveText('Przekazanie potwierdzone przez Ciebie');
    await expect.poll(() => sent.filter(line => line.includes('confirmed_by_reporter')).length, { timeout: 20_000 }).toBeGreaterThan(0);
    const local = await storedReport(page);
    const snapshot = local.notices.find((notice: { recipient: { name: string } }) => notice.recipient.name === police).handoffFindings;
    expect(snapshot.status).toBe('computed');
    const text = JSON.stringify(snapshot);
    for (const secret of ['Kowalski', 'Leśna', '600100200', 'privateFix', 'Ustalenia nie są']) expect(text).not.toContain(secret);
    if (local.privateFix) {
      for (const value of [local.privateFix.lat, local.privateFix.lon]) expect(text).not.toContain(String(value).slice(0, 7));
    }
    for (const line of sent) {
      expect(line).not.toContain('handoffFindings');
      expect(line).not.toContain('rule_set_id');
    }
  });
});
