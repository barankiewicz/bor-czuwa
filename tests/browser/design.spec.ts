import { test, expect } from '@playwright/test';
import { clockedGeolocation, openMap, answerNow, choosePoint, finishFromWhen, heading, leaveCompass } from './stages.ts';

test('Menu leads with reachable language choices and keeps records in the chrome', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Menu', exact: true }).click();
  const language = page.getByRole('group', { name: 'Język' });
  await expect(language.getByRole('button', { name: 'Polski' })).toBeInViewport();
  await expect(language.getByRole('button', { name: 'English' })).toBeInViewport();
  await expect(page.getByRole('button', { name: 'Moje zapisy', exact: true })).toHaveCount(1);
  expect(await page.locator('.screen-body button').first().textContent()).toBe('Polski');
  await language.getByRole('button', { name: 'English' }).click();
  await expect(page.getByRole('group', { name: 'Language' }).getByRole('button', { name: 'English' })).toHaveAttribute('aria-pressed', 'true');
  await page.reload();
  await expect(page.getByRole('group', { name: 'Language' }).getByRole('button', { name: 'English' })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByText('Notices to Polish authorities are always written in Polish.')).toBeVisible();
  await page.getByRole('button', { name: 'Polski', exact: true }).click();
  await page.getByRole('button', { name: 'Informacje na początek' }).click();
  await expect(heading(page, 'Zanim zaczniesz')).toBeFocused();
});

test('Android alarm advice stays in Menu and opens the exact-alarm setting', async ({ page, context }) => {
  await context.setGeolocation({ latitude: 53.4, longitude: 22.8, accuracy: 12 });
  await context.addInitScript(() => {
    const native = window as any;
    native.androidBridge = {};
    native.alarmCalls = [];
    native.exactAllowed = false;
    native.Capacitor = {
      PluginHeaders: [
        { name: 'LocalNotifications', methods: ['getPending', 'schedule', 'cancel', 'getDeliveredNotifications',
          'removeDeliveredNotificationsById', 'changeExactNotificationSetting', 'checkExactNotificationSetting',
          'checkPermissions', 'registerActionTypes']
          .map(name => ({ name, rtype: 'promise' })) },
        { name: 'App', methods: [{ name: 'addListener', rtype: 'callback' }, { name: 'removeListener', rtype: 'promise' }] }
      ],
      nativeCallback: () => 'listener',
      nativePromise: async (_plugin: string, method: string) => {
        native.alarmCalls.push(method);
        if (method === 'getPending' || method === 'getDeliveredNotifications') return { notifications: [] };
        if (method === 'checkPermissions') return { display: 'granted' };
        if (method === 'schedule') return native.exactAllowed ? {} : { warning: 'exact_alarm_denied' };
        if (method === 'changeExactNotificationSetting') native.exactAllowed = true;
        if (method === 'checkExactNotificationSetting') return { exact_alarm: native.exactAllowed ? 'granted' : 'denied' };
        return {};
      }
    };
  });
  await page.goto('/');
  await page.getByRole('button', { name: 'Zapisz miejsce i czas' }).click();
  await expect(page.locator('#receipt')).toBeVisible();
  const advice = page.getByText('Przypomnienie może się spóźnić', { exact: true });
  await expect(advice).toHaveCount(0);
  await page.getByRole('button', { name: 'Moje zapisy' }).click();
  await expect(advice).toHaveCount(0);
  await page.getByRole('button', { name: 'Menu', exact: true }).click();
  await expect(advice).toBeVisible();
  await expect(page.getByRole('region', { name: 'Bez internetu' })).toContainText('Gotowe do pracy bez internetu');
  // Ready says it once: the line for a shell that works before the rest has downloaded is gone (ticket 29).
  await expect(page.getByText('Zapis zgłoszeń już działa bez internetu.')).toHaveCount(0);
  await page.getByRole('button', { name: 'Włącz dokładne alarmy' }).click();
  await expect(advice).toHaveCount(0);
  expect(await page.evaluate(() => (window as any).alarmCalls)).toContain('changeExactNotificationSetting');
});

