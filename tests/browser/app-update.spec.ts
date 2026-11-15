import { fileAsPdf, openNoticeRow } from './stages.ts';
import { test, expect, type BrowserContext, type Page } from '@playwright/test';
import { finishFromWhen } from './stages.ts';
import { readFile } from 'node:fs/promises';
import { deploymentServer, twoDeployments } from '../helpers/two-versions.ts';
import { demoRecipient } from './demo.ts';

const points = JSON.parse(await readFile(new URL('../../data/fixtures/acceptance.json', import.meta.url), 'utf8'));
const scratch = new URL('../../test-results/two-versions', import.meta.url).pathname;
let deployments: Awaited<ReturnType<typeof twoDeployments>>;
let server: Awaited<ReturnType<typeof deploymentServer>>;

test.beforeAll(async () => { test.setTimeout(120_000); deployments = await twoDeployments(scratch); });
test.beforeEach(async ({ context }) => {
  server = await deploymentServer(deployments.a);
  await context.addInitScript(() => localStorage.setItem('first-launch-seen', '1'));
  await context.setGeolocation({ latitude: points.edge.point.lat, longitude: points.edge.point.lon, accuracy: 8 });
});
test.afterEach(async () => { await server.close(); });

async function open(context: BrowserContext) {
  const page = await context.newPage();
  await page.goto(server.url);
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
    if (!navigator.serviceWorker.controller) {
      await new Promise<void>(resolve => navigator.serviceWorker.addEventListener('controllerchange', () => resolve(), { once: true }));
    }
  });
  return page;
}
const home = (page: Page) => page.getByRole('button', { name: 'Bór czuwa' }).click();
async function pdfReady(page: Page) {
  await page.getByRole('button', { name: 'Menu' }).click();
  await expect(page.getByRole('region', { name: 'Bez internetu' }).getByRole('status')).toContainText('Gotowe do pracy bez internetu', { timeout: 20_000 });
  await home(page);
}
async function saveReport(page: Page) {
  await home(page);
  await page.getByRole('button', { name: 'Człowiek z bronią', exact: true }).click();
  await finishFromWhen(page, false);
  await page.getByRole('button', { name: 'Zapisz zgłoszenie' }).click();
  await expect(page.getByRole('button', { name: 'Przygotuj powiadomienie' })).toBeVisible();
}
async function signedNotice(page: Page) {
  await saveReport(page);
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
  await expect(page.getByRole('button', { name: 'Pobierz PDF' })).toBeEnabled();
}
async function deployB(page: Page) {
  server.deploy(deployments.b);
  await page.evaluate(async () => { await (await navigator.serviceWorker.ready).update(); });
  await expect.poll(() => page.evaluate(async () => !!(await navigator.serviceWorker.getRegistration())?.waiting),
    { timeout: 30_000 }).toBe(true);
}
const waiting = (page: Page) => page.evaluate(async () => !!(await navigator.serviceWorker.getRegistration())?.waiting);
const localRecords = (page: Page) => page.evaluate(async () => {
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open('bor-czuwa');
    request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
  });
  const all = (store: string) => new Promise<any[]>(resolve => {
    const request = db.transaction(store).objectStore(store).getAll();
    request.onsuccess = () => resolve(request.result);
  });
  const result = {
    version: db.version,
    drafts: (await all('drafts')).map(item => `${item.id}:${item.note ?? ''}`).sort(),
    reports: (await all('reports')).map(item => `${item.report.id}:${item.token}:${item.events.map((e: any) => e.kind).join()}`).sort(),
    withdrawals: (await all('withdrawals')).map(item => `${item.id}:${item.token}`).sort()
  };
  db.close();
  return result;
});
const cacheVersions = (page: Page) => page.evaluate(async () =>
  [...new Set((await caches.keys()).map(key => /^app-([0-9a-f]{40}|\d+)-/.exec(key)?.[1]).filter(Boolean))].sort());

