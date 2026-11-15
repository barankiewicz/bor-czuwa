import { test, expect } from '@playwright/test';
import { finishFromWhen, settled } from './stages.ts';
import { readFile } from 'node:fs/promises';

const points = JSON.parse(await readFile(new URL('../../data/fixtures/acceptance.json', import.meta.url), 'utf8'));
type FindingObservation = { starts: number; skips: number; frames: { activeTransition: boolean; visible: boolean }[] };

test('offline Report survives reload, syncs on reconnection, and keeps Findings offline', async ({ page, context }) => {
  await page.addInitScript(() => {
    const state: FindingObservation = { starts: 0, skips: 0, frames: [] };
    (window as unknown as { findingObservation: FindingObservation }).findingObservation = state;
    const start = document.startViewTransition.bind(document);
    document.startViewTransition = (...args) => {
      state.starts++;
      const transition = start(...args), skip = transition.skipTransition.bind(transition);
      transition.skipTransition = () => { state.skips++; skip(); };
      return transition;
    };
  });
  await context.setGeolocation({ latitude: points.edge.point.lat, longitude: points.edge.point.lon, accuracy: 8 });
  const posts: Record<string, unknown>[] = [];
  page.on('request', request => {
    if (request.method() === 'POST' && request.url().endsWith('/api/reports')) posts.push(request.postDataJSON());
  });
  await page.goto('/');
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
    if (!navigator.serviceWorker.controller) {
      await new Promise<void>(resolve => navigator.serviceWorker.addEventListener('controllerchange', () => resolve(), { once: true }));
    }
  });
  await context.setOffline(true);
  await page.reload();
  await page.getByRole('button', { name: 'Człowiek z bronią', exact: true }).click();
  await finishFromWhen(page, false);
  await expect(page.getByRole('button', { name: 'Zapisz zgłoszenie' })).toBeEnabled();
  await page.getByRole('button', { name: 'Zapisz zgłoszenie' }).click();
  await expect(page.getByText('Zapisano na telefonie.', { exact: false })).toBeVisible();
  await page.getByRole('button', { name: 'Bór czuwa' }).click();
  // The upload is the app's work: home says nothing waits for the Reporter, and when it will go.
  await expect(page.locator('.continuation')).toHaveCount(0);
  await expect(page.locator('.calm')).toHaveText('Zapisane zgłoszenie trafi na serwer, gdy będzie internet.');
  await page.reload();
  await page.getByRole('button', { name: 'Moje zapisy' }).click();
  await expect(page.locator('.history').getByText('Czeka na internet, potem zapisze się samo', { exact: true })).toBeVisible();
  expect(posts).toHaveLength(0);
  await page.getByRole('button', { name: /^Człowiek z bronią, / }).click();
  await settled(page);
  await page.evaluate(() => {
    const state = (window as unknown as { findingObservation: FindingObservation }).findingObservation;
    state.starts = 0;
    state.skips = 0;
    const sample = () => {
      // Findings arrive as the dwelling fact row (ticket 30); it must never ride a view transition.
      const status = document.querySelector('[data-fact="dwelling"]');
      if (status) {
        const box = status.getBoundingClientRect(), css = getComputedStyle(status);
        state.frames.push({ activeTransition: document.documentElement.matches(':active-view-transition'),
          visible: box.width > 0 && box.height > 0 && css.visibility === 'visible' && Number(css.opacity) > 0 });
      }
      if (state.frames.length < 12) requestAnimationFrame(sample);
    };
    requestAnimationFrame(sample);
  });
  await context.setOffline(false);
  await expect(page.getByText('Zapisano na serwerze.', { exact: true })).toBeVisible({ timeout: 20_000 });
  await expect.poll(() => page.evaluate(() => (window as unknown as { findingObservation: FindingObservation }).findingObservation.frames.length)).toBe(12);
  const observed = await page.evaluate(() => (window as unknown as { findingObservation: FindingObservation }).findingObservation);
  expect(observed.starts).toBe(0);
  expect(observed.skips).toBe(0);
  expect(observed.frames.every(frame => frame.visible && !frame.activeTransition)).toBe(true);
  await expect(page.locator('[data-fact="dwelling"] .fact-value b')).toHaveText(`${Math.round(points.edge.expected_m)} m`);
  await expect(page.locator('[data-fact="dwelling"] .fact-value small')).toHaveText('±8 m');
  await expect(page.locator('[data-fact="obwod"] .fact-value')).toHaveText('nr 112');
  await page.getByRole('button', { name: 'Skąd te wyniki' }).click();
  await expect(page.getByRole('dialog').getByText(/Dane o obwodach łowieckich mają charakter poglądowy\./)).toBeVisible();
  await expect(page.getByRole('dialog').getByRole('link', { name: 'Bank Danych o Lasach' })).toHaveAttribute('href',
    'https://mapserver.bdl.lasy.gov.pl/ArcGIS/rest/services/WMS_Obwody_lowieckie/MapServer/6');
  expect(posts).toHaveLength(1);
  expect(Object.keys(posts[0]).sort()).toEqual([
    'app_version', 'captured_at', 'device_fix', 'event_type', 'has_note', 'id',
    'incident_location', 'occurred_at', 'photo_sha256', 'privacy_policy_version', 'solution', 'species',
    'terms_of_use_version', 'token_sha256'
  ]);
  expect(posts[0]).toMatchObject({ privacy_policy_version: 'v1', terms_of_use_version: 'v1' });
  await context.setOffline(true);
  await page.reload();
  await page.getByRole('button', { name: 'Moje zapisy' }).click();
  await page.getByRole('button', { name: /^Człowiek z bronią, / }).click();
  await expect(page.locator('[data-fact="dwelling"]')).toBeVisible();
});