test('one-tap Draft survives reload, resumes, and never syncs by itself', async ({ page, context }) => {
  const posts: string[] = [];
  page.on('request', request => {
    if (request.method() === 'POST' && request.url().endsWith('/api/reports')) posts.push(request.url());
  });
  await context.setGeolocation({ latitude: 53.4, longitude: 22.8, accuracy: 12 });
  await page.goto('/');
  await page.getByRole('button', { name: 'Zapisz miejsce i czas' }).click();
  await expect(page.locator('#receipt strong', { hasText: 'Miejsce i czas zapisane' })).toBeVisible();
  const caption = page.locator('#receipt small').filter({ hasText: 'Dokładność 12 m' });
  const savedTime = await caption.textContent();
  await page.reload();
  await expect(page.locator('#receipt strong', { hasText: 'Miejsce i czas zapisane' })).toBeVisible();
  await expect(caption).toHaveText(savedTime ?? '');
  await expect(page.getByRole('heading', { name: 'Co się stało?' })).toBeVisible();
  await page.getByRole('button', { name: 'Strzał', exact: true }).click();
  await expect(heading(page, 'Kiedy to się stało?')).toBeVisible();
  await expect(page.locator('.steps li')).toHaveText(['Co', 'Kiedy', 'Gdzie', 'Sprawdź']);
  expect(posts).toHaveLength(0);
});

test('first screen keeps action reachable and uses bundled font in light and dark', async ({ page, context }) => {
  await page.clock.install({ time: new Date('2026-06-21T12:00:00Z') });
  await clockedGeolocation(page);
  const fontHosts: string[] = [];
  page.on('request', request => {
    if (/fonts\.googleapis|fonts\.gstatic|use\.typekit/.test(request.url())) fontHosts.push(request.url());
  });
  await page.goto('/');
  // The app draws about 50 ms after the load event; before that no text asks for the font.
  await page.locator('h1').first().waitFor();
  await page.evaluate(() => document.fonts.ready);
  expect(await page.evaluate(() => document.fonts.check('17px "Atkinson Hyperlegible Next"'))).toBe(true);
  expect(fontHosts).toHaveLength(0);
  for (const scheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    await expect(page.locator('html')).toHaveAttribute('data-theme', scheme);
    const action = page.getByRole('button', { name: 'Zapisz miejsce i czas' });
    await expect(action).toBeInViewport();
    const controls = await page.locator('button').evaluateAll(buttons => buttons.map(button => button.getBoundingClientRect().height));
    expect(Math.min(...controls)).toBeGreaterThanOrEqual(56);
  }
  await page.clock.setFixedTime(new Date('2026-12-21T00:00:00Z'));
  await context.setGeolocation({ latitude: 53.4, longitude: 22.8, accuracy: 12 });
  await page.getByRole('button', { name: 'Zapisz miejsce i czas' }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'noc');
});

test('reduced motion disables screen transitions', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.addInitScript(() => {
    (window as typeof window & { transitionCalls?: number }).transitionCalls = 0;
    document.startViewTransition = ((callback: () => void) => {
      (window as typeof window & { transitionCalls?: number }).transitionCalls!++;
      callback();
      return {} as ViewTransition;
    }) as typeof document.startViewTransition;
  });
  await page.goto('/');
  await page.getByRole('button', { name: 'Moje zapisy' }).click();
  expect(await page.evaluate(() => (window as typeof window & { transitionCalls?: number }).transitionCalls)).toBe(0);
});

test('a manual location finishes the same Draft without sending GPS accuracy or its note', async ({ page, context }) => {
  const payloads: Record<string, unknown>[] = [];
  await context.grantPermissions([]);
  await page.route('https://tile.openstreetmap.org/**', route => route.abort());
  await page.route('**/api/reports', async route => {
    payloads.push(route.request().postDataJSON());
    await route.fulfill({ status: 201, contentType: 'application/json', body: '{"id":"saved"}' });
  });
  await page.route('**/api/reports/*/findings', route =>
    route.fulfill({ status: 200, contentType: 'application/json', body: '{"status":"pending"}' }));

  await page.goto('/');
  await page.getByRole('button', { name: 'Człowiek z bronią', exact: true }).click();
  // No GPS: Teraz leads to the map.
  await answerNow(page);
  await openMap(page);
  await choosePoint(page, 52.13, 21.14, true);
  await expect(page.locator('#place-row')).toContainText('miejsce wskazane na mapie');
  await page.locator('#home-check').getByRole('button', { name: 'Nie', exact: true }).click();
  await page.locator('summary', { hasText: 'Notatka' }).click();
  await page.getByLabel('Co jeszcze chcesz przekazać?').fill('Zdarzenie przy drodze leśnej');
  await page.getByRole('button', { name: 'Zapisz zgłoszenie' }).click();
  await expect.poll(() => payloads.length).toBe(1);
  const payload = payloads[0];
  expect(payload.device_fix).toBeNull();
  expect(payload.incident_location).toEqual({ lat: 52.13, lon: 21.14, source: 'moved_by_reporter' });
  expect(payload.has_note).toBe(true);
  expect(payload.note).toBeUndefined();
  await page.getByText('Szczegóły zgłoszenia', { exact: true }).click();
  await expect(page.locator('.local-note')).toHaveText('Zdarzenie przy drodze leśnej');
});