test('an open tab keeps its PDF and records when another tab updates', async ({ context }) => {
  const first = await open(context);
  await pdfReady(first);
  await saveReport(first);
  await saveReport(first);
  await first.getByRole('button', { name: 'Wycofaj zgłoszenie' }).click();
  await first.getByRole('button', { name: 'Wycofaj', exact: true }).click();
  await expect(first.getByText('Usuwanie z serwera w toku', { exact: false })).toBeVisible();
  await first.getByRole('button', { name: 'Wróć do ekranu głównego' }).click();
  await first.getByRole('button', { name: 'Zapisz miejsce i czas' }).click();
  await first.getByRole('button', { name: 'Człowiek z bronią', exact: true }).click();
  await finishFromWhen(first, false);
  await first.locator('summary', { hasText: 'Notatka' }).click();
  await first.getByLabel('Co jeszcze chcesz przekazać?').fill('Strzały od strony lasu');

  const second = await open(context);
  await signedNotice(second);
  const abandoned = await open(context);

  await deployB(first);
  await first.getByRole('button', { name: 'Menu' }).click();
  const before = await localRecords(first);
  expect(before.version).toBe(6);
  const version = first.getByRole('region', { name: 'Wersja aplikacji' });
  await expect(version).toContainText('Nowa wersja czeka');
  // The waiting version already holds its own PDF engine, so restarting offline would keep PDF export.
  expect(await first.evaluate(async ({ name, path }) => !!(await (await caches.open(name)).match(path)),
    { name: `app-${deployments.versionB}-pdf`, path: deployments.pdfB })).toBe(true);
  await Promise.all([first.waitForEvent('load'), version.getByRole('button', { name: 'Uruchom nową wersję' }).click()]);
  await expect(first.getByRole('heading', { name: 'Menu' })).toBeVisible();
  await expect(version).toHaveCount(0);

  // The new version upgrades the local database the first time it opens it.
  await expect.poll(async () => (await localRecords(first)).version).toBe(7);
  const after = await localRecords(first);
  expect(after.drafts).toEqual(before.drafts);
  expect(after.drafts.some(item => item.endsWith(':Strzały od strony lasu'))).toBe(true);
  expect(after.reports).toEqual(before.reports);
  expect(after.withdrawals).toEqual(before.withdrawals);
  await first.getByRole('banner').getByRole('button', { name: 'Moje zapisy' }).click();
  await expect(first.getByText('Usuwanie z serwera w toku', { exact: false })).toBeVisible();
  await expect(first.getByText('Serwer chwilowo nie przyjmuje zgłoszeń. Zapisze się samo później.', { exact: true }).first()).toBeVisible();
  // Old version files stay while tabs that started on it are open.
  expect(await cacheVersions(first)).toEqual([deployments.versionA, deployments.versionB].sort());

  await context.setOffline(true);
  const download = second.waitForEvent('download');
  await second.getByRole('button', { name: 'Pobierz PDF' }).click();
  expect((await download).suggestedFilename()).toMatch(/\.pdf$/);
  await expect(second.getByText(demoRecipient ? 'PDF testowy gotowy.' : 'PDF przygotowany', { exact: false }).first()).toBeAttached();

  // The old tab cannot write to the upgraded database and says what to do instead of losing the Draft.
  await home(second);
  await second.getByRole('button', { name: 'Zapisz miejsce i czas' }).click();
  await expect(second.getByRole('alert')).toContainText('starszej wersji aplikacji');

  await abandoned.close();
  second.once('dialog', dialog => dialog.accept());
  await Promise.all([second.waitForEvent('load'), second.getByRole('button', { name: 'Uruchom nową wersję' }).click()]);
  await expect(second.getByRole('alert')).toHaveCount(0);
  await second.getByRole('button', { name: 'Zapisz miejsce i czas' }).click();
  await expect(second.locator('#receipt')).toBeVisible();
  await expect.poll(() => cacheVersions(second)).toEqual([deployments.versionB]);
});

