import { test, expect, type Page } from '@playwright/test';
import { answerHome, answerNow, footer, leaveCompass, save } from './stages.ts';

test.use({ serviceWorkers: 'block', hasTouch: true, isMobile: true });

async function sensors(page: Page, permission: PermissionState = 'granted') {
  await page.addInitScript(permission => {
    const requests: PositionCallback[] = [];
    const errors: PositionErrorCallback[] = [];
    const live = new Set<number>();
    const query = navigator.permissions.query.bind(navigator.permissions);
    navigator.permissions.query = ((options: PermissionDescriptor) => options.name === 'geolocation'
      ? Promise.resolve({ state: permission } as PermissionStatus) : query(options)) as typeof query;
    navigator.geolocation.watchPosition = (success, failure) => {
      requests.push(success); errors.push(failure!); live.add(requests.length); return requests.length;
    };
    navigator.geolocation.clearWatch = id => { live.delete(id); };
    const headings = new Map<EventListenerOrEventListenerObject, EventListener>();
    const add = window.addEventListener.bind(window);
    const remove = window.removeEventListener.bind(window);
    window.addEventListener = ((type: string, listener: EventListenerOrEventListenerObject, options?: AddEventListenerOptions) => {
      if (type !== 'deviceorientationabsolute') return add(type, listener, options);
      const synthetic: EventListener = event => { if (!event.isTrusted) (listener as EventListener)(event); };
      headings.set(listener, synthetic); add(type, synthetic, options);
    }) as typeof window.addEventListener;
    window.removeEventListener = ((type: string, listener: EventListenerOrEventListenerObject, options?: EventListenerOptions) => {
      if (type !== 'deviceorientationabsolute') return remove(type, listener, options);
      remove(type, headings.get(listener)!, options); headings.delete(listener);
    }) as typeof window.removeEventListener;
    Object.assign(window, {
      sensorCounts: () => ({ requested: requests.length, location: live.size, heading: headings.size }),
      fix: (index: number, timestamp: number, lat = 52.2297) => requests[index]({ timestamp,
        coords: { latitude: lat, longitude: 21.0122, accuracy: 17 } } as GeolocationPosition),
      fail: (code: number) => errors.at(-1)!({ code } as GeolocationPositionError)
    });
  }, permission);
}
const counts = (page: Page) => page.evaluate(() => (window as unknown as {
  sensorCounts(): { requested: number; location: number; heading: number }
}).sensorCounts());
const fix = (page: Page, timestamp: number, index = 0, lat = 52.2297) => page.evaluate(({ index, timestamp, lat }) =>
  (window as unknown as { fix(index: number, timestamp: number, lat: number): void }).fix(index, timestamp, lat), { index, timestamp, lat });
async function drafts(page: Page) {
  return page.evaluate(async () => {
    const names = await indexedDB.databases();
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(names[0].name!); request.onsuccess = () => resolve(request.result); request.onerror = reject;
    });
    return await new Promise<{ fix?: { at: string; accuracy_m: number; lat: number } }[]>((resolve, reject) => {
      const tx = db.transaction('drafts'); const request = tx.objectStore('drafts').getAll();
      request.onsuccess = () => resolve(request.result); request.onerror = reject; tx.oncomplete = () => db.close();
    });
  });
}

test('startup acquires both sensors without Draft, Report, map or place search; capture shares fresh measurements', async ({ page, context }) => {
  await context.grantPermissions(['geolocation', 'accelerometer', 'gyroscope', 'magnetometer']);
  await sensors(page);
  const privateRequests: string[] = [];
  page.on('request', request => { if (/tile\.openstreetmap|\/api\/(places|reports)/.test(request.url())) privateRequests.push(request.url()); });
  await page.goto('/');
  await expect.poll(() => counts(page)).toEqual({ requested: 1, location: 1, heading: 1 });
  const timestamp = Date.now() - 20_000;
  await fix(page, timestamp);
  for (let i = 0; i < 6; i++) await page.evaluate(() => window.dispatchEvent(new DeviceOrientationEvent('deviceorientationabsolute', { alpha: 270, beta: 0, gamma: 0, absolute: true })));
  expect(await drafts(page)).toEqual([]);
  expect(privateRequests).toEqual([]);
  await page.getByRole('button', { name: 'Strzał', exact: true }).click();
  await answerNow(page);
  await expect(page.locator('.target')).toHaveAttribute('data-pointing', '90');
  await expect(page.locator('.target')).not.toHaveAttribute('data-bearing');
  await expect.poll(async () => (await drafts(page))[0]?.fix).toMatchObject({ at: new Date(timestamp).toISOString(), accuracy_m: 17 });
  expect(await counts(page)).toEqual({ requested: 1, location: 1, heading: 1 });
});

