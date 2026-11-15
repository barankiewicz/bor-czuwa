import { test, expect, type Page } from '@playwright/test';
import { clockedGeolocation, openMap, answerHome, answerNow, blankTiles, chooseHours, footer, heading, leaveCompass, press, reportPost, save, setEstimate, startEvent, toReview } from './stages.ts';

test.use({ serviceWorkers: 'block' });

const metres = (bounds: number[]) => [(bounds[2] - bounds[0]) * 111_320 * Math.cos((bounds[1] + bounds[3]) / 2 * Math.PI / 180),
  (bounds[3] - bounds[1]) * 111_320];
const steps = (page: Page) => page.locator('.steps li');

test.beforeEach(async ({ page }) => { await blankTiles(page); });

test('a basic shot asks Kiedy, offers Gdzie, and saves from Sprawdź without optional details', async ({ page, context }) => {
  await context.setGeolocation({ latitude: 52.2297, longitude: 21.0122, accuracy: 12 });
  await page.goto('/');
  await startEvent(page, 'Strzał');
  await expect(steps(page)).toHaveText(['Kiedy', 'Gdzie', 'Sprawdź']);
  await expect(page.locator('.steps li[aria-current="step"]')).toHaveText('Kiedy');
  await answerNow(page);
  await expect(heading(page, 'Skąd słychać strzał?')).toBeVisible();
  await expect(footer(page).getByRole('button', { name: 'Pomiń' })).toBeVisible();
  await leaveCompass(page);
  await expect(page.locator('#draft-next')).toContainText('Odpowiedz na pytanie o dom.');
  await expect(page.getByLabel('Co jeszcze chcesz przekazać?')).toBeHidden();
  await expect(page.locator('summary', { hasText: 'Gatunek' })).toHaveCount(0);
  for (const hidden of ['4 × 4', '8 × 8', 'serwer', 'Dokładność', 'Potwierdzam']) await expect(page.locator('main')).not.toContainText(hidden);
  await answerHome(page, false);
  await expect(page.locator('#draft-next')).toHaveCount(0);
  await expect(page.locator('.privacy')).toContainText('W zgłoszeniu zapiszemy przybliżoną okolicę strzału.');
  const posted = await reportPost(page);
  await save(page);
  const payload = (await posted.request).postDataJSON();
  expect(payload.species).toBeNull();
  expect(payload.has_note).toBe(false);
  expect(payload.incident_location.type).toBe('area');
  expect(payload.incident_location.basis).toBe('reporter_selected_area');
  expect(payload.incident_location.precise_fix_withheld).toBeNull();
  // One kilometre around the fix without any estimate.
  for (const side of metres(payload.incident_location.bounds)) expect(Math.abs(side - 2000)).toBeLessThan(3);
  expect(payload.occurred_at.coarseness).toBe('exact');
  expect(payload.occurred_at.at).toBe(payload.captured_at);
});

test('a shot heard now away from home sends its area with direction and distance; from home neither', async ({ page, context }) => {
  await context.setGeolocation({ latitude: 52.2297, longitude: 21.0122, accuracy: 12 });
  for (const home of [false, true]) {
    await page.goto('/');
    await startEvent(page, 'Strzał');
    await answerNow(page);
    await setEstimate(page, 90, 1000);
    await expect(page.getByRole('slider', { name: 'Tarcza kierunku' })).toHaveAttribute('aria-valuetext', 'na wschód, 90°, około 1 km');
    await expect(footer(page).getByRole('button', { name: 'Dalej' })).toBeVisible();
    await leaveCompass(page);
    await answerHome(page, home);
    await expect(page.locator('#place-row')).toContainText(home ? 'około 1 km na wschód od domu' : 'około 1 km na wschód od Ciebie');
    await expect(page.locator('.privacy')).toContainText(home ? 'Twój dom nie będzie widoczny.' : 'przybliżoną okolicę strzału');
    const posted = await reportPost(page);
    await save(page);
    const area = (await posted.request).postDataJSON().incident_location;
    if (home) {
      expect(area.precise_fix_withheld).toBe('home_privacy');
      expect(area.hearing_bearing_deg).toBeUndefined();
      expect(area.hearing_distance_m).toBeUndefined();
      expect(area.hearing_distance_band).toBeUndefined();
      expect(area.basis).toBe('estimated_from_hearing');
      // r = 500 m, so the 4 km grid cell.
      expect(area.bounds[3] - area.bounds[1]).toBeCloseTo(4 / 111, 5);
    } else {
      expect(area.hearing_bearing_deg).toBe(90);
      expect(area.hearing_distance_m).toBe(1000);
      for (const side of metres(area.bounds)) expect(Math.abs(side - 1000)).toBeLessThan(3);
      expect((area.bounds[0] + area.bounds[2]) / 2).toBeGreaterThan(21.0122);
    }
  }
});