test('a saved Draft can be deleted from the local records list', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Zapisz miejsce i czas' }).click();
  await expect(page.locator('#receipt')).toBeVisible();
  await page.getByRole('button', { name: 'Moje zapisy' }).click();
  await page.getByRole('button', { name: 'Usuń szkic' }).click();
  await page.getByRole('group', { name: 'Usunąć szkic?' }).getByRole('button', { name: 'Usuń', exact: true }).click();
  await expect(page.getByText('Tu znajdziesz zapisane miejsca i zgłoszenia.')).toBeVisible();
});

test('backgrounding mid-form saves current note without changing captured time', async ({ page, context }) => {
  await context.setGeolocation({ latitude: 53.4, longitude: 22.8, accuracy: 12 });
  await page.goto('/');
  await page.getByRole('button', { name: 'Strzał' }).click();
  await answerNow(page);
  await leaveCompass(page);
  await page.locator('summary', { hasText: 'Notatka' }).click();
  await expect(page.getByLabel('Co jeszcze chcesz przekazać?')).toBeVisible();
  const captured = await page.locator('#when-row .value').textContent();
  await page.getByLabel('Co jeszcze chcesz przekazać?').fill('Zapis przed odejściem');
  await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pagehide')));
  await page.reload();
  await page.getByRole('button', { name: 'Moje zapisy' }).click();
  await page.getByRole('button', { name: /^Dokończ zgłoszenie/ }).click();
  await expect(page.locator('#when-row .value')).toHaveText(captured ?? '');
  await expect(page.getByLabel('Co jeszcze chcesz przekazać?')).toHaveValue('Zapis przed odejściem');
});

test('screen crossfade retains old content while new content appears', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('heading', { name: 'Co się stało?' }).waitFor();
  // Sample from before the tap: the first frame of the crossfade is the only one with the old screen
  // fully present, and a slow runner can take longer to deliver the tap than that frame lasts.
  await page.evaluate(() => {
    const frames: { old: number; fresh: number }[] = [];
    Object.assign(window, { crossfade: frames, crossfadeDone: false });
    let tapped = 0;
    document.addEventListener('click', () => { tapped ||= performance.now(); }, { capture: true, once: true });
    const sample = (now: number) => {
      frames.push({
        old: Number(getComputedStyle(document.documentElement, '::view-transition-old(root)').opacity),
        fresh: Number(getComputedStyle(document.documentElement, '::view-transition-new(root)').opacity)
      });
      if (tapped && now - tapped > 800) Object.assign(window, { crossfadeDone: true });
      else requestAnimationFrame(sample);
    };
    requestAnimationFrame(sample);
  });
  await page.getByRole('button', { name: 'Moje zapisy' }).click();
  await page.waitForFunction(() => (window as unknown as { crossfadeDone: boolean }).crossfadeDone);
  const samples = await page.evaluate(() => (window as unknown as { crossfade: { old: number; fresh: number }[] }).crossfade);
  const entering = samples.findIndex(frame => frame.fresh === 0 && frame.old === 1);
  expect(entering).toBeGreaterThanOrEqual(0);
  expect(samples.slice(entering + 1).some(frame => frame.fresh > 0 && frame.fresh < 1)).toBe(true);
  expect(samples.slice(entering).every(frame => frame.old + frame.fresh > 0)).toBe(true);
});