test('stale startup fix waits for fresh measurement without another subscription', async ({ page }) => {
  await sensors(page);
  await page.goto('/');
  await expect.poll(async () => (await counts(page)).requested).toBe(1);
  await fix(page, Date.now() - 61_000);
  await footer(page).getByRole('button', { name: 'Zapisz miejsce i czas' }).click();
  expect((await drafts(page))[0].fix).toBeUndefined();
  expect((await counts(page)).requested).toBe(1);
  const timestamp = Date.now();
  await fix(page, timestamp);
  await expect.poll(async () => (await drafts(page))[0]?.fix?.at).toBe(new Date(timestamp).toISOString());
});

test('background stops both sensors and ignores late callback; foreground resumes once', async ({ page, context }) => {
  await context.grantPermissions(['geolocation', 'accelerometer', 'gyroscope', 'magnetometer']);
  await sensors(page);
  await page.goto('/');
  await expect.poll(() => counts(page)).toEqual({ requested: 1, location: 1, heading: 1 });
  await footer(page).getByRole('button', { name: 'Zapisz miejsce i czas' }).click();
  await page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
    document.dispatchEvent(new Event('visibilitychange'));
    window.dispatchEvent(new PageTransitionEvent('pagehide'));
  });
  expect(await counts(page)).toEqual({ requested: 1, location: 0, heading: 0 });
  await fix(page, Date.now());
  expect((await drafts(page))[0].fix).toBeUndefined();
  await page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
    document.dispatchEvent(new Event('visibilitychange'));
    window.dispatchEvent(new PageTransitionEvent('pageshow'));
  });
  await expect.poll(() => counts(page)).toEqual({ requested: 2, location: 1, heading: 1 });
  await fix(page, Date.now(), 1);
  await expect.poll(async () => (await drafts(page))[0]?.fix?.accuracy_m).toBe(17);
});

for (const permission of ['prompt', 'denied'] as const) test(`${permission} location never prompts on startup and capture keeps a Draft`, async ({ page }) => {
  await sensors(page, permission);
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Co się stało?' })).toBeVisible();
  expect((await counts(page)).requested).toBe(0);
  await footer(page).getByRole('button', { name: 'Zapisz miejsce i czas' }).click();
  await expect.poll(async () => (await drafts(page)).length).toBe(1);
  expect((await counts(page)).requested).toBe(permission === 'prompt' ? 1 : 0);
});

test('a cached fix that ages past one minute is not used for a new capture', async ({ page }) => {
  await sensors(page);
  await page.goto('/');
  await expect.poll(async () => (await counts(page)).requested).toBe(1);
  await fix(page, Date.now());
  await page.evaluate(() => { const now = Date.now; Date.now = () => now() + 61_000; });
  await footer(page).getByRole('button', { name: 'Zapisz miejsce i czas' }).click();
  expect((await drafts(page))[0].fix).toBeUndefined();
  expect((await counts(page)).requested).toBe(1);
});

test('gesture-only compass offers enable action and keeps manual capture available', async ({ page, context }) => {
  await context.setGeolocation({ latitude: 52.2297, longitude: 21.0122, accuracy: 17 });
  await page.addInitScript(() => {
    delete (window as unknown as Record<string, unknown>).ondeviceorientationabsolute;
    Object.defineProperty(DeviceOrientationEvent, 'requestPermission', { value: async () => {
      if (!navigator.userActivation.isActive) throw new Error('Gesture required');
      return 'granted';
    } });
    // Chromium's own empty readings do not belong to this synthetic WebKit fixture.
    const listeners = new Map<EventListenerOrEventListenerObject, EventListener>();
    const add = window.addEventListener.bind(window);
    const remove = window.removeEventListener.bind(window);
    window.addEventListener = ((type: string, listener: EventListenerOrEventListenerObject, options?: AddEventListenerOptions) => {
      if (type !== 'deviceorientation') return add(type, listener, options);
      const synthetic: EventListener = event => { if (!event.isTrusted) (listener as EventListener)(event); };
      listeners.set(listener, synthetic); add(type, synthetic, options);
    }) as typeof window.addEventListener;
    window.removeEventListener = ((type: string, listener: EventListenerOrEventListenerObject, options?: EventListenerOptions) => {
      if (type !== 'deviceorientation') return remove(type, listener, options);
      remove(type, listeners.get(listener)!, options); listeners.delete(listener);
    }) as typeof window.removeEventListener;
  });
  await page.goto('/');
  await page.getByRole('button', { name: 'Strzał', exact: true }).click();
  await expect(page.getByText('Miejsce zapisane w szkicu.')).toBeAttached();
  await answerNow(page);
  const enable = page.getByRole('button', { name: 'Włącz kompas', exact: true });
  await expect(enable).toBeVisible();
  await expect(footer(page).getByRole('button', { name: 'Pomiń' })).toBeVisible();
  await enable.focus();
  await page.keyboard.press('Enter');
  await expect(enable).toHaveCount(0);
  await expect(page.getByRole('slider', { name: 'Tarcza kierunku' })).toBeFocused();
  for (let i = 0; i < 6; i++) await page.evaluate(() => {
    const event = new DeviceOrientationEvent('deviceorientation', { beta: 0, gamma: 0 });
    Object.defineProperties(event, { webkitCompassHeading: { value: 90 }, webkitCompassAccuracy: { value: 5 } });
    window.dispatchEvent(event);
  });
  await expect(page.locator('.target')).toHaveAttribute('data-pointing', '90');
  await expect(page.locator('.target')).not.toHaveAttribute('data-bearing');
});

