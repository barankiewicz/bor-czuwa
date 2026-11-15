import { fileAsPdf, openNoticeRow } from './stages.ts';
import { test, expect, type Page } from '@playwright/test';
import { finishFromWhen } from './stages.ts';
import { readFile } from 'node:fs/promises';

const points = JSON.parse(await readFile(new URL('../../data/fixtures/acceptance.json', import.meta.url), 'utf8'));
const directory = /\/_app\/immutable\/assets\/(gminy|police|regional|parks)\.[^/]+\.json$/;
const pdfFont = /\/fonts\/NotoSans-Regular\.ttf$/;

async function controlled(page: Page) {
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
    if (!navigator.serviceWorker.controller) {
      await new Promise<void>(resolve => navigator.serviceWorker.addEventListener('controllerchange', () => resolve(), { once: true }));
    }
  });
}
async function readiness(page: Page) {
  await page.getByRole('button', { name: 'Menu' }).click();
  return page.getByRole('region', { name: 'Bez internetu' });
}

test('capture installs and reopens offline while the directory and PDF downloads fail', async ({ page, context }) => {
  await context.setGeolocation({ latitude: points.barn.point.lat, longitude: points.barn.point.lon, accuracy: 12 });
  await context.route(directory, route => route.abort());
  await context.route(pdfFont, route => route.abort());
  await page.goto('/');
  await controlled(page);
  await page.getByRole('button', { name: 'Zapisz miejsce i czas' }).click();
  await expect(page.locator('#receipt')).toBeVisible();

  await context.setOffline(true);
  await page.reload();
  await page.getByRole('button', { name: 'Bór czuwa' }).click();
  await expect(page.locator('.continuation')).toContainText('Dokończ zgłoszenie');
  await page.getByRole('button', { name: 'Zapisz miejsce i czas' }).click();
  await expect(page.locator('#receipt')).toBeVisible();

  const region = await readiness(page);
  await expect(region.getByRole('status')).toContainText('Bez internetu nie zadziałają katalog urzędów i PDF');
  await expect(region).toContainText('Pliki pobiorą się same, gdy wróci internet.');
  await expect(region.getByRole('button', { name: 'Pobierz brakujące pliki' })).toHaveCount(0);
  await expect(region.locator('dl')).toHaveCount(0);

  await context.unroute(directory);
  await context.unroute(pdfFont);
  // Reconnecting resumes the downloads without the Reporter asking.
  await context.setOffline(false);
  await expect(region.getByRole('status')).toContainText('Gotowe do pracy bez internetu', { timeout: 20_000 });
  await expect(region.getByRole('button', { name: 'Pobierz brakujące pliki' })).toHaveCount(0);

  await context.setOffline(true);
  await page.reload();
  const again = page.getByRole('region', { name: 'Bez internetu' });
  await expect(again.getByRole('status')).toContainText('Gotowe do pracy bez internetu');

  const keys = await page.evaluate(async () => {
    const found: string[] = [];
    for (const name of await caches.keys()) {
      for (const request of await (await caches.open(name)).keys()) found.push(new URL(request.url).pathname + new URL(request.url).search);
    }
    return found;
  });
  expect(keys.length).toBeGreaterThan(0);
  expect(keys).toContain('/brand/favicon.svg');
  expect(keys).toContain('/webview-update.html');
  expect(keys).toContain('/webview-update.css');
  for (const key of keys) {
    expect(key).toMatch(/^\/(_app\/immutable\/[^?]+|fonts\/[^/?]+\.(woff2|ttf|txt)|legal\/(privacy|terms)\/v1\/|brand\/favicon\.svg|webview-update\.(html|css))?$/);
  }
});

test('an interrupted installation recovers from the menu', async ({ page, context }) => {
  await context.route('**/legal/terms/v1/', route => route.request().serviceWorker() ? route.abort() : route.continue());
  await page.goto('/');
  const region = await readiness(page);
  await expect(region.getByRole('status')).toContainText('Aplikacja otworzy się tylko z internetem', { timeout: 20_000 });
  await expect(region).not.toContainText('Zapis zgłoszeń już działa bez internetu.');

  await context.unroute('**/legal/terms/v1/');
  await region.getByRole('button', { name: 'Pobierz brakujące pliki' }).click();
  await expect(region.getByRole('status')).toContainText('Gotowe do pracy bez internetu', { timeout: 20_000 });
  await controlled(page);

  await context.setOffline(true);
  await page.reload();
  await page.getByRole('button', { name: 'Bór czuwa' }).click();
  await expect(page.getByRole('button', { name: 'Zapisz miejsce i czas' })).toBeEnabled();
});

test('Menu says when only the authority directory needs a connection', async ({ page, context }) => {
  await context.route(directory, route => route.abort());
  await page.goto('/');
  await controlled(page);
  const region = await readiness(page);
  await expect(region.getByRole('status')).toContainText('Bez internetu nie zadziała katalog urzędów', { timeout: 20_000 });
  await expect(region).not.toContainText('i PDF');
  await expect(region.getByRole('button', { name: 'Pobierz brakujące pliki' })).toBeVisible();
  await context.setOffline(true);
  await expect(region.getByRole('button', { name: 'Pobierz brakujące pliki' })).toHaveCount(0);
  await context.unroute(directory);
  await context.setOffline(false);
  await expect(region.getByRole('status')).toContainText('Gotowe do pracy bez internetu', { timeout: 20_000 });
});