test('the update waits for signer details held only in memory', async ({ context }) => {
  const posted: string[] = [];
  context.on('request', request => { if (request.postData()) posted.push(request.postData()!); });
  const page = await open(context);
  await saveReport(page);
  await page.getByRole('button', { name: 'Przygotuj powiadomienie' }).click();
  await page.getByRole('button', { name: 'Wybierz jednostkę po nazwie', exact: true }).click();
  await page.getByLabel('Nazwa lub miejscowość').fill('Monkach');
  await page.getByRole('button', { name: /Komenda Powiatowa Policji w Mońkach/ }).click();
  await page.getByRole('button', { name: 'Dalej: podpis' }).click();
  await page.getByRole('radio', { name: 'Z podpisem' }).check();
  await page.getByLabel('Imię i nazwisko').fill('Jan Kowalski');

  await deployB(page);
  await page.getByRole('button', { name: 'Menu' }).click();
  const version = page.getByRole('region', { name: 'Wersja aplikacji' });
  await expect(version).toContainText('Nowa wersja czeka');
  const [question] = await Promise.all([page.waitForEvent('dialog'), version.getByRole('button', { name: 'Uruchom nową wersję' }).click()]);
  expect(question.message()).toContain('dane do podpisu');
  await question.dismiss();
  await page.getByRole('button', { name: 'Wróć do aplikacji' }).click();
  await expect(page.getByLabel('Imię i nazwisko')).toHaveValue('Jan Kowalski');

  await page.getByRole('button', { name: 'Menu' }).click();
  page.once('dialog', dialog => void dialog.accept());
  await Promise.all([page.waitForEvent('load'), version.getByRole('button', { name: 'Uruchom nową wersję' }).click()]);
  await expect(version).toHaveCount(0);
  expect(posted.filter(body => body.includes('Kowalski'))).toEqual([]);
});

test('an old tab without its PDF files offers a safe restart instead of a false export', async ({ context }) => {
  await context.route(/\/fonts\/NotoSans-Regular\.ttf$/, route => route.abort());
  await context.route(`**${deployments.pdfA}`, route => route.abort());
  const old = await open(context);
  await signedNotice(old);
  await context.unrouteAll();

  const other = await open(context);
  await deployB(other);
  await other.getByRole('button', { name: 'Menu' }).click();
  await Promise.all([other.waitForEvent('load'), other.getByRole('button', { name: 'Uruchom nową wersję' }).click()]);
  await pdfReady(other);

  await context.setOffline(true);
  await old.getByRole('button', { name: 'Pobierz PDF' }).click();
  await expect(old.getByRole('alert')).toContainText('Uruchom aplikację ponownie');
  await expect(old.getByText('PDF przygotowany', { exact: false })).toHaveCount(0);
  old.once('dialog', dialog => dialog.accept());
  await Promise.all([old.waitForEvent('load'), old.getByRole('button', { name: 'Uruchom aplikację ponownie' }).click()]);
  // The same Notice reopens and asks again for the details the warning said would not survive.
  await expect(old.getByText('Dane podpisu nie zostały zapamiętane', { exact: false })).toBeVisible();
  await expect(old.getByLabel('Imię i nazwisko')).toHaveValue('');
});

// Closing every window lets the browser start a waiting version by itself. These tests start the app
// again while its old page still exists, which a reload does.
const recordPaint = (page: Page) => page.addInitScript(() => addEventListener('pagehide', () =>
  sessionStorage.setItem('painted', `${sessionStorage.getItem('painted') ?? ''}${document.querySelector('h1') ? 1 : 0}`)));