test('expired heading cannot be selected after capture', async ({ page, context }) => {
  await context.grantPermissions(['geolocation', 'accelerometer', 'gyroscope', 'magnetometer']);
  await sensors(page);
  await page.clock.install();
  await page.goto('/');
  await expect.poll(async () => (await counts(page)).requested).toBe(1);
  await fix(page, Date.now());
  for (let i = 0; i < 6; i++) await page.evaluate(() => window.dispatchEvent(new DeviceOrientationEvent('deviceorientationabsolute', { alpha: 270, beta: 0, gamma: 0, absolute: true })));
  await page.clock.fastForward(3100);
  await page.getByRole('button', { name: 'Strzał', exact: true }).click();
  await answerNow(page);
  await expect(page.getByRole('button', { name: 'Ustaw ten kierunek' })).toBeDisabled();
  await expect(page.locator('.target')).not.toHaveAttribute('data-bearing');
});

test('offline capture keeps a Draft while cold GPS is still acquiring', async ({ page, context }) => {
  await sensors(page);
  await page.goto('/');
  await expect.poll(async () => (await counts(page)).requested).toBe(1);
  await context.setOffline(true);
  await footer(page).getByRole('button', { name: 'Zapisz miejsce i czas' }).click();
  await page.getByRole('button', { name: 'Dokończę później' }).click();
  await expect(page.getByRole('heading', { name: 'Co się stało?', exact: true })).toBeVisible();
  expect(await drafts(page)).toHaveLength(1);
  expect((await drafts(page))[0].fix).toBeUndefined();
});

test('Android startup uses existing OS permission even when WebView permission is prompt', async ({ page }) => {
  await sensors(page, 'prompt');
  await page.addInitScript(() => {
    const native = window as any;
    native.androidBridge = {};
    native.locationPreparations = 0;
    native.Capacitor = {
      PluginHeaders: [
        { name: 'LocationAccess', methods: [{ name: 'prepare', rtype: 'promise' }] },
        { name: 'App', methods: [{ name: 'addListener', rtype: 'callback' }, { name: 'removeListener', rtype: 'promise' }] }
      ],
      nativeCallback: () => 'listener',
      nativePromise: async (plugin: string) => {
        if (plugin === 'LocationAccess') { native.locationPreparations++; return { granted: true }; }
        return {};
      }
    };
  });
  await page.goto('/');
  await expect.poll(async () => (await counts(page)).requested).toBe(1);
  expect(await page.evaluate(() => (window as any).locationPreparations)).toBe(1);
  expect(await drafts(page)).toEqual([]);
});


test('transient sensor failure recovers in foreground and next capture gets newer measurement', async ({ page }) => {
  await sensors(page);
  await page.goto('/');
  await expect.poll(async () => (await counts(page)).requested).toBe(1);
  const old = Date.now() - 20_000;
  await fix(page, old);
  await page.evaluate(() => (window as unknown as { fail(code: number): void }).fail(2));
  expect((await counts(page)).location).toBe(1);
  const fresh = Date.now();
  await fix(page, fresh, 0, 53.1234);
  // Out-of-order callbacks must not replace the newer measurement.
  await fix(page, old);
  await footer(page).getByRole('button', { name: 'Zapisz miejsce i czas' }).click();
  await expect.poll(async () => (await drafts(page))[0]?.fix).toMatchObject({ at: new Date(fresh).toISOString(), lat: 53.1234 });
  expect((await counts(page)).requested).toBe(1);
});

