import { test, expect, type Page } from '@playwright/test';
import { footer, openMap, answerHome, answerNow, heading, leaveCompass, press, reportPost, save, toReview } from './stages.ts';

test.use({ serviceWorkers: 'block' });

type SavedDraft = { id: string; eventType: number | null; capturedAt: string; fix?: { lat: number; lon: number }; note?: string };

async function draftsOnDevice(page: Page): Promise<SavedDraft[]> {
  return page.evaluate(async () => {
    const request = indexedDB.open('bor-czuwa');
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const transaction = db.transaction('drafts');
    const query = transaction.objectStore('drafts').getAll();
    const drafts = await new Promise<SavedDraft[]>((resolve, reject) => {
      query.onsuccess = () => resolve(query.result);
      query.onerror = () => reject(query.error);
    });
    db.close();
    return drafts;
  });
}

test.beforeEach(async ({ page }) => { await reportPost(page); });

for (const [eventType, label] of ['Strzał', 'Człowiek z bronią', 'Szczątki w lesie', 'Ranne zwierzę', 'Kłusownictwo'].entries()) {
  test(`quick Draft keeps record when ${label} is chosen`, async ({ page, context }) => {
    await context.setGeolocation({ latitude: 52.1, longitude: 19.4, accuracy: 12 });
    await page.goto('/');
    await page.getByRole('button', { name: 'Zapisz miejsce i czas' }).click();
    await expect(page.locator('#receipt strong', { hasText: 'Miejsce i czas zapisane' })).toBeVisible();
    const [original] = await draftsOnDevice(page);
    expect(original.fix).toMatchObject({ lat: 52.1, lon: 19.4 });
    await page.evaluate(async id => {
      const request = indexedDB.open('bor-czuwa');
      const db = await new Promise<IDBDatabase>(resolve => { request.onsuccess = () => resolve(request.result); });
      const transaction = db.transaction('drafts', 'readwrite');
      const store = transaction.objectStore('drafts');
      const get = store.get(id);
      const draft = await new Promise<SavedDraft>(resolve => { get.onsuccess = () => resolve(get.result); });
      store.put({ ...draft, note: 'Saved privately before Event choice' });
      await new Promise<void>(resolve => { transaction.oncomplete = () => resolve(); });
      db.close();
    }, original.id);
    await page.reload();
    await expect(page.locator('#receipt')).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Co się stało?' })).toBeVisible();
    await page.getByRole('button', { name: label, exact: true }).click();
    await expect(heading(page, 'Kiedy to się stało?')).toBeVisible();
    const [updated] = await draftsOnDevice(page);
    expect(updated).toMatchObject({ id: original.id, capturedAt: original.capturedAt,
      fix: original.fix, eventType, note: 'Saved privately before Event choice' });
    await answerNow(page);
    if (label !== 'Szczątki w lesie') await leaveCompass(page);
    await expect(page.locator('#report-note')).toHaveValue('Saved privately before Event choice');
  });
}

test('a shot cannot save before the home answer', async ({ page, context }) => {
  await context.setGeolocation({ latitude: 52.1, longitude: 19.4, accuracy: 12 });
  await page.goto('/');
  await toReview(page, 'Strzał');
  await expect(page.locator('#draft-next')).toContainText('Odpowiedz na pytanie o dom.');
  await press(page, 'Zapisz zgłoszenie');
  await expect(page.locator('#home-check button').first()).toBeFocused();
  expect(await draftsOnDevice(page)).toHaveLength(1);
  await answerHome(page, false);
  await expect(page.locator('#draft-next')).toHaveCount(0);
  await save(page);
  await expect(page.getByText('Zgłoszenie zapisane na urządzeniu.', { exact: true })).toBeVisible();
  expect(await draftsOnDevice(page)).toHaveLength(0);
});

test('missing required photo keeps remains Draft and focuses photo choice', async ({ page, context }) => {
  await context.setGeolocation({ latitude: 52.1, longitude: 19.4, accuracy: 12 });
  await page.goto('/');
  await toReview(page, 'Szczątki w lesie', false);
  await expect(page.locator('#draft-next')).toContainText('Dodaj zdjęcie szczątków.');
  await press(page, 'Zapisz zgłoszenie');
  await expect(page.locator('#photo-required button').first()).toBeFocused();
  expect(await draftsOnDevice(page)).toHaveLength(1);
});