test('Menu reports a download before claiming offline readiness', async ({ page, context }) => {
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  await context.route(pdfFont, route => route.abort());
  try {
    await page.goto('/');
    await controlled(page);
    const region = await readiness(page);
    await expect(region.getByRole('status')).toContainText('Bez internetu nie zadziała PDF', { timeout: 20_000 });
    await context.unroute(pdfFont);
    await context.route(pdfFont, async route => { await held; await route.continue(); });
    await region.getByRole('button', { name: 'Pobierz brakujące pliki' }).click();
    await expect(region.getByRole('status')).toContainText('Pobieram pliki do pracy bez internetu…');
    await expect(region).toContainText('Zapis zgłoszeń już działa bez internetu.');
    await expect(region.getByRole('button', { name: 'Pobierz brakujące pliki' })).toHaveCount(0);
    const language = page.getByRole('button', { name: 'Polski', exact: true });
    await language.focus();
    release();
    await expect(region.getByRole('status')).toContainText('Gotowe do pracy bez internetu', { timeout: 20_000 });
    const confirmation = page.locator('.brief-confirmation');
    await expect(confirmation).toHaveText('Pliki pobrane. Aplikacja działa bez internetu.');
    await expect(language).toBeFocused();
    await expect(page.locator('.sr-only[role="status"]')).toHaveText('Pliki pobrane. Aplikacja działa bez internetu.');
    await page.waitForTimeout(300);
    const links = await page.locator('.menu-list').boundingBox();
    await expect(confirmation).toHaveCount(0, { timeout: 6000 });
    expect(await page.locator('.menu-list').boundingBox()).toEqual(links);
    await context.setOffline(true);
    await context.setOffline(false);
    await expect(region.getByRole('status')).toContainText('Gotowe do pracy bez internetu');
    await expect(confirmation).toHaveCount(0);
    await page.reload();
    await expect(page.getByRole('region', { name: 'Bez internetu' }).getByRole('status')).toContainText('Gotowe do pracy bez internetu');
    await expect(page.locator('.sr-only[role="status"]')).not.toHaveText('Pliki pobrane. Aplikacja działa bez internetu.');
    await expect(confirmation).toHaveCount(0);
  } finally { release(); }
});

test('background downloads preserve the Draft confirmation outside Menu', async ({ page, context }) => {
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  await context.route(pdfFont, async route => { await held; await route.continue(); });
  try {
    await context.setGeolocation({ latitude: points.barn.point.lat, longitude: points.barn.point.lon, accuracy: 12 });
    await page.goto('/');
    await controlled(page);
    await page.getByRole('button', { name: 'Zapisz miejsce i czas' }).click();
    await expect(page.locator('#receipt')).toBeVisible();
    await page.getByRole('button', { name: 'Dokończę później' }).click();
    const confirmation = page.locator('.brief-confirmation');
    await expect(confirmation).toHaveText('Zapisane na telefonie. Dokończysz, kiedy zechcesz.');
    await page.evaluate(() => {
      const seen: string[] = [];
      (window as typeof window & { downloadFeedback?: string[] }).downloadFeedback = seen;
      const sample = () => {
        document.querySelectorAll('.brief-confirmation').forEach(el => seen.push(el.textContent?.trim() ?? ''));
        requestAnimationFrame(sample);
      };
      requestAnimationFrame(sample);
    });
    release();
    await expect(confirmation).toHaveCount(0, { timeout: 6000 });
    expect(await page.evaluate(() => [...new Set((window as typeof window & { downloadFeedback?: string[] }).downloadFeedback)]))
      .toEqual(['Zapisane na telefonie. Dokończysz, kiedy zechcesz.']);
  } finally { release(); }
});

test('offline, the PDF button waits for the PDF engine and says why', async ({ page, context }) => {
  await context.setGeolocation({ latitude: points.edge.point.lat, longitude: points.edge.point.lon, accuracy: 8 });
  await context.route(pdfFont, route => route.abort());
  await page.goto('/');
  await controlled(page);
  const region = await readiness(page);
  await expect(region.getByRole('status')).toContainText('Bez internetu nie zadziała PDF', { timeout: 20_000 });
  await expect(region.getByRole('button', { name: 'Pobierz brakujące pliki' })).toBeVisible();

  await context.setOffline(true);
  await page.reload();
  await page.getByRole('button', { name: 'Bór czuwa' }).click();
  await page.getByRole('button', { name: 'Człowiek z bronią', exact: true }).click();
  await finishFromWhen(page, false);
  await page.getByRole('button', { name: 'Zapisz zgłoszenie' }).click();
  await page.getByRole('button', { name: 'Przygotuj powiadomienie' }).click();
  await page.getByRole('button', { name: 'Wybierz jednostkę po nazwie', exact: true }).click();
  await page.getByLabel('Nazwa lub miejscowość').fill('Monkach');
  await page.getByRole('button', { name: /Komenda Powiatowa Policji w Mońkach/ }).click();
  await page.getByRole('button', { name: 'Dalej: podpis' }).click();
  await page.getByRole('radio', { name: 'Z podpisem' }).check();
  await page.getByLabel('Imię i nazwisko').fill('Jan Kowalski');
  await page.getByLabel('Adres do korespondencji').fill('ul. Leśna 1, 19-100 Mońki');
  await page.getByRole('button', { name: 'Przygotuj powiadomienia' }).click();
  await openNoticeRow(page);
  await fileAsPdf(page);
  const button = page.getByRole('button', { name: 'Pobierz PDF' });
  await expect(button).toBeDisabled();
  await expect(button).toHaveAccessibleDescription('Bez internetu PDF jeszcze nie działa. Po połączeniu aplikacja pobierze potrzebne pliki.');

  await context.unroute(pdfFont);
  await context.setOffline(false);
  await expect(button).toBeEnabled();
  await expect(page.getByText('Bez internetu PDF jeszcze nie działa', { exact: false })).toHaveCount(0);
});