test('slow history reads do not block capture or reset its receipt when they finish', async ({ page }) => {
  await sensors(page);
  await page.addInitScript(() => {
    let release: () => void;
    const historyReady = new Promise<void>(resolve => { release = resolve; });
    Object.assign(window, { releaseHistory: () => release() });
    const getAll = IDBObjectStore.prototype.getAll;
    IDBObjectStore.prototype.getAll = function (...args) {
      const request = getAll.apply(this, args);
      const add = request.addEventListener.bind(request);
      request.addEventListener = ((type: string, listener: EventListener, options?: AddEventListenerOptions) =>
        add(type, type === 'success' ? function (event: Event) {
          void historyReady.then(() => listener.call(request, event));
        } : listener, options)) as typeof request.addEventListener;
      return request;
    };
  });
  await page.route('**/api/**', route => route.abort());
  await page.goto('/');
  await expect.poll(async () => (await counts(page)).requested).toBe(1);
  const capture = footer(page).getByRole('button', { name: 'Zapisz miejsce i czas' });
  await expect(capture).toBeVisible();
  await capture.click();
  await expect(page.getByRole('button', { name: 'Dokończę później', exact: true })).toBeVisible();
  await page.evaluate(() => (window as unknown as { releaseHistory(): void }).releaseHistory());
  await expect.poll(async () => (await drafts(page)).length).toBe(1);
  await expect(page.getByRole('button', { name: 'Dokończę później', exact: true })).toBeVisible();
  expect((await counts(page)).requested).toBe(1);
});

test('a delayed startup read cannot bring back a Draft deleted during a new capture', async ({ page }) => {
  await sensors(page);
  await page.goto('/');
  await page.getByRole('button', { name: 'Strzał', exact: true }).click();
  await page.getByRole('button', { name: 'Dokończę później' }).click();
  await page.addInitScript(() => {
    let release: () => void;
    const ready = new Promise<void>(resolve => { release = resolve; });
    Object.assign(window, { releaseHistory: () => release() });
    const held = new Set<string>();
    const getAll = IDBObjectStore.prototype.getAll;
    IDBObjectStore.prototype.getAll = function (...args) {
      const request = getAll.apply(this, args);
      if (held.has(this.name)) return request;
      held.add(this.name);
      const add = request.addEventListener.bind(request);
      request.addEventListener = ((type: string, listener: EventListener, options?: AddEventListenerOptions) =>
        add(type, type === 'success' ? function (event: Event) {
          void ready.then(() => listener.call(request, event));
        } : listener, options)) as typeof request.addEventListener;
      return request;
    };
  });
  await page.reload();
  await footer(page).getByRole('button', { name: 'Zapisz miejsce i czas' }).click();
  await page.getByRole('button', { name: 'Dokończę później' }).click();
  await page.getByRole('button', { name: 'Moje zapisy', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Usuń szkic' })).toHaveCount(2);
  await page.getByRole('button', { name: 'Usuń szkic' }).first().click();
  await page.getByRole('group', { name: 'Usunąć szkic?' }).getByRole('button', { name: 'Usuń', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Usuń szkic' })).toHaveCount(1);
  await page.evaluate(() => (window as unknown as { releaseHistory(): void }).releaseHistory());
  await expect.poll(async () => (await drafts(page)).length).toBe(1);
  await expect(page.getByRole('button', { name: 'Usuń szkic' })).toHaveCount(1);
});

test('a saved Draft deep link restores its stage after the startup history read', async ({ page }) => {
  await sensors(page);
  await page.goto('/');
  await page.getByRole('button', { name: 'Strzał', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Kiedy to się stało?' })).toBeVisible();
  const url = page.url();
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Kiedy to się stało?' })).toBeVisible();
  expect(page.url()).toBe(url);
  expect(await drafts(page)).toHaveLength(1);
  expect((await counts(page)).requested).toBe(1);
});


test('a queued upload with no network response does not gate a new capture', async ({ page }) => {
  await sensors(page);
  let posts = 0;
  await page.route('**/api/reports', route => { posts++; return new Promise<void>(() => {}); });
  await page.goto('/');
  await expect.poll(async () => (await counts(page)).requested).toBe(1);
  await fix(page, Date.now());
  await page.getByRole('button', { name: 'Człowiek z bronią', exact: true }).click();
  await answerNow(page);
  await leaveCompass(page);
  await answerHome(page, false);
  await save(page);
  await expect.poll(() => posts).toBeGreaterThan(0);
  await page.goto('/');
  await expect.poll(async () => (await counts(page)).requested).toBe(1);
  await footer(page).getByRole('button', { name: 'Zapisz miejsce i czas' }).click();
  await expect(page.locator('#receipt')).toBeVisible();
  expect(await drafts(page)).toHaveLength(1);
});

test('unavailable location still lets capture save its receipt', async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'geolocation', { value: undefined });
  });
  await page.goto('/');
  await footer(page).getByRole('button', { name: 'Zapisz miejsce i czas' }).click();
  await expect(page.locator('#receipt')).toBeVisible();
  expect(await drafts(page)).toHaveLength(1);
  expect((await drafts(page))[0].fix).toBeUndefined();
});
