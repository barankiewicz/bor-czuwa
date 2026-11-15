import { test, expect } from '@playwright/test';

test('disabled check-in hides due work, cancels only its reminders and preserves Notice history', async ({ page, context }) => {
  test.skip(process.env.VITE_CHECK_IN_ENABLED === 'true', 'Requires the default disabled build');
  await page.route('**/api/**', route => route.abort());
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
      report: { id: 'report-early', event_type: 'person_with_gun', captured_at: '2026-06-01T12:00:00Z',
        occurred_at: { at: '2026-06-01T12:00:00Z', coarseness: 'exact' },
        incident_location: { lat: 52, lon: 21, source: 'device_fix' }, species: null, photo_sha256: [], has_note: false },
      token: 'fixture', findings: { status: 'pending' },
      events: [{ kind: 'created', at: '2026-06-01T12:00:00Z' }, { kind: 'synced', at: '2026-06-01T12:00:00Z' }],
      notices: [{ id: 'notice-early', recipient: { id: 'police', name: 'Policja', kind: 'police' }, others: [], variant: 'signed',
        events: [{ ...base, id: 'confirmation-early', kind: 'confirmed_by_reporter', at: '2026-06-01T12:00:00.000Z', synced: true }],
        outcomes: [{ ...base, id: 'outcome-early', kind: 'outcome_reported', outcome: 'no_answer_yet', observed_on: '2026-07-20',
          at: '2026-07-20T12:00:00.000Z', synced: true }] }]
    });
    await new Promise<void>(resolve => { tx.oncomplete = () => resolve(); });
    db.close();
  });

  const readNotice = () => page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>(resolve => {
      const request = indexedDB.open('bor-czuwa');
      request.onsuccess = () => resolve(request.result);
    });
    const notice = await new Promise(resolve => {
      const request = db.transaction('reports').objectStore('reports').get('report-early');
      request.onsuccess = () => resolve(request.result.notices[0]);
    });
    db.close();
    return notice;
  });
  const before = await readNotice();
  await context.addInitScript(() => {
    const native = window as any;
    native.androidBridge = {};
    native.cancelled = [];
    native.dismissed = [];
    native.scheduled = [];
    native.Capacitor = {
      PluginHeaders: [
        { name: 'LocalNotifications', methods: ['getPending', 'schedule', 'cancel', 'getDeliveredNotifications',
          'removeDeliveredNotificationsById'].map(name => ({ name, rtype: 'promise' })) },
        { name: 'App', methods: [{ name: 'addListener', rtype: 'callback' }, { name: 'removeListener', rtype: 'promise' }] }
      ],
      nativeCallback: () => 'listener',
      nativePromise: async (_plugin: string, method: string, options: any) => {
        if (method === 'getPending') return { notifications: [
          { id: 1, extra: { followUpNoticeId: 'notice-early' } },
          { id: 2, extra: { followUpNoticeId: 'notice-no-longer-on-phone' } },
          { id: 3, extra: { unrelated: true } }
        ] };
        if (method === 'getDeliveredNotifications') return { notifications: [
          { id: 4, extra: { followUpNoticeId: 'notice-early' } }, { id: 5 }
        ] };
        if (method === 'cancel') native.cancelled.push(...options.notifications);
        if (method === 'removeDeliveredNotificationsById') native.dismissed.push(...options.ids);
        if (method === 'schedule') native.scheduled.push(...options.notifications);
        return {};
      }
    };
  });
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Co się stało?' })).toBeVisible();
  await expect(page.locator('.continuation')).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => (window as any).cancelled)).toEqual([{ id: 1 }, { id: 2 }]);
  expect(await page.evaluate(() => (window as any).dismissed)).toEqual([4]);
  expect(await page.evaluate(() => (window as any).scheduled)).toEqual([]);
  await page.getByRole('button', { name: 'Moje zapisy' }).click();
  await expect(page.locator('.history')).toBeVisible();
  await expect(page.getByRole('button', { name: /Czy Policja odpowiedziała/ })).toHaveCount(0);
  await page.goto('/?screen=check-in&report=report-early&notice=notice-early');
  await expect(page).toHaveURL(/screen=notice&/);
  await expect(page.getByRole('heading', { level: 1, name: 'Policja' })).toBeVisible();
  await page.locator('summary', { hasText: 'Wynik zgłoszony przez Ciebie' }).click();
  await expect(page.getByText('Przypomnienie o sprawdzeniu odpowiedzi', { exact: false })).toHaveCount(0);
  await expect(page.locator('.outcome-section li')).toContainText('Jeszcze bez odpowiedzi');
  expect(await readNotice()).toEqual(before);
  await page.goto('/?screen=notices&report=report-early');
  await expect(page.getByRole('heading', { name: 'Powiadomienia do urzędów' })).toBeVisible();
  await expect(page.getByText('Sprawdź, czy urząd odpowiedział.', { exact: true })).toHaveCount(0);
});
