import { test, expect, type Page } from '@playwright/test';
import { appendFile } from 'node:fs/promises';
import { answerHome, answerNow, clockedGeolocation, footer, heading, openNoticeRow, pastCompass, startEvent } from './stages.ts';

// Every time on screen is Warsaw time, the clock the Notice uses, whatever zone the phone is set to.
test.use({ serviceWorkers: 'block' });

const zones = ['Europe/Warsaw', 'America/New_York', 'Asia/Tokyo'];
// With TIME_ZONE_DUMP set, every string a case read is appended there as one JSON line, so runs on two builds can be diffed.
const record = (key: string, value: unknown) => process.env.TIME_ZONE_DUMP ? appendFile(process.env.TIME_ZONE_DUMP, `${JSON.stringify({ key, value })}\n`) : undefined;

async function seedReports(page: Page, times: string[]) {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Co się stało?' })).toBeVisible();
  await page.evaluate(async times => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('bor-czuwa');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const tx = db.transaction('reports', 'readwrite');
    for (const at of times) tx.objectStore('reports').put({
      report: { id: `r-${at}`, event_type: 'shot', captured_at: at, occurred_at: { at, coarseness: 'exact' }, device_fix: { lat: 52, lon: 21, accuracy_m: 8, at },
        incident_location: { lat: 52, lon: 21, source: 'device_fix' }, species: null, photo_sha256: [], has_note: false },
      token: 'fixture', findings: { status: 'pending' }, events: [{ kind: 'created', at }, { kind: 'synced', at }]
    });
    await new Promise<void>((resolve, reject) => { tx.oncomplete = () => resolve(); tx.onerror = () => reject(tx.error); });
    db.close();
  }, times);
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Co się stało?' })).toBeVisible();
  await page.getByRole('button', { name: 'Moje zapisy', exact: true }).click();
}

type Case = { name: string; now: string; at: string; day: string; time: string; date: string; weekday: string; month: string };
// Expected strings are what a phone in Warsaw shows. Each case is one Warsaw calendar fact a device-local clock gets wrong somewhere.
const cases: Case[] = [
  { name: 'captured 23:30 Warsaw yesterday', now: '2026-11-13T10:00:00Z', at: '2026-11-12T22:30:00Z', day: 'wczoraj', time: '23:30', date: '12', weekday: 'czw.', month: 'Listopad 2026' },
  { name: 'captured 00:30 Warsaw today', now: '2026-11-13T10:00:00Z', at: '2026-11-12T23:30:00Z', day: 'dziś', time: '00:30', date: '13', weekday: 'pt.', month: 'Listopad 2026' },
  { name: 'the night the clocks go back', now: '2026-10-25T10:00:00Z', at: '2026-10-24T22:30:00Z', day: 'dziś', time: '00:30', date: '25', weekday: 'niedz.', month: 'Październik 2026' },
  { name: 'the day after the clocks go back', now: '2026-10-26T10:00:00Z', at: '2026-10-24T22:30:00Z', day: 'wczoraj', time: '00:30', date: '25', weekday: 'niedz.', month: 'Październik 2026' },
  { name: 'a month that starts at 00:30 Warsaw time', now: '2026-12-10T10:00:00Z', at: '2026-11-30T23:30:00Z', day: '1 grudnia', time: '00:30', date: '1', weekday: 'wt.', month: 'Grudzień 2026' },
  { name: 'new year already begun in Tokyo, not in Warsaw', now: '2026-12-31T20:00:00Z', at: '2026-12-29T10:00:00Z', day: '29 grudnia', time: '11:00', date: '29', weekday: 'wt.', month: 'Grudzień 2026' },
  { name: 'captured 31 December 23:30 Warsaw, viewed 1 January Warsaw (Tokyo and New York read a different day)', now: '2027-01-01T00:30:00Z', at: '2026-12-31T22:30:00Z', day: 'wczoraj', time: '23:30', date: '31', weekday: 'czw.', month: 'Grudzień 2026' },
  { name: 'captured 31 December 23:30 Warsaw, viewed 2 January: the year shows', now: '2027-01-02T10:00:00Z', at: '2026-12-31T22:30:00Z', day: '31 grudnia 2026', time: '23:30', date: '31', weekday: 'czw.', month: 'Grudzień 2026' },
  { name: 'new year, Warsaw has begun it too', now: '2026-12-31T23:30:00Z', at: '2026-12-29T10:00:00Z', day: '29 grudnia 2026', time: '11:00', date: '29', weekday: 'wt.', month: 'Grudzień 2026' }
];

