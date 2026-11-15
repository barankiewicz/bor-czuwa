import { test, expect, type Page, type PlaywrightWorkerArgs } from '@playwright/test';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { heading } from './stages.ts';

test.use({ serviceWorkers: 'block' });

const blocked = 'Przeglądarka blokuje zapis danych. Odblokuj go w ustawieniach witryny.';
const failed = 'Nie udało się zapisać danych na urządzeniu.';

// Two ways a browser refuses IndexedDB: opening throws (cookies blocked), or the factory itself throws.
const denials: [string, () => void][] = [
  ['opening IndexedDB throws', () => {
    Object.defineProperty(IDBFactory.prototype, 'open', { value() { throw new DOMException('denied', 'SecurityError'); } });
  }],
  ['window.indexedDB throws', () => {
    Object.defineProperty(window, 'indexedDB', { configurable: true, get() { throw new DOMException('denied', 'SecurityError'); } });
  }]
];

/** Loads home and lets start-up, the sync worker and the offline check run before anything is read. */
async function load(page: Page) {
  const errors: Error[] = [];
  page.on('pageerror', error => errors.push(error));
  await page.goto('/');
  await expect(heading(page, 'Co się stało?')).toBeVisible();
  await page.waitForLoadState('networkidle');
  await page.waitForTimeout(500);
  return errors;
}

for (const [name, deny] of denials) {
  test.describe(`storage denied: ${name}`, () => {
    test.beforeEach(async ({ page }) => { await page.addInitScript(deny); });

    test('home says so once in a status line and does not ask for a retry', async ({ page }) => {
      // Records every alert painted during start-up, including on the screen shown before home.
      await page.addInitScript(() => {
        const alerts: string[] = [];
        Object.assign(window, { startupAlerts: alerts });
        new MutationObserver(() => document.querySelectorAll('[role="alert"]').forEach(node => {
          if (node.textContent && !alerts.includes(node.textContent)) alerts.push(node.textContent);
        })).observe(document, { subtree: true, childList: true, characterData: true });
      });
      await load(page);
      expect(await page.evaluate(() => (window as unknown as { startupAlerts: string[] }).startupAlerts)).toEqual([]);
      await expect(page.getByRole('status').filter({ hasText: blocked })).toHaveCount(1);
      await expect(page.getByText(blocked, { exact: true })).toHaveCount(1);
      await expect(page.getByText(/Spróbuj ponownie/)).toHaveCount(0);
    });

    test('tapping an Event shows the same line and no other storage text', async ({ page }) => {
      await load(page);
      await page.getByRole('button', { name: 'Strzał', exact: true }).click();
      await page.waitForTimeout(500);
      await expect(page.getByText(blocked, { exact: true })).toHaveCount(1);
      await expect(page.getByText(blocked, { exact: true })).toBeFocused();
      await expect(page.getByText(/Spróbuj ponownie/)).toHaveCount(0);
      await expect(page.getByText(failed)).toHaveCount(0);
      await expect(heading(page, 'Co się stało?')).toBeVisible();
    });

    test('loading leaves no SecurityError uncaught', async ({ page }) => {
      const errors = await load(page);
      expect(errors.filter(error => error.name === 'SecurityError' || /SecurityError|denied/.test(String(error))).map(String)).toEqual([]);
    });
  });
}