test('invalid Occurrence time keeps shot Draft and focuses its change control', async ({ page, context }) => {
  await context.setGeolocation({ latitude: 52.1, longitude: 19.4, accuracy: 12 });
  await page.goto('/');
  await toReview(page, 'Strzał', false);
  // An hour count outside 1 to 24 can only come from an older Draft; Sprawdź still refuses it.
  const [draft] = await draftsOnDevice(page);
  await page.evaluate(async id => {
    const request = indexedDB.open('bor-czuwa');
    const db = await new Promise<IDBDatabase>(resolve => { request.onsuccess = () => resolve(request.result); });
    const transaction = db.transaction('drafts', 'readwrite');
    const store = transaction.objectStore('drafts');
    const get = store.get(id);
    const saved = await new Promise<Record<string, unknown>>(resolve => { get.onsuccess = () => resolve(get.result); });
    store.put({ ...saved, occurredMode: 'within_hours', hoursAgo: 0, manualLat: '52.1', manualLon: '19.4', pointRadiusM: 500, fromHome: false });
    await new Promise<void>(resolve => { transaction.oncomplete = () => resolve(); });
    db.close();
  }, draft.id);
  await page.reload();
  await expect(page.locator('#draft-next')).toContainText('Popraw czas zdarzenia.');
  await press(page, 'Zapisz zgłoszenie');
  await expect(page.getByRole('button', { name: 'Zmień: Kiedy' })).toBeFocused();
  expect(await draftsOnDevice(page)).toHaveLength(1);
});

test('unfinished coordinate entry cannot change the chosen place', async ({ page, context }) => {
  await context.setGeolocation({ latitude: 52.1, longitude: 19.4, accuracy: 12 });
  await page.goto('/');
  // Remains keep the recorded place until a different method is explicitly chosen.
  await toReview(page, 'Szczątki w lesie', false);
  await page.getByRole('button', { name: 'Zmień: Gdzie' }).click();
  await page.getByRole('button', { name: 'Wskaż miejsce', exact: true }).click();
  await openMap(page);
  await page.getByText('Wpisz współrzędne', { exact: true }).click();
  await page.getByLabel('Szerokość geograficzna').fill('52.2');
  await expect(page.getByRole('button', { name: 'Wskaż wpisany punkt' })).toBeDisabled();
  await expect(footer(page).getByRole('button', { name: 'Dalej', exact: true })).toHaveAttribute('aria-disabled', 'true');
  await page.getByRole('button', { name: 'Moje miejsce', exact: true }).click();
  await page.getByRole('button', { name: 'Dalej', exact: true }).click();
  await expect(page.locator('#place-row')).toContainText('tam, gdzie jesteś');
  const [draft] = await draftsOnDevice(page);
  expect(draft).not.toHaveProperty('manualLat');
});

test('old photo in shot Draft can be removed before creation', async ({ page, context }) => {
  await context.setGeolocation({ latitude: 52.1, longitude: 19.4, accuracy: 12 });
  await page.goto('/');
  await page.getByRole('button', { name: 'Zapisz miejsce i czas' }).click();
  await expect(page.locator('#receipt')).toBeVisible();
  const [original] = await draftsOnDevice(page);
  await page.evaluate(async id => {
    const request = indexedDB.open('bor-czuwa');
    const db = await new Promise<IDBDatabase>(resolve => { request.onsuccess = () => resolve(request.result); });
    const transaction = db.transaction('drafts', 'readwrite');
    const store = transaction.objectStore('drafts');
    const get = store.get(id);
    const draft = await new Promise<SavedDraft>(resolve => { get.onsuccess = () => resolve(get.result); });
    store.put({ ...draft, photos: [{ id: 'old-photo', jpeg: new Blob(['photo'], { type: 'image/jpeg' }), sha256: '0'.repeat(64) }] });
    await new Promise<void>(resolve => { transaction.oncomplete = () => resolve(); });
    db.close();
  }, original.id);
  await page.reload();
  await expect(page.locator('#receipt')).toBeVisible();
  await page.getByRole('button', { name: 'Strzał', exact: true }).click();
  await answerNow(page);
  await leaveCompass(page);
  await answerHome(page, false);
  await expect(page.locator('#draft-next')).toContainText('Dodaj wymagane zdjęcie lub usuń nadmiar zdjęć.');
  await press(page, 'Zapisz zgłoszenie');
  await expect(page.getByRole('button', { name: 'Usuń zdjęcie 1' })).toBeFocused();
  await page.getByRole('button', { name: 'Usuń zdjęcie 1' }).click();
  await expect(page.locator('#draft-next')).toHaveCount(0);
  await save(page);
  await expect(page.getByText('Zgłoszenie zapisane na urządzeniu.', { exact: true })).toBeVisible();
});

for (const [failure, message] of [
  ['QuotaExceededError', 'Brak miejsca na urządzeniu.'],
  ['AbortError', 'Nie udało się zapisać danych na urządzeniu.']
]) test(`IndexedDB ${failure} refusal keeps Draft and reports storage cause`, async ({ page, context }) => {
  await context.setGeolocation({ latitude: 52.1, longitude: 19.4, accuracy: 12 });
  await page.goto('/');
  await toReview(page, 'Człowiek z bronią', false);
  await page.evaluate(name => {
    const add = IDBObjectStore.prototype.add;
    IDBObjectStore.prototype.add = function (...args) {
      if (this.name === 'reports') throw new DOMException('Storage refused', name);
      return add.apply(this, args);
    };
  }, failure);
  await save(page);
  await expect(page.getByRole('alert')).toContainText(message);
  await expect(heading(page, 'Sprawdź i zapisz')).toBeVisible();
  expect(await draftsOnDevice(page)).toHaveLength(1);
});