test('a saved home answers the home question, and Nie jestem w domu overrides it', async ({ page, context }) => {
  await context.setGeolocation({ latitude: 52.2297, longitude: 21.0122, accuracy: 12 });
  await page.goto('/');
  await toReview(page, 'Człowiek z bronią', true);
  await expect(page.locator('#place-row')).toContainText('u Ciebie w domu lub na podwórku');
  await page.route('**/api/reports', route => route.request().method() === 'POST' ? route.abort() : route.fallback());
  await save(page);
  await expect(heading(page, /^Zgłoszenie$/)).toBeVisible();
  await page.goto('/');
  await toReview(page, 'Strzał');
  await expect(page.locator('#home-check')).toHaveCount(0);
  await expect(page.locator('#place-row')).toContainText('w okolicy domu');
  await expect(page.locator('.privacy')).toContainText('Twój dom nie będzie widoczny.');
  await page.getByRole('button', { name: 'Nie jestem w domu' }).click();
  await expect(page.locator('.privacy')).toContainText('przybliżoną okolicę strzału');
  await expect(page.locator('#place-row')).toContainText('w okolicy, w której jesteś');
});

test('a seen Event happening now skips its dial and sends its point; remains have no Gdzie step', async ({ page, context }) => {
  await context.setGeolocation({ latitude: 52.2297, longitude: 21.0122, accuracy: 12 });
  await page.goto('/');
  await startEvent(page, 'Szczątki w lesie');
  await expect(steps(page)).toHaveText(['Kiedy', 'Sprawdź']);
  await page.goto('/');
  await startEvent(page, 'Kłusownictwo');
  await expect(steps(page)).toHaveText(['Kiedy', 'Gdzie', 'Sprawdź']);
  await answerNow(page);
  await expect(heading(page, 'Gdzie to widzisz?')).toBeVisible();
  await leaveCompass(page);
  await expect(page.locator('#place-row')).toContainText('tam, gdzie jesteś');
  await answerHome(page, false);
  await expect(page.locator('.privacy')).toContainText('W zgłoszeniu zapiszemy to miejsce.');
  const posted = await reportPost(page);
  await save(page);
  const payload = (await posted.request).postDataJSON();
  expect(payload.incident_location).toEqual({ lat: 52.2297, lon: 21.0122, source: 'device_fix' });
  expect(payload.device_fix.accuracy_m).toBe(12);
});

