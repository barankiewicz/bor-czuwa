import { test, expect } from '@playwright/test';
import { demoRecipient, openLegalDraft } from './demo.ts';

test('the public name stays Bór czuwa in both languages and legal pages', async ({ page, context }) => {
  const staging = process.env.TEST_CANDIDATE_MODE !== 'production';
  const suffix = demoRecipient ? ' · TEST' : staging ? ' · staging' : '';
  await context.addInitScript(() => localStorage.removeItem('first-launch-seen'));
  await page.goto('/');
  const brand = page.getByRole('banner').getByRole('button', { name: 'Bór czuwa', exact: true });
  await expect(brand).toBeVisible();
  await expect(page).toHaveTitle(`Bór czuwa${suffix}`);
  if (staging) await expect(page.locator('meta[name="robots"]')).toHaveAttribute('content', 'noindex, nofollow');
  else await expect(page.locator('meta[name="robots"][content*="noindex"]')).toHaveCount(0);
  await page.getByRole('button', { name: 'English', exact: true }).click();
  await expect(brand).toBeVisible();
  await expect(page).toHaveTitle(`Bór czuwa${suffix}`);
  await page.getByRole('button', { name: 'Polski', exact: true }).click();
  await page.getByRole('link', { name: 'Regulamin serwisu', exact: true }).click();
  await expect(page).toHaveTitle(demoRecipient ? 'Prywatny test · Regulamin serwisu · Bór czuwa' : `Regulamin serwisu · Bór czuwa${suffix}`);
  await openLegalDraft(page);
  await expect(page.getByText('Bór czuwa pozwala', { exact: false })).toBeVisible();
  await page.getByRole('link', { name: 'polityka prywatności', exact: true }).click();
  await expect(page).toHaveTitle(demoRecipient ? 'Prywatny test · Polityka prywatności · Bór czuwa' : `Polityka prywatności · Bór czuwa${suffix}`);
});

test('the browser tab loads the product icon', async ({ page }) => {
  await page.goto('/');
  const icon = page.locator('link[rel="icon"]');
  await expect(icon).toHaveAttribute('href', /.+/);
  const response = await page.request.get((await icon.getAttribute('href'))!);
  expect(response.ok()).toBe(true);
  expect(response.headers()['content-type']).toMatch(/^image\//);
});

test('an app update refreshes pending reminder titles without moving their due time', async ({ page, context }) => {
  await page.clock.install({ time: new Date('2026-10-01T12:00:00Z') });
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Co się stało?' })).toBeVisible();
  await page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>(resolve => {
      const request = indexedDB.open('bor-czuwa');
      request.onsuccess = () => resolve(request.result);
    });
    const tx = db.transaction(['drafts', 'reports'], 'readwrite');
    tx.objectStore('drafts').put({ id: 'draft-brand', eventType: null, capturedAt: '2026-10-01T12:00:00Z' });
    tx.objectStore('reports').put({
      report: { id: 'report-brand', event_type: 'person_with_gun', captured_at: '2026-10-01T12:00:00Z',
        occurred_at: { at: '2026-10-01T12:00:00Z', coarseness: 'exact' },
        incident_location: { lat: 52, lon: 21, source: 'device_fix' }, species: null, photo_sha256: [], has_note: false },
      token: 'fixture', findings: { status: 'pending' },
      events: [{ kind: 'created', at: '2026-10-01T12:00:00Z' }, { kind: 'synced', at: '2026-10-01T12:00:00Z' }],
      notices: [{ id: 'notice-brand', recipient: { id: 'police', name: 'Policja', kind: 'police' },
        others: [], variant: 'signed', events: [{ id: 'confirmation-brand', notice_id: 'notice-brand',
          kind: 'confirmed_by_reporter', at: '2026-10-01T12:00:00.123Z', synced: true }] }]
    });
    await new Promise<void>(resolve => { tx.oncomplete = () => resolve(); });
    db.close();
  });
  await context.addInitScript(() => {
    const native = window as any;
    native.androidBridge = {};
    const pending = [
      { id: 327993780, title: 'Zgłoś myśliwego', body: 'Dokończ zapisany szkic.',
        schedule: { at: '2026-10-02T07:00:00.000Z' }, extra: { draftId: 'draft-brand' } },
      { id: 1047422860, title: 'Zgłoś myśliwego', body: 'Sprawdź, czy urząd odpowiedział na Twoje powiadomienie.',
        schedule: { at: '2026-11-12T12:00:00.123Z' }, extra: { followUpNoticeId: 'notice-brand' } }
    ];
    native.scheduledReminders = [];
    native.Capacitor = {
      PluginHeaders: [
        { name: 'LocalNotifications', methods: ['getPending', 'schedule', 'cancel', 'getDeliveredNotifications',
          'removeDeliveredNotificationsById', 'checkPermissions', 'checkExactNotificationSetting', 'registerActionTypes']
          .map(name => ({ name, rtype: 'promise' })) },
        { name: 'App', methods: [{ name: 'addListener', rtype: 'callback' }, { name: 'removeListener', rtype: 'promise' }] }
      ],
      nativeCallback: () => 'listener',
      nativePromise: async (_plugin: string, method: string, options: any) => {
        if (method === 'getPending') return { notifications: pending };
        if (method === 'checkPermissions') return { display: 'granted' };
        if (method === 'checkExactNotificationSetting') return { exact_alarm: 'granted' };
        if (method === 'getDeliveredNotifications') return { notifications: [] };
        if (method === 'schedule') {
          native.scheduledReminders.push(...JSON.parse(JSON.stringify(options.notifications)));
          for (const notification of options.notifications) {
            const index = pending.findIndex(item => item.id === notification.id);
            if (index >= 0) pending[index] = notification;
          }
        }
        return {};
      }
    };
  });
  await page.reload();
  const checkInEnabled = process.env.VITE_CHECK_IN_ENABLED === 'true';
  await expect.poll(() => page.evaluate(() => (window as any).scheduledReminders.length)).toBe(checkInEnabled ? 3 : 2);
  const scheduled = await page.evaluate(() => (window as any).scheduledReminders);
  if (!checkInEnabled) expect(scheduled.some((item: any) => item.extra?.followUpNoticeId)).toBe(false);
  // The old per-Draft reminder gives way to the Draft reminders of faza 4 ticket 14, which carry their own text.
  expect(scheduled).toEqual(expect.arrayContaining([
    ...(checkInEnabled ? [expect.objectContaining({ id: 1047422860, title: 'Bór czuwa', channelId: 'follow-up-checks', isExactNotification: false,
      schedule: { at: '2026-11-12T12:00:00.123Z' }, extra: { followUpNoticeId: 'notice-brand' } })] : []),
    expect.objectContaining({ channelId: 'draft-reminders', schedule: { at: '2026-10-02T08:00:00.000Z' },
      extra: { draftReminderDay: '2026-10-02', draftIds: ['draft-brand'] } })
  ]));
});