test('rapid connectivity changes do not strand a Report during its IndexedDB read', async ({ page, context }) => {
  await context.setGeolocation({ latitude: points.edge.point.lat, longitude: points.edge.point.lon, accuracy: 8 });
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'onLine', { configurable: true, get: () => false });
  });
  await page.goto('/');
  await page.getByRole('button', { name: 'Strzał', exact: true }).click();
  await finishFromWhen(page, false);
  await page.getByRole('button', { name: 'Zapisz zgłoszenie' }).click();
  await expect(page.getByText('Zapisano na telefonie.', { exact: false })).toBeVisible();
  await page.evaluate(() => {
    Object.defineProperty(navigator, 'onLine', { configurable: true, get: () => true });
    // One browser task ensures the IndexedDB request cannot finish between these events.
    window.dispatchEvent(new Event('online'));
    window.dispatchEvent(new Event('offline'));
    window.dispatchEvent(new Event('online'));
  });
  await expect(page.getByText('Zapisano na serwerze.', { exact: true })).toBeVisible();
});

test('successive captures share one fresh sensor reading without duplicate requests', async ({ page }) => {
  await page.addInitScript(() => {
    const callbacks: PositionCallback[] = [];
    Object.defineProperty(navigator.geolocation, 'watchPosition', {
      value: (success: PositionCallback, _error: PositionErrorCallback, options?: PositionOptions) => {
        if (options?.enableHighAccuracy) callbacks.push(success);
        return callbacks.length;
      }
    });
    Object.assign(window, { locateCalls: () => callbacks.length });
    window.addEventListener('test-location', event => {
      const { index, lat, lon } = (event as CustomEvent).detail;
      callbacks[index]({ coords: { latitude: lat, longitude: lon, accuracy: 8 }, timestamp: Date.now() } as GeolocationPosition);
    });
  });
  await page.goto('/');
  await page.getByRole('button', { name: 'Człowiek z bronią', exact: true }).click();
  await page.getByRole('button', { name: 'Wróć', exact: true }).click();
  await page.getByRole('button', { name: 'Człowiek z bronią', exact: true }).click();
  // Both captures wait on the foreground watch; only the current Draft receives the fix.
  await expect.poll(() => page.evaluate(() => (window as unknown as { locateCalls(): number }).locateCalls())).toBe(1);
  await page.evaluate(point => window.dispatchEvent(new CustomEvent('test-location', {
    detail: { index: 0, ...point }
  })), points.barn.point);
  // Teraz before the fix lands would ask for the place on the map instead.
  await expect(page.getByText('Miejsce zapisane w szkicu.')).toBeAttached();
  await finishFromWhen(page, false);
  const posted = page.waitForRequest(request => request.method() === 'POST' && request.url().endsWith('/api/reports'));
  await page.getByRole('button', { name: 'Zapisz zgłoszenie' }).click();
  const payload = (await posted).postDataJSON();
  expect(payload.device_fix.lat).toBe(points.barn.point.lat);
  expect(payload.device_fix.lon).toBe(points.barn.point.lon);
});