test('an earlier Event asks a map point and radius, then sends the area around it', async ({ page, context }) => {
  await context.setGeolocation({ latitude: 52.2297, longitude: 21.0122, accuracy: 12 });
  await page.clock.install({ time: new Date('2026-09-28T06:12:00+02:00') });
  await clockedGeolocation(page);
  await page.goto('/');
  await startEvent(page, 'Człowiek z bronią');
  await page.getByRole('button', { name: 'Kilka godzin temu' }).click();
  await chooseHours(page, 3);
  // The step bar already shows Gdzie next, so no line announces it (ticket 29 filler cut).
  await expect(page.getByText('Potem wskażesz miejsce na mapie.')).toHaveCount(0);
  await footer(page).getByRole('button', { name: 'Dalej' }).click();
  await expect(heading(page, 'Gdzie to było?')).toBeVisible();
  await expect(page.locator('#where-next')).toContainText('Wskaż miejsce, aby przejść dalej.');
  await press(page, 'Dalej');
  await expect(page.getByRole('button', { name: 'Pokaż mapę' })).toBeFocused();
  await page.keyboard.press('Enter');
  await openMap(page);
  await expect(page.locator('.map-surface')).toHaveAttribute('aria-disabled', 'false');
  await page.locator('.map-surface').focus();
  await expect(heading(page, 'Gdzie to było?')).toBeVisible();
  await page.keyboard.press('Enter');
  const radius = page.getByLabel('Jak dokładnie?');
  await radius.focus();
  await page.keyboard.press('ArrowRight');
  await expect(page.locator('.range label')).toContainText('w promieniu około 750 m');
  await footer(page).getByRole('button', { name: 'Dalej' }).click();
  await expect(heading(page, 'Sprawdź i zapisz')).toBeVisible();
  await expect(page.locator('#when-row')).toContainText('Około 3 godz. przed 06:12');
  await expect(page.locator('#place-row')).toContainText('w promieniu około 750 m od wskazanego miejsca');
  await expect(page.locator('#home-check legend')).toHaveText('Czy to Twój dom lub podwórko?');
  await answerHome(page, false);
  const posted = await reportPost(page);
  await save(page);
  const payload = (await posted.request).postDataJSON();
  expect(payload.device_fix).toBeNull();
  expect(payload.incident_location.basis).toBe('reporter_selected_area');
  for (const side of metres(payload.incident_location.bounds)) expect(Math.abs(side - 1500)).toBeLessThan(3);
  expect(payload.occurred_at.coarseness).toBe('within_hours');
});

for (const label of ['Strzał', 'Człowiek z bronią', 'Szczątki w lesie', 'Ranne zwierzę', 'Kłusownictwo']) {
  test(`${label}: finish later sits in the footer on every step and keeps the Draft`, async ({ page, context }) => {
    await context.setGeolocation({ latitude: 52.1, longitude: 19.4, accuracy: 12 });
    await page.goto('/');
    await startEvent(page, label);
    const later = footer(page).getByRole('button', { name: 'Dokończę później' });
    await expect(later).toBeInViewport();
    await answerNow(page);
    if (label !== 'Szczątki w lesie') { await expect(later).toBeInViewport(); await leaveCompass(page); }
    await page.locator('.screen-body').evaluate(element => element.scrollTo(0, element.scrollHeight));
    await expect(later).toBeInViewport();
    await expect(footer(page).getByRole('button', { name: 'Zapisz zgłoszenie' })).toBeInViewport();
    await later.click();
    await expect(page.getByRole('heading', { name: 'Co się stało?' })).toBeVisible();
    await page.getByRole('button', { name: /^Dokończ zgłoszenie/ }).click();
    // Kiedy was answered, so the Draft resumes on Sprawdź.
    await expect(heading(page, 'Sprawdź i zapisz')).toBeVisible();
  });
}

test('Event types keep their photo rules, and Gatunek is asked only for remains and an injured animal', async ({ page, context }) => {
  await context.setGeolocation({ latitude: 52.1, longitude: 19.4, accuracy: 12 });
  const cases = [
    { label: 'Strzał', photos: 'none', species: false },
    { label: 'Człowiek z bronią', photos: 'optional', species: false },
    { label: 'Szczątki w lesie', photos: 'required', species: true },
    { label: 'Ranne zwierzę', photos: 'optional', species: true },
    { label: 'Kłusownictwo', photos: 'optional', species: false }
  ] as const;
  for (const item of cases) {
    await page.goto('/');
    await toReview(page, item.label);
    await expect(page.locator('summary', { hasText: 'Gatunek' })).toHaveCount(item.species ? 1 : 0);
    const takePhoto = page.getByRole('button', { name: 'Zrób zdjęcie' });
    if (item.photos === 'none') await expect(page.getByText('Zdjęcia', { exact: true })).toHaveCount(0);
    if (item.photos === 'required') {
      await expect(page.getByRole('heading', { name: 'Zdjęcie szczątków wymagane' })).toBeVisible();
      await expect(takePhoto).toBeVisible();
      await expect(page.getByText('Z galerii')).toBeVisible();
    }
    if (item.photos === 'optional') {
      await expect(takePhoto).toBeHidden();
      await page.locator('summary', { hasText: 'Zdjęcia' }).click();
      await expect(takePhoto).toBeVisible();
    }
    await footer(page).getByRole('button', { name: 'Dokończę później' }).click();
  }
});