// The same stored Report and Draft are made once, in Warsaw, and reopened in every zone from a copy of that browser storage.
// TIME_ZONE_STATE_URL names the build that makes them (it needs the API for recipients); the zones read them on the build under test.
test('one stored Report and Draft read the same in every zone, and the Report time is the Notice time', async ({ browser }, testInfo) => {
  test.setTimeout(240_000);
  const readUrl = String(testInfo.project.use.baseURL);
  const stateUrl = process.env.TIME_ZONE_STATE_URL ?? readUrl;
  const storage = (origin: string) => ({ cookies: [], origins: [{ origin, localStorage: [{ name: 'first-launch-seen', value: '1' }] }] });
  const maker = await browser.newContext({ baseURL: stateUrl, locale: 'pl-PL', timezoneId: 'Europe/Warsaw', viewport: { width: 390, height: 844 }, serviceWorkers: 'block',
    permissions: ['geolocation'], geolocation: { latitude: 53.45, longitude: 22.8, accuracy: 8 }, storageState: storage(stateUrl) });
  const make = await maker.newPage();
  await make.route('**/api/challenge', route => route.abort());
  await make.clock.setFixedTime(new Date('2026-11-12T17:54:00Z'));
  await clockedGeolocation(make);
  await make.goto('/');
  await startEvent(make, 'Człowiek z bronią');
  await answerNow(make);
  await pastCompass(make);
  await answerHome(make, false);
  await footer(make).getByRole('button', { name: 'Zapisz zgłoszenie' }).click();
  await expect(heading(make, 'Zgłoszenie')).toBeVisible();
  await make.getByRole('button', { name: 'Przygotuj powiadomienie' }).click();
  await make.getByRole('button', { name: 'Dalej: podpis' }).click();
  await make.getByRole('radio', { name: 'Bez podpisu' }).check();
  await make.getByRole('button', { name: 'Przygotuj powiadomienia' }).click();
  await expect(make.locator('.notice-body')).toBeAttached();
  await make.getByRole('button', { name: 'Moje zapisy', exact: true }).click();
  await make.goto('/');
  await startEvent(make, 'Strzał');
  await answerNow(make);
  await pastCompass(make);
  await answerHome(make, false);
  await expect(heading(make, 'Sprawdź i zapisz')).toBeVisible();
  // The Draft says it happened about 2 hours before it was captured, the audit's case.
  await make.evaluate(async () => {
    const db = await new Promise<IDBDatabase>(resolve => { const request = indexedDB.open('bor-czuwa'); request.onsuccess = () => resolve(request.result); });
    const store = db.transaction('drafts', 'readwrite').objectStore('drafts');
    const drafts = await new Promise<any[]>(resolve => { const request = store.getAll(); request.onsuccess = () => resolve(request.result); });
    await new Promise<void>(resolve => { const tx = db.transaction('drafts', 'readwrite'); tx.objectStore('drafts').put({ ...drafts[0], occurredMode: 'within_hours', hoursAgo: 2, manualLat: '52.1', manualLon: '19.4', pointRadiusM: 500, fromHome: false }); tx.oncomplete = () => resolve(); });
    db.close();
  });
  const state = await maker.storageState({ indexedDB: true });
  await maker.close();

  const seen: Record<string, unknown> = {};
  for (const zone of zones) {
    const reader = await browser.newContext({ baseURL: readUrl, locale: 'pl-PL', timezoneId: zone, viewport: { width: 390, height: 844 }, serviceWorkers: 'block',
      storageState: { ...state, origins: state.origins.map(origin => ({ ...origin, origin: readUrl })) } });
    const page = await reader.newPage();
    await page.route('**/api/**', route => route.abort());
    await page.clock.setFixedTime(new Date('2026-11-12T19:00:00Z'));
    await page.goto('/');
    await page.getByRole('button', { name: 'Moje zapisy', exact: true }).click();
    const draftRow = page.getByRole('button', { name: /^Dokończ zgłoszenie/ });
    const draftSub = await draftRow.innerText();
    const reportRow = page.locator('.history-month .record-main');
    const rowLabel = await reportRow.getAttribute('aria-label');
    const rowTime = await reportRow.locator('.record-copy small').first().innerText();
    await draftRow.click();
    await expect(heading(page, 'Sprawdź i zapisz')).toBeVisible();
    const kiedy = await page.locator('#when-row .value').innerText();
    await page.goto('/');
    await page.getByRole('button', { name: 'Moje zapisy', exact: true }).click();
    await reportRow.click();
    await expect(heading(page, 'Zgłoszenie')).toBeVisible();
    const header = await page.locator('.ref-event small').innerText();
    await page.getByRole('button', { name: 'Powiadomienia do urzędów' }).click();
    await openNoticeRow(page);
    const notice = ((await page.locator('.notice-body').textContent()) ?? '').replace(/\s+/g, ' ');
    const noticeTime = notice.match(/Czas zdarzenia: (.+?)\./)![1];
    seen[zone] = { draftSub, rowLabel, rowTime, kiedy, header, noticeTime };
    await record(`same record ${zone}`, seen[zone]);
    expect(header, `${zone}: Report header is the Notice time`).toBe(noticeTime);
    await reader.close();
  }
  expect(seen['America/New_York']).toEqual(seen['Europe/Warsaw']);
  expect(seen['Asia/Tokyo']).toEqual(seen['Europe/Warsaw']);
  expect(seen['Europe/Warsaw']).toMatchObject({ header: '12 listopada 2026 18:54', rowTime: expect.stringMatching(/^18:54/), kiedy: 'Około 2 godz. przed 18:54' });
});

