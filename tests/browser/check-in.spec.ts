import { test, expect, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { finishFromWhen, openNoticeRow, otherWays } from './stages.ts';
import { untilOfflineReady } from '../helpers/offline.ts';
import { demoRecipient, expectDemoDestination } from './demo.ts';

const points = JSON.parse(await readFile(new URL('../../data/fixtures/acceptance.json', import.meta.url), 'utf8'));
const day = 24 * 60 * 60 * 1000;
const police = 'Komenda Powiatowa Policji w Mońkach';

async function offlineReport(page: Page) {
  await page.goto('/');
  await untilOfflineReady(page);
  await page.context().setOffline(true);
  await page.reload();
  await page.getByRole('button', { name: 'Człowiek z bronią', exact: true }).click();
  await finishFromWhen(page, false);
  await page.getByRole('button', { name: 'Zapisz zgłoszenie' }).click();
}

async function pickPolice(page: Page, query: string, name: RegExp) {
  await page.getByRole('button', { name: 'Przygotuj powiadomienie' }).click();
  await page.getByRole('button', { name: 'Wybierz jednostkę po nazwie', exact: true }).click();
  await page.getByLabel('Nazwa lub miejscowość').fill(query);
  await page.getByRole('button', { name }).click();
  await page.getByRole('button', { name: 'Dalej: podpis' }).click();
}

const scrolls = (page: Page) => page.locator('.screen-body').evaluate(body => body.scrollHeight > body.clientHeight + 1);

test('an unsigned Notice uses its available handoff route and asks what happened', async ({ page, context }) => {
  await context.setGeolocation({ latitude: points.edge.point.lat, longitude: points.edge.point.lon, accuracy: 8 });
  await context.grantPermissions(['geolocation', 'clipboard-read', 'clipboard-write']);
  await offlineReport(page);
  await pickPolice(page, 'Kaliszu', /Komenda Miejska Policji w Kaliszu/);
  await page.getByRole('radio', { name: 'Bez podpisu' }).check();
  await page.getByRole('button', { name: 'Przygotuj powiadomienia' }).click();

  await expect(page.getByRole('heading', { level: 1, name: 'Komenda Miejska Policji w Kaliszu' })).toBeVisible();
  // One Notice: no "1 z 1" counter, but the signature state stays visible.
  await expect(page.locator('.notice-position')).toHaveText('Bez podpisu');
  const primary = page.locator('.screen-foot .primary');
  if (demoRecipient) {
    await expect(page.getByText('Brak potwierdzonego adresu', { exact: true })).toHaveCount(0);
    await expect(page.getByRole('link', { name: 'Otwórz stronę urzędu' })).toHaveCount(0);
    await expect(page.getByRole('link', { name: 'Otwórz w poczcie' })).toHaveAttribute('href', new RegExp(`^mailto:${demoRecipient.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\?`));
  } else {
    await expect(page.getByText('Brak potwierdzonego adresu', { exact: true })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Otwórz stronę urzędu' })).toHaveAttribute('href', /kalisz\.policja\.gov\.pl/);
    await expect(page.getByRole('link', { name: 'Otwórz w poczcie' })).toHaveCount(0);
  }
  await expect(primary).toHaveText(demoRecipient ? 'Otwórz w poczcie' : 'Kopiuj treść');
  const startHandoff = async () => {
    if (demoRecipient) {
      await otherWays(page);
      await page.getByRole('button', { name: 'Kopiuj treść', exact: true }).click();
      // A secondary copy is a utility, not a mail handoff or confirmation.
      await expect(page.getByRole('heading', { name: 'Udało się wysłać?' })).toHaveCount(0);
    }
    await primary.click();
  };

  await startHandoff();
  const body = await page.locator('.notice-body').textContent();
  expectDemoDestination(body ?? '');
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(body);
  await expect(page.getByRole('heading', { name: 'Udało się wysłać?' })).toBeVisible();
  const noticeEventKinds = () => page.evaluate(() => new Promise<string[]>((resolve, reject) => {
    const url = new URL(location.href);
    const reportId = url.searchParams.get('report');
    const noticeId = url.searchParams.get('notice');
    if (!reportId || !noticeId) { reject(new Error('Current Notice identity is missing')); return; }
    const opening = indexedDB.open('bor-czuwa');
    opening.onerror = () => reject(opening.error);
    opening.onsuccess = () => {
      const db = opening.result;
      const read = db.transaction('reports').objectStore('reports').get(reportId);
      read.onerror = () => { db.close(); reject(read.error); };
      read.onsuccess = () => {
        db.close();
        const notice = read.result?.notices?.find((item: { id: string }) => item.id === noticeId);
        if (!notice) { reject(new Error('Current Notice is not stored')); return; }
        resolve(notice.events.map((event: { kind: string }) => event.kind));
      };
    };
  }));
  const awaitingKinds = demoRecipient ? ['notice_composed', 'handed_to_mail_client'] : ['notice_composed'];
  await expect.poll(async () => new Set(await noticeEventKinds())).toEqual(new Set(awaitingKinds));
  // A lost clipboard can be copied again without answering first.
  await page.evaluate(() => navigator.clipboard.writeText(''));
  await otherWays(page);
  await page.getByRole('button', { name: 'Kopiuj treść' }).click();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(body);
  await expect(page.getByRole('heading', { name: 'Udało się wysłać?' })).toBeVisible();
  // A check-in link for a Notice not yet handed off opens the Notice instead.
  const notice = new URL(page.url());
  notice.searchParams.set('screen', 'check-in');
  await page.goto(notice.toString());
  await expect(page).toHaveURL(/screen=notice&/);
  await expect(page.getByRole('heading', { name: 'Udało się wysłać?' })).toBeVisible();
  // Cancelling keeps the Notice unconfirmed and brings the route back.
  await page.getByRole('button', { name: 'Jeszcze nie' }).click();
  await expect(page.getByRole('heading', { name: 'Udało się wysłać?' })).toHaveCount(0);
  await expect(primary).toHaveText(demoRecipient ? 'Otwórz w poczcie' : 'Kopiuj treść');

  // The question survives an interruption.
  await startHandoff();
  await expect(page.getByRole('heading', { name: 'Udało się wysłać?' })).toBeVisible();
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Udało się wysłać?' })).toBeVisible();
  await page.getByRole('button', { name: 'Potwierdzam przekazanie' }).click();
  await expect(page.locator('.brief-confirmation')).toHaveText('Zapisano Twoje potwierdzenie. To nie jest potwierdzenie doręczenia.');
  await expect.poll(async () => new Set(await noticeEventKinds())).toEqual(new Set([...awaitingKinds, 'confirmed_by_reporter']));
  await expect(primary).toHaveText('Gotowe');
  await expect(page.locator('.brief-confirmation')).toHaveCount(0, { timeout: 6_000 });
  await primary.click();
  await expect(page.getByRole('heading', { level: 1, name: /^Zgłoszenie/ })).toBeVisible();
});

test.describe('enabled six-week check-in', () => {
  test.skip(process.env.VITE_CHECK_IN_ENABLED !== 'true', 'Requires a build with VITE_CHECK_IN_ENABLED=true');

test('a due check-in opens from home, saves on one tap and asks again six weeks after "Jeszcze nie"', async ({ page, context }) => {
  await context.setGeolocation({ latitude: points.edge.point.lat, longitude: points.edge.point.lon, accuracy: 8 });
  await offlineReport(page);
  await pickPolice(page, 'Monkach', /Komenda Powiatowa Policji w Mońkach/);
  await page.getByRole('radio', { name: 'Z podpisem' }).check();
  await page.getByLabel('Imię i nazwisko').fill('Anna Nowak');
  await page.getByLabel('Adres do korespondencji').fill('Leśna 1');
  await page.getByRole('button', { name: 'Przygotuj powiadomienia' }).click();
  await openNoticeRow(page);
  await page.getByRole('link', { name: 'Otwórz w poczcie' }).click();
  await page.getByRole('button', { name: 'Potwierdzam przekazanie' }).click();
  // Online, so the Report syncs and its check-in can fall due.
  await context.setOffline(false);
  await page.getByRole('button', { name: 'Moje zapisy' }).click();
  // An accepted Report's row says nothing about the server, so wait for its sync line to go.
  await expect(page.locator('.history')).toBeVisible();
  await expect(page.locator('.history')).not.toContainText(/Zapisuje się|Czeka na internet|Serwer chwilowo/, { timeout: 30_000 });

  const now = Date.now();
  await page.clock.setFixedTime(new Date(now + 43 * day));
  await page.reload();
  await page.getByRole('button', { name: 'Bór czuwa' }).click();
  const card = page.locator('.continuation .record-main');
  await expect(card).toContainText('Czy Policja odpowiedziała?');
  // Budget from home: two screens, two taps, no swipes.
  await card.click();
  const question = page.getByRole('heading', { level: 1, name: `Czy ${police} odpowiedziała?` });
  await expect(question).toBeVisible();
  for (const name of ['Przyszła odpowiedź', 'Wszczęto postępowanie', 'Odmowa', 'Jeszcze nie']) {
    await expect(page.getByRole('button', { name, exact: true })).toBeVisible();
  }
  await expect(page.locator('main input, main select, main textarea')).toHaveCount(0);
  for (const name of ['Pobierz PDF', 'Otwórz w poczcie', 'Zgłoś adres do sprawdzenia']) await expect(page.getByText(name)).toHaveCount(0);
  await expect(page.getByText('Nie można przygotować powiadomienia dla tego zdarzenia.')).toHaveCount(0);
  expect(await scrolls(page)).toBe(false);
  expect(page.url()).not.toMatch(/Nowak|Le%C5%9Bna|Leśna/);

  // Opening it never answers it.
  await page.getByRole('button', { name: 'Wróć' }).click();
  await expect(card).toContainText('Czy Policja odpowiedziała?');
  await card.click();
  await page.getByRole('button', { name: 'Jeszcze nie', exact: true }).click();
  const saved = page.locator('#check-in-saved');
  await expect(saved).toContainText('Zapisano: jeszcze bez odpowiedzi');
  await expect(saved).toContainText('Przypomnienie zostaje. Zapytamy znowu.');
  await expect(saved).toBeFocused();
  await page.locator('.screen-foot .primary', { hasText: 'Gotowe' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Co się stało?' })).toBeVisible();
  await expect(page.locator('.continuation')).toHaveCount(0);

  // Six weeks after that answer the check-in is due again; this time from Moje zapisy.
  await page.clock.setFixedTime(new Date(now + 86 * day));
  await page.reload();
  await page.getByRole('button', { name: 'Moje zapisy' }).click();
  await page.getByRole('button', { name: /^Czy Policja odpowiedziała\?/ }).click();
  await expect(question).toBeVisible();
  await page.getByRole('button', { name: 'Wszczęto postępowanie', exact: true }).click();
  await expect(saved).toContainText('Zapisano: wszczęto postępowanie');
  await expect(saved).toContainText('Data:');
  await page.getByRole('button', { name: 'Zmień datę' }).click();
  const yesterday = new Date(now + 85 * day).toISOString().slice(0, 10);
  await page.getByLabel('Kiedy przyszła odpowiedź?').fill(yesterday);
  await expect(page.getByRole('button', { name: 'Zmień datę' })).toBeVisible();
  await page.reload();
  await expect(saved).toContainText('Zapisano: wszczęto postępowanie');
  await page.getByRole('button', { name: 'Zmień odpowiedź' }).click();
  await expect(question).toBeFocused();
  await page.getByRole('button', { name: 'Wszczęto postępowanie', exact: true }).click();
  await expect(saved).toBeFocused();

  await page.getByRole('button', { name: 'Pokaż powiadomienie i korespondencję' }).click();
  await expect(page.getByRole('heading', { level: 1, name: police })).toBeVisible();
  await page.locator('summary', { hasText: 'Wynik zgłoszony przez Ciebie' }).click();
  const history = page.locator('.outcome-section li');
  await expect(history).toHaveCount(4);
  await expect(history.nth(0)).toContainText('Jeszcze bez odpowiedzi');
  await expect(history.nth(2)).toContainText(`${yesterday}: Wszczęto postępowanie`);
  await expect(page.getByText('Przypomnienie o sprawdzeniu odpowiedzi', { exact: false })).toHaveCount(0);
});

test('on Android a "Jeszcze nie" answered early moves the pending check-in reminder', async ({ page, context }) => {
  await page.clock.install({ time: new Date('2026-10-01T12:00:00Z') });
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Co się stało?' })).toBeVisible();
  await page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>(resolve => {
      const request = indexedDB.open('bor-czuwa');
      request.onsuccess = () => resolve(request.result);
    });
    const tx = db.transaction('reports', 'readwrite');
    const base = { notice_id: 'notice-early', recipient_kind: 'police', unit_id: 'police' };
    tx.objectStore('reports').put({
      report: { id: 'report-early', event_type: 'person_with_gun', captured_at: '2026-09-01T12:00:00Z',
        occurred_at: { at: '2026-09-01T12:00:00Z', coarseness: 'exact' },
        incident_location: { lat: 52, lon: 21, source: 'device_fix' }, species: null, photo_sha256: [], has_note: false },
      token: 'fixture', findings: { status: 'pending' },
      events: [{ kind: 'created', at: '2026-09-01T12:00:00Z' }, { kind: 'synced', at: '2026-09-01T12:00:00Z' }],
      notices: [{ id: 'notice-early', recipient: { id: 'police', name: 'Policja', kind: 'police' }, others: [], variant: 'signed',
        events: [{ ...base, id: 'confirmation-early', kind: 'confirmed_by_reporter', at: '2026-09-01T12:00:00.000Z', synced: true }],
        outcomes: [{ ...base, id: 'outcome-early', kind: 'outcome_reported', outcome: 'no_answer_yet', observed_on: '2026-09-20',
          at: '2026-09-20T12:00:00.000Z', synced: true }] }]
    });
    await new Promise<void>(resolve => { tx.oncomplete = () => resolve(); });
    db.close();
  });
  await context.addInitScript(() => {
    const native = window as any;
    native.androidBridge = {};
    // Pending for six weeks after the confirmation, as scheduled before the Reporter answered.
    const pending = [{ id: 1, title: 'Bór czuwa', body: 'Sprawdź, czy urząd odpowiedział na Twoje powiadomienie.',
      schedule: { at: '2026-10-13T12:00:00.000Z' }, extra: { followUpNoticeId: 'notice-early' } }];
    native.scheduledReminders = [];
    native.Capacitor = {
      PluginHeaders: [
        { name: 'LocalNotifications', methods: ['getPending', 'schedule', 'cancel', 'getDeliveredNotifications',
          'removeDeliveredNotificationsById'].map(name => ({ name, rtype: 'promise' })) },
        { name: 'App', methods: [{ name: 'addListener', rtype: 'callback' }, { name: 'removeListener', rtype: 'promise' }] }
      ],
      nativeCallback: () => 'listener',
      nativePromise: async (_plugin: string, method: string, options: any) => {
        if (method === 'getPending') return { notifications: pending };
        if (method === 'getDeliveredNotifications') return { notifications: [] };
        if (method === 'schedule') native.scheduledReminders.push(...JSON.parse(JSON.stringify(options.notifications)));
        return {};
      }
    };
  });
  await page.reload();
  await expect.poll(() => page.evaluate(() => (window as any).scheduledReminders.length)).toBe(1);
  expect(await page.evaluate(() => (window as any).scheduledReminders)).toMatchObject([
    { title: 'Bór czuwa', channelId: 'follow-up-checks', schedule: { at: '2026-11-01T12:00:00.000Z' }, extra: { followUpNoticeId: 'notice-early' } }
  ]);
});

});