test('Species search keeps unset apart from unknown and works from the keyboard', async ({ page, context }) => {
  await context.setGeolocation({ latitude: 52.2297, longitude: 21.0122, accuracy: 12 });
  await page.goto('/');
  await toReview(page, 'Ranne zwierzę', false);
  const summary = page.locator('summary', { hasText: 'Gatunek' });
  await expect(summary).toContainText('nie podano');
  await summary.focus();
  await page.keyboard.press('Enter');
  await expect(page.getByText('„Nie wiem” i „Nie podano” to różne odpowiedzi')).toHaveCount(0);
  const search = page.getByLabel('Szukaj gatunku');
  await search.fill('los');
  await expect(page.getByRole('radio', { name: 'Łoś' })).toBeVisible();
  await expect(page.getByRole('radio', { name: 'Dzik' })).toHaveCount(0);
  await search.fill('dzi');
  await page.keyboard.press('Tab');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('ArrowDown');
  await expect(page.getByRole('radio', { name: 'Dzik', exact: true })).toBeChecked();
  await expect(summary).toContainText('Dzik');
  await search.fill('');
  await page.getByRole('radio', { name: 'Nie wiem' }).check();
  await expect(summary).toContainText('Nie wiem');
  let posted = await reportPost(page);
  await save(page);
  expect((await posted.request).postDataJSON().species).toBe('unknown');

  await page.goto('/');
  await toReview(page, 'Ranne zwierzę', false);
  await page.locator('summary', { hasText: 'Gatunek' }).click();
  await page.getByRole('radio', { name: 'Sarna' }).check();
  await page.getByRole('radio', { name: 'Nie podano' }).check();
  posted = await reportPost(page);
  await save(page);
  expect((await posted.request).postDataJSON().species).toBeNull();
});

test('Zmień returns to Sprawdź, and a change that needs a point walks on to Gdzie', async ({ page, context }) => {
  await context.setGeolocation({ latitude: 52.2297, longitude: 21.0122, accuracy: 12 });
  await page.clock.install({ time: new Date('2026-09-28T06:12:00+02:00') });
  await clockedGeolocation(page);
  await page.goto('/');
  await toReview(page, 'Ranne zwierzę', false);
  await expect(page.locator('#when-row')).toContainText('Teraz, 06:12');
  await page.getByRole('button', { name: 'Zmień: Co' }).click();
  await expect(page.getByRole('heading', { name: 'Co się stało?' })).toBeVisible();
  await page.getByRole('button', { name: 'Kłusownictwo', exact: true }).click();
  // Another Event placed by direction asks its own question before coming back.
  await expect(heading(page, 'Gdzie to widzisz?')).toBeVisible();
  await footer(page).getByRole('button', { name: 'Pomiń' }).click();
  await expect(heading(page, 'Sprawdź i zapisz')).toBeVisible();
  await expect(page.locator('.review-row').first()).toContainText('Kłusownictwo');
  await page.getByRole('button', { name: 'Zmień: Co' }).click();
  await page.getByRole('button', { name: 'Strzał', exact: true }).click();
  await expect(heading(page, 'Skąd słychać strzał?')).toBeVisible();
  await footer(page).getByRole('button', { name: 'Pomiń' }).click();
  await expect(heading(page, 'Sprawdź i zapisz')).toBeVisible();
  await page.goBack();
  await expect(heading(page, 'Sprawdź i zapisz')).toHaveCount(0);
  await page.goForward();
  await expect(heading(page, 'Sprawdź i zapisz')).toBeVisible();
  await page.getByRole('button', { name: 'Zmień: Co' }).click();
  await page.getByRole('button', { name: 'Kłusownictwo', exact: true }).click();
  await footer(page).getByRole('button', { name: 'Pomiń' }).click();
  await expect(heading(page, 'Sprawdź i zapisz')).toBeVisible();
  await page.getByRole('button', { name: 'Zmień: Kiedy' }).click();
  await page.getByRole('button', { name: 'Innego dnia' }).click();
  await page.getByLabel('Którego dnia?').fill('2026-09-27');
  await footer(page).getByRole('button', { name: 'Dalej' }).click();
  await expect(heading(page, 'Gdzie to było?')).toBeVisible();
  await openMap(page);
  await expect(page.locator('.map-surface')).toHaveAttribute('aria-disabled', 'false');
  await page.locator('.map-surface').focus();
  await page.keyboard.press('Enter');
  await footer(page).getByRole('button', { name: 'Dalej' }).click();
  await expect(heading(page, 'Sprawdź i zapisz')).toBeVisible();
  await expect(page.locator('#when-row')).toContainText('Innego dnia, 27 września');
  // The place changed, so the home question is open again.
  await expect(page.locator('#draft-next')).toContainText('Odpowiedz na pytanie o dom.');
});