test('a waiting update starts by itself at the next idle start, before the old version paints', async ({ context }) => {
  test.setTimeout(90_000);
  const page = await open(context);
  await saveReport(page);
  const before = await localRecords(page);
  await deployB(page);
  await page.getByRole('button', { name: 'Menu' }).click();
  await expect(page.getByRole('region', { name: 'Wersja aplikacji' })).toBeVisible();
  await home(page);
  // Home has no update panel: capture stays the first thing there.
  await expect(page.getByRole('button', { name: 'Uruchom nową wersję' })).toHaveCount(0);

  await recordPaint(page);
  await page.reload();
  await expect(page.getByRole('button', { name: 'Zapisz miejsce i czas' })).toBeVisible();
  await expect.poll(async () => (await localRecords(page)).version).toBe(7);
  expect(await waiting(page)).toBe(false);
  // The old version was replaced once, before it drew anything.
  expect(await page.evaluate(() => sessionStorage.getItem('painted'))).toBe('0');
  expect((await localRecords(page)).reports).toEqual(before.reports);
  // The new version's first preparation removes the old one's files.
  await expect.poll(() => cacheVersions(page)).toEqual([deployments.versionB]);
  await page.getByRole('button', { name: 'Menu' }).click();
  await expect(page.getByRole('region', { name: 'Wersja aplikacji' })).toHaveCount(0);
});

test('an update arriving mid-Draft never restarts the app and waits for an idle start', async ({ context }) => {
  test.setTimeout(90_000);
  const page = await open(context);
  await page.getByRole('button', { name: 'Zapisz miejsce i czas' }).click();
  await page.getByRole('button', { name: 'Człowiek z bronią', exact: true }).click();
  await finishFromWhen(page, false);
  await page.locator('summary', { hasText: 'Notatka' }).click();
  await page.getByLabel('Co jeszcze chcesz przekazać?').fill('Strzały od strony lasu');
  let loads = 0;
  page.on('load', () => { loads += 1; });

  await deployB(page);
  await page.waitForTimeout(1500);
  expect(loads).toBe(0);
  await expect(page.getByLabel('Co jeszcze chcesz przekazać?')).toHaveValue('Strzały od strony lasu');
  await page.getByRole('button', { name: 'Menu' }).click();
  const version = page.getByRole('region', { name: 'Wersja aplikacji' });
  await expect(version).toContainText('Nowa wersja czeka');
  await expect(version).toContainText('Uruchomi się sama, gdy następnym razem otworzysz aplikację.');
  await page.getByRole('button', { name: 'Wróć do aplikacji' }).click();
  await expect(page.getByLabel('Co jeszcze chcesz przekazać?')).toHaveValue('Strzały od strony lasu');

  // A new window starts on an idle screen, but the Draft window is still running, so nothing changes.
  const other = await context.newPage();
  await other.goto(server.url);
  await expect(other.getByRole('button', { name: 'Zapisz miejsce i czas' })).toBeVisible();
  expect((await localRecords(other)).version).toBe(6);
  expect(await waiting(other)).toBe(true);
  await other.close();
  expect(loads).toBe(0);

  // Starting again straight into the Draft is not idle either.
  await expect.poll(async () => (await localRecords(page)).drafts.some(item => item.endsWith(':Strzały od strony lasu'))).toBe(true);
  await page.reload();
  await expect(page.getByRole('heading', { level: 1, name: 'Sprawdź i zapisz' })).toBeVisible();
  expect((await localRecords(page)).version).toBe(6);
  expect(await waiting(page)).toBe(true);

  // Leaving the Draft for home inside the app, or going Back to it, is no restart; the next start is.
  const settled = loads;
  await home(page);
  await page.waitForTimeout(1000);
  await page.getByRole('button', { name: 'Menu' }).click();
  await page.goBack();
  await page.waitForTimeout(1000);
  expect(loads).toBe(settled);
  expect(await waiting(page)).toBe(true);
  await page.reload();
  await expect(page.getByRole('button', { name: 'Zapisz miejsce i czas' })).toBeVisible();
  await expect.poll(async () => (await localRecords(page)).version).toBe(7);
  expect((await localRecords(page)).drafts.some(item => item.endsWith(':Strzały od strony lasu'))).toBe(true);
});