test('with storage available the same taps reach the dial and no storage line appears', async ({ page, context }) => {
  await context.setGeolocation({ latitude: 52.1, longitude: 19.4, accuracy: 12 });
  const errors = await load(page);
  await expect(page.getByText(blocked, { exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Strzał', exact: true }).click();
  await expect(heading(page, 'Kiedy to się stało?')).toBeVisible();
  await page.getByRole('button', { name: /^Teraz/ }).click();
  await expect(page.getByRole('slider', { name: 'Tarcza kierunku' })).toBeVisible();
  await expect(page.getByText(blocked, { exact: true })).toHaveCount(0);
  expect(errors.map(String)).toEqual([]);
});

test('an aborted write keeps the existing failure text, not the blocked line', async ({ page }) => {
  await load(page);
  await page.evaluate(() => {
    const put = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function (...args) {
      if (this.name === 'drafts') throw new DOMException('Write aborted', 'AbortError');
      return put.apply(this, args);
    };
  });
  await page.getByRole('button', { name: 'Strzał', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText(failed);
  await expect(page.getByText(blocked, { exact: true })).toHaveCount(0);
});

test('a denial after a failed write replaces the retry text instead of joining it', async ({ page }) => {
  await load(page);
  await page.evaluate(() => {
    const put = IDBObjectStore.prototype.put;
    Object.assign(window, { refusal: 'AbortError' });
    IDBObjectStore.prototype.put = function (...args) {
      const name = (window as unknown as { refusal: string }).refusal;
      if (this.name === 'drafts') throw new DOMException(name === 'SecurityError' ? 'denied' : 'Write aborted', name);
      return put.apply(this, args);
    };
  });
  await page.getByRole('button', { name: 'Strzał', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText(failed);
  // The browser now refuses storage outright, so the earlier retry advice no longer holds.
  await page.evaluate(() => { Object.assign(window, { refusal: 'SecurityError' }); });
  await page.getByRole('button', { name: 'Strzał', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: blocked })).toHaveCount(1);
  await expect(page.getByText(/Spróbuj ponownie/)).toHaveCount(0);
});

test('with all site data blocked, as Firefox does it, start-up still finds the denial and says it once', async ({ page }) => {
  await page.addInitScript(() => {
    const refuse = () => { throw new DOMException('The operation is insecure.', 'SecurityError'); };
    Object.defineProperty(IDBFactory.prototype, 'open', { value: refuse });
    Object.defineProperty(window, 'localStorage', { configurable: true, get: refuse });
    Object.defineProperty(window, 'sessionStorage', { configurable: true, get: refuse });
    window.BroadcastChannel = function () { refuse(); } as unknown as typeof BroadcastChannel;
    for (const name of ['keys', 'open', 'match', 'has', 'delete'] as const) {
      Object.defineProperty(CacheStorage.prototype, name, { value: () => Promise.reject(new DOMException('The operation is insecure.', 'SecurityError')) });
    }
  });
  const errors: Error[] = [];
  page.on('pageerror', error => errors.push(error));
  await page.goto('/');
  // Nothing on this device can be remembered, so the introduction opens every time.
  await page.getByRole('button', { name: 'Dalej bez lokalizacji' }).click();
  await expect(heading(page, 'Co się stało?')).toBeVisible();
  await expect(page.getByRole('status').filter({ hasText: blocked })).toHaveCount(1);
  await expect(page.getByText(blocked, { exact: true })).toHaveCount(1);
  await expect(page.getByText(/Nie udało się zapamiętać ustawień|Spróbuj ponownie/)).toHaveCount(0);
  await page.getByRole('button', { name: 'Strzał', exact: true }).click();
  await page.waitForLoadState('networkidle');
  expect(errors.map(String)).toEqual([]);
});

test('real Firefox with site data blocked shows the line once and leaves no error uncaught', async ({ playwright }, testInfo) => {
  // The browser's own cookie setting, no script: Firefox then refuses every storage API with SecurityError.
  const browser = await playwright.firefox.launch({ firefoxUserPrefs: { 'network.cookie.cookieBehavior': 2 } });
  try {
    // Service workers allowed and no stored state, as for a real visitor.
    const page = await browser.newPage({ baseURL: testInfo.project.use.baseURL, locale: 'pl-PL', serviceWorkers: 'allow',
      storageState: { cookies: [], origins: [] } });
    const errors: Error[] = [];
    page.on('pageerror', error => errors.push(error));
    await page.goto('/');
    await page.getByRole('button', { name: 'Dalej bez lokalizacji' }).click();
    await expect(heading(page, 'Co się stało?')).toBeVisible();
    await expect(page.getByRole('status').filter({ hasText: blocked })).toHaveCount(1);
    await page.getByRole('button', { name: 'Strzał', exact: true }).click();
    await expect(page.getByText(blocked, { exact: true })).toBeFocused();
    await expect(page.getByText(/Spróbuj ponownie/)).toHaveCount(0);
    await page.waitForLoadState('networkidle');
    // One known error, not the app's: SvelteKit's own inline script in index.html calls
    // navigator.serviceWorker.register() on window load (kit.serviceWorker.register defaults to true),
    // and Firefox refuses it. The app's own registration in offline-readiness.ts catches its refusal.
    expect(errors.map(error => `${error.name}: ${error.message}`)).toEqual(['SecurityError: The operation is insecure.']);
    expect(errors[0].stack).not.toContain('/_app/');
  } finally { await browser.close(); }
});

/** Real Chromium with the site's data blocked in its own settings, no script: the open then fails with UnknownError. */
async function blockedChromium(playwright: PlaywrightWorkerArgs['playwright'], baseURL: string | undefined) {
  const profile = await mkdtemp(path.join(tmpdir(), 'bor-blocked-'));
  await mkdir(path.join(profile, 'Default'));
  await writeFile(path.join(profile, 'Default', 'Preferences'), JSON.stringify({ profile: { default_content_setting_values: { cookies: 2 } } }));
  return playwright.chromium.launchPersistentContext(profile, { channel: 'chromium', locale: 'pl-PL',
    baseURL, viewport: { width: 390, height: 844 }, serviceWorkers: 'block' });
}

test('Chromium with site data blocked in its settings shows the line on home and on a tap', async ({ playwright }, testInfo) => {
  const context = await blockedChromium(playwright, testInfo.project.use.baseURL);
  try {
    const page = context.pages()[0] ?? await context.newPage();
    await page.goto('/');
    expect(await page.evaluate(() => new Promise(resolve => {
      const request = indexedDB.open('probe');
      request.onsuccess = () => resolve('opened');
      request.onerror = () => resolve(request.error?.name);
    }))).toBe('UnknownError');
    // Nothing on this device can be remembered, so the introduction opens every time.
    await page.getByRole('button', { name: 'Dalej bez lokalizacji' }).click();
    await expect(heading(page, 'Co się stało?')).toBeVisible();
    await expect(page.getByRole('status').filter({ hasText: blocked })).toHaveCount(1);
    await page.getByRole('button', { name: 'Strzał', exact: true }).click();
    await page.waitForTimeout(500);
    await expect(page.getByText(blocked, { exact: true })).toHaveCount(1);
    await expect(page.getByText(/Spróbuj ponownie/)).toHaveCount(0);
  } finally { await context.close(); }
});

test('Chromium with site data blocked, reopening a saved journey, goes from the introduction to home with the line', async ({ playwright }, testInfo) => {
  const context = await blockedChromium(playwright, testInfo.project.use.baseURL);
  try {
    const page = context.pages()[0] ?? await context.newPage();
    await page.goto('/?screen=when&draft=00000000-0000-4000-8000-000000000000');
    await page.getByRole('button', { name: 'Dalej bez lokalizacji' }).click();
    await expect(heading(page, 'Co się stało?')).toBeVisible();
    await expect(page.getByRole('status').filter({ hasText: blocked })).toHaveCount(1);
    await expect(page.getByText(/Spróbuj ponownie/)).toHaveCount(0);
  } finally { await context.close(); }
});

test('reopening a saved journey with storage denied lands on home with the line', async ({ page }) => {
  await page.addInitScript(denials[0][1]);
  await page.goto('/?screen=when&draft=00000000-0000-4000-8000-000000000000');
  await expect(heading(page, 'Co się stało?')).toBeVisible();
  await expect(page.getByRole('status').filter({ hasText: blocked })).toHaveCount(1);
  await expect(page).toHaveURL(/\/$/);
});