test('a wrong date is named beside its field and keeps Kiedy open', async ({ page, context }) => {
  await context.setGeolocation({ latitude: 52.2297, longitude: 21.0122, accuracy: 12 });
  await page.goto('/');
  await startEvent(page, 'Strzał');
  await page.getByRole('button', { name: 'Innego dnia' }).click();
  await page.getByLabel('Którego dnia?').fill('2099-01-01');
  await footer(page).getByRole('button', { name: 'Dalej' }).click();
  await expect(page.getByLabel('Którego dnia?')).toBeFocused();
  await expect(page.getByRole('alert')).toContainText('Wybierz dzień, który już minął albo jest dzisiaj.');
  await expect(heading(page, 'Kiedy to się stało?')).toBeVisible();
});

test('a save attempt names and focuses the first missing fact', async ({ page, context }) => {
  await context.setGeolocation({ latitude: 52.2297, longitude: 21.0122, accuracy: 12 });
  await page.goto('/');
  await toReview(page, 'Szczątki w lesie');
  await expect(page.locator('#draft-next')).toContainText('Odpowiedz na pytanie o dom.');
  await press(page, 'Zapisz zgłoszenie');
  await expect(page.locator('#home-check button').first()).toBeFocused();
  await expect(page.locator('#home-check')).toHaveClass(/missing/);
  await answerHome(page, false);
  await expect(page.locator('#draft-next')).toContainText('Dodaj zdjęcie szczątków.');
  await press(page, 'Zapisz zgłoszenie');
  await expect(page.locator('#photo-required')).toHaveClass(/missing/);
  await expect(heading(page, 'Sprawdź i zapisz')).toBeVisible();
});

test('steps keep their place across Back, Forward and reload with the same Draft', async ({ page, context }) => {
  await context.setGeolocation({ latitude: 52.2297, longitude: 21.0122, accuracy: 12 });
  await page.goto('/');
  await startEvent(page, 'Strzał');
  const draftId = new URL(page.url()).searchParams.get('draft');
  await answerNow(page);
  await leaveCompass(page);
  await page.goBack();
  await expect(heading(page, 'Skąd słychać strzał?')).toBeVisible();
  await page.goBack();
  await expect(heading(page, 'Kiedy to się stało?')).toBeVisible();
  await expect(page.getByRole('button', { name: /^Teraz/ })).toHaveAttribute('aria-pressed', 'true');
  await page.goForward();
  await page.goForward();
  await expect(heading(page, 'Sprawdź i zapisz')).toBeVisible();
  await page.reload();
  await expect(heading(page, 'Sprawdź i zapisz')).toBeVisible();
  expect(new URL(page.url()).searchParams.get('draft')).toBe(draftId);
  const saved = await page.evaluate(async id => {
    const request = indexedDB.open('bor-czuwa');
    const db = await new Promise<IDBDatabase>(resolve => { request.onsuccess = () => resolve(request.result); });
    const get = db.transaction('drafts').objectStore('drafts').get(id!);
    const draft = await new Promise<{ capturedAt: string; occurredMode: string }>(resolve => { get.onsuccess = () => resolve(get.result); });
    db.close();
    return draft;
  }, draftId);
  expect(saved.occurredMode).toBe('now');
  await expect(page.locator('#when-row')).toContainText(new Date(saved.capturedAt).toLocaleTimeString('pl-PL', { hour: '2-digit', minute: '2-digit' }));
});

