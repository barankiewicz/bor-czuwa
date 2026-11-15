import { test, expect, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';

const findings = JSON.parse(await readFile(new URL('./computed-findings.json', import.meta.url), 'utf8'));
const at = '2026-10-05T12:00:00Z';
const message = 'Ta karta działa w starszej wersji aplikacji i nie może zapisać zmian. Uruchom nową wersję. Zapisane dane zostaną na telefonie.';
test.use({ serviceWorkers: 'block' });

const saved = { report: { id: '252ad090-7777-4777-8777-777777777777', event_type: 'shot', captured_at: at,
  occurred_at: { at, source: 'device_clock', coarseness: 'exact' }, device_fix: null,
  incident_location: { lat: 53.403481, lon: 22.658699, source: 'moved_by_reporter' }, species: null, has_note: false,
  app_version: '0.1.3', privacy_policy_version: '1', terms_of_use_version: '1', token_sha256: '0'.repeat(64) },
token: '1'.repeat(64), findings, events: [{ kind: 'created', at }, { kind: 'synced', at }], notices: [] };

async function arrive(page: Page) {
  await page.addInitScript(() => localStorage.setItem('first-launch-seen', '1'));
  await page.route('**/api/**', route => route.fulfill({ status: 503, json: { error: 'disposable_no_server' } }));
}
async function openLibrary(page: Page) {
  await page.goto('/');
  await page.getByRole('button', { name: 'Moje zapisy', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Moje zapisy', exact: true })).toBeVisible();
}

test('a database one version newer than the app says so above the Moje zapisy list', async ({ page }) => {
  await arrive(page);
  // A static page on the same origin, so no app code holds the database open while it is raised to 7.
  await page.goto('/webview-update.html');
  await page.evaluate(async report => {
    await new Promise<void>((resolve, reject) => {
      const request = indexedDB.open('bor-czuwa', 7);
      request.onupgradeneeded = () => request.result.createObjectStore('reports', { keyPath: 'report.id' }).put(report);
      request.onsuccess = () => { request.result.close(); resolve(); };
      request.onerror = () => reject(request.error);
    });
  }, saved);
  await openLibrary(page);
  await expect(page.getByText(message, { exact: true })).toHaveCount(1);
  await expect(page.getByText(message, { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Uruchom nową wersję', exact: true })).toBeVisible();
  const version = await page.evaluate(() => new Promise<number>(resolve => {
    const request = indexedDB.open('bor-czuwa'); request.onsuccess = () => { resolve(request.result.version); request.result.close(); };
  }));
  expect(version).toBe(7);
});

test('a database at the app version opens Moje zapisy without the message', async ({ page }) => {
  await arrive(page);
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Co się stało?', exact: true })).toBeVisible();
  await page.evaluate(async report => {
    const db = await new Promise<IDBDatabase>(resolve => {
      const request = indexedDB.open('bor-czuwa'); request.onsuccess = () => resolve(request.result);
    });
    const tx = db.transaction('reports', 'readwrite');
    tx.objectStore('reports').put(report);
    await new Promise<void>(resolve => { tx.oncomplete = () => resolve(); }); db.close();
  }, saved);
  await openLibrary(page);
  await expect(page.getByText('Przejdź do historii', { exact: true })).toBeVisible();
  await expect(page.getByText(message, { exact: true })).toHaveCount(0);
});