for (const zone of zones) test.describe(zone, () => {
  test.use({ timezoneId: zone });

  test('a Report and a Draft show the Notice event time, not the device clock', async ({ page, context }) => {
    await context.setGeolocation({ latitude: 53.45, longitude: 22.8, accuracy: 8 });
    await page.route('**/api/challenge', route => route.abort());
    await page.clock.setFixedTime(new Date('2026-11-12T17:54:00Z'));
    await clockedGeolocation(page);
    await page.goto('/');
    await startEvent(page, 'Człowiek z bronią');
    const teraz = await page.getByRole('button', { name: /^Teraz/ }).locator('small').innerText();
    expect(teraz).toBe('zapisano o 18:54');
    await page.getByRole('button', { name: /^Teraz/ }).click();
    await pastCompass(page);
    await answerHome(page, false);
    const kiedy = await page.locator('#when-row .value').innerText();
    expect(kiedy).toBe('Teraz, 18:54');
    await footer(page).getByRole('button', { name: 'Zapisz zgłoszenie' }).click();
    await expect(heading(page, 'Zgłoszenie')).toBeVisible();
    const header = await page.locator('.ref-event small').innerText();
    expect(header).toBe('12 listopada 2026 18:54');
    await page.getByRole('button', { name: 'Gotowe, wróć do początku' }).click();
    await page.getByRole('button', { name: 'Moje zapisy', exact: true }).click();
    const row = page.getByRole('button', { name: /^Człowiek z bronią, / });
    await expect(row.locator('.record-copy small').first()).toHaveText('18:54');
    await record(`flow ${zone}`, { teraz, kiedy, header, row: await row.getAttribute('aria-label') });
  });

  for (const c of cases) test(`record list: ${c.name}`, async ({ page }) => {
    await page.clock.setFixedTime(new Date(c.now));
    await seedReports(page, [c.at]);
    const row = page.locator('.history-month .record-main');
    await expect(row).toHaveCount(1);
    const label = await row.getAttribute('aria-label');
    const shown = { label, time: await row.locator('.record-copy small').first().innerText(), date: await row.locator('.date-col b').innerText(),
      weekday: await row.locator('.date-col span').innerText(), month: await page.locator('.history-month h3').innerText() };
    await record(`${c.name} ${zone}`, shown);
    expect(shown).toEqual({ label: `Strzał, ${c.day} ${c.time}`, time: c.time, date: c.date, weekday: c.weekday, month: c.month });
    await row.click();
    await expect(heading(page, 'Zgłoszenie')).toBeVisible();
    const header = await page.locator('.ref-event small').innerText();
    expect(header).toMatch(new RegExp(` ${c.time}$`));
  });

  test('Reports from 23:30 on 30 November and 00:30 on 1 December Warsaw time sit in two month groups', async ({ page }) => {
    await page.clock.setFixedTime(new Date('2026-12-10T10:00:00Z'));
    await seedReports(page, ['2026-11-30T22:30:00Z', '2026-11-30T23:30:00Z']);
    await expect(page.locator('.history-month h3')).toHaveText(['Grudzień 2026', 'Listopad 2026']);
    await expect(page.locator('.history-month').first().locator('.record-main')).toHaveCount(1);
    await expect(page.locator('.history-month').first().locator('.record-copy small').first()).toHaveText('00:30');
    await expect(page.locator('.history-month').last().locator('.record-copy small').first()).toHaveText('23:30');
  });
});