test('a shot at the saved home cannot be sent as "not at home" without a place on the map', async ({ page, context }) => {
  await context.setGeolocation({ latitude: 52.2297, longitude: 21.0122, accuracy: 12 });
  await page.goto('/');
  // The app has created its stores once home is on screen.
  await expect(page.getByRole('heading', { name: 'Co się stało?' })).toBeVisible();
  await page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>(resolve => { const request = indexedDB.open('bor-czuwa'); request.onsuccess = () => resolve(request.result); });
    const transaction = db.transaction('home', 'readwrite');
    transaction.objectStore('home').put({ id: 'mine', fix: { lat: 52.2297, lon: 21.0122, accuracy_m: 12, at: new Date().toISOString() } });
    await new Promise(resolve => { transaction.oncomplete = resolve; });
    db.close();
  });
  await page.reload();
  await startEvent(page, 'Strzał');
  await answerNow(page);
  await setEstimate(page, 0, 1000);
  await leaveCompass(page);
  await page.getByRole('button', { name: 'Nie jestem w domu' }).click();
  // Direction and distance from this fix would lead back to the home.
  await expect(page.locator('#draft-next')).toContainText('Jesteś przy zapisanym domu. Zaznacz, że to Twój dom');
  let posts = 0;
  page.on('request', request => { if (request.method() === 'POST' && request.url().endsWith('/api/reports')) posts++; });
  await press(page, 'Zapisz zgłoszenie');
  await expect(page.locator('#home-check button').first()).toBeFocused();
  expect(posts).toBe(0);
  await answerHome(page, true);
  await expect(page.locator('#draft-next')).toHaveCount(0);
});

test('the hour wheel snaps to the hour a swipe ends on and keeps it in the Draft', async ({ page, context }) => {
  await context.setGeolocation({ latitude: 52.2297, longitude: 21.0122, accuracy: 12 });
  await page.clock.install({ time: new Date('2026-09-28T06:12:00+02:00') });
  await clockedGeolocation(page);
  await page.goto('/');
  await startEvent(page, 'Człowiek z bronią');
  await page.getByRole('button', { name: 'Kilka godzin temu' }).click();
  const wheel = page.getByRole('spinbutton', { name: 'Ile godzin temu?' });
  await expect(wheel).toHaveAttribute('aria-valuenow', '1');
  // It opens below the answers and brings itself into view.
  await expect(wheel).toBeInViewport({ ratio: 1 });
  const box = (await wheel.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  // A swipe of a little over three rows comes to rest on the nearest hour.
  await page.mouse.wheel(0, 3 * 56 + 20);
  await expect(wheel).toHaveAttribute('aria-valuenow', '4');
  await expect.poll(() => wheel.evaluate(element => Math.abs(element.scrollTop - 3 * 56))).toBeLessThan(2);
  // Tapping the hour below the band moves it into the band.
  await page.locator('.wheel button', { hasText: /^5 godz\.$/ }).click();
  await expect(wheel).toHaveAttribute('aria-valuenow', '5');
  await footer(page).getByRole('button', { name: 'Dalej' }).click();
  await page.goBack();
  await expect(page.getByRole('spinbutton', { name: 'Ile godzin temu?' })).toHaveAttribute('aria-valuenow', '5');
});
