import { expect, type Locator, type Page, type Request } from '@playwright/test';
import { pdfRoute, pdfSwitch } from './demo.ts';

// Steps through Draft completion: Kiedy, Gdzie, Sprawdź. Each helper waits for the screen it lands on.
export const footer = (page: Page) => page.locator('.screen-foot');

export async function expectCurrentConfirmation(page: Page, text: string) {
  const current = page.locator('.brief-confirmation:not([inert])');
  await expect(current).toHaveCount(1);
  await expect(current).toHaveText(text);
  await expect(current).toBeVisible();
}

/** Preparation opens the first Notice directly; the correspondence list remains a secondary route. */
export async function openNoticeRow(page: Page, name?: string | number) {
  await expect(page).toHaveURL(/screen=(notice|notices)&/);
  if (new URL(page.url()).searchParams.get('screen') === 'notice') {
    // With one Notice there is no list to open, so that Notice is the one asked for.
    await expect(page.locator('main h1')).toBeVisible();
    await settled(page);
    const several = await page.getByRole('button', { name: 'Wszystkie powiadomienia' }).count();
    if (!several || name === undefined || name === 0 || (typeof name === 'string' && await page.getByRole('heading', { name, exact: true }).count())) return;
    await page.getByRole('button', { name: 'Wszystkie powiadomienia' }).click();
  }
  const rows = page.locator('.rows .row');
  await (typeof name === 'string' ? rows.filter({ hasText: name }) : name === -1 ? rows.last() : rows.first()).click();
}
export const heading = (page: Page, name: string | RegExp) => page.getByRole('heading', { level: 1, name });

/** A Signed Notice with a verified email goes by mail unless the Reporter switches it to the PDF route. */
export async function fileAsPdf(page: Page) {
  await settled(page);
  await page.getByRole('button', { name: pdfSwitch }).first().click();
  await expect(page.getByText(pdfRoute, { exact: true })).toBeVisible();
}

/** Opens "Inne sposoby przekazania", where copying and photos live. */
export async function otherWays(page: Page) {
  const summary = page.locator('summary', { hasText: 'Inne sposoby przekazania' });
  if (!await summary.locator('xpath=..').evaluate(details => (details as HTMLDetailsElement).open)) await summary.click();
}

/** Starts a Draft from an Event row and lands on Kiedy. */
export async function startEvent(page: Page, label: string) {
  await page.getByRole('button', { name: label, exact: true }).click();
  await expect(heading(page, 'Kiedy to się stało?')).toBeVisible();
}

/** Answers Teraz, which moves on by itself. */
export async function answerNow(page: Page) {
  await page.getByRole('button', { name: /^Teraz/ }).click();
  await expect(heading(page, 'Kiedy to się stało?')).toHaveCount(0);
}

/** Leaves the compass with whatever is set (Pomiń when nothing is). */
export async function leaveCompass(page: Page) {
  await footer(page).getByRole('button', { name: /^(Pomiń kierunek i odległość|Dalej)$/ }).click();
  await expect(heading(page, 'Sprawdź i zapisz')).toBeVisible();
}

const distanceStops = [100, 200, 300, 500, 750, 1000, 1500, 2000, 3000];
/**
 * Sets the direction target by keyboard: Home and 5-degree turns to the bearing, then one Page Up per
 * distance stop out from none. Expects nothing set yet.
 */
export async function setEstimate(page: Page, bearing?: number, metres?: number) {
  await page.getByRole('slider', { name: 'Tarcza kierunku' }).focus();
  if (bearing !== undefined) {
    await page.keyboard.press('Home');
    for (let turn = 0; turn < bearing / 5; turn++) await page.keyboard.press('ArrowRight');
  }
  if (metres !== undefined) for (let stop = 0; stop <= distanceStops.indexOf(metres); stop++) await page.keyboard.press('PageUp');
}

/** After Teraz with a fix: leaves the dial when the Event asks for a direction, else waits for Sprawdź. */
export async function pastCompass(page: Page) {
  const dial = page.getByRole('slider', { name: 'Tarcza kierunku' });
  await expect(heading(page, 'Sprawdź i zapisz').or(dial)).toBeVisible();
  if (await dial.isVisible()) await leaveCompass(page);
}

export async function answerHome(page: Page, atHome: boolean) {
  await page.locator('#home-check').getByRole('button', { name: atHome ? 'Tak' : 'Nie', exact: true }).click();
}

/** Event row to Sprawdź for a Report made now, skipping any optional direction and distance. */
export async function toReview(page: Page, label: string, home?: boolean) {
  await startEvent(page, label);
  await answerNow(page);
  await pastCompass(page);
  if (home !== undefined) await answerHome(page, home);
}

export async function save(page: Page) {
  await footer(page).getByRole('button', { name: 'Zapisz zgłoszenie' }).click();
}

const capturedReportIds = new WeakMap<Page, Set<string>>();

/** Captures the next new Report upload and refuses it, so retries cannot block later capture checks. */
export async function reportPost(page: Page) {
  const ids = capturedReportIds.get(page) ?? new Set<string>();
  capturedReportIds.set(page, ids);
  let captured: (request: Request) => void;
  const request = new Promise<Request>(resolve => { captured = resolve; });
  await page.route('**/api/reports', async route => {
    if (route.request().method() !== 'POST') return route.fallback();
    const id = route.request().postDataJSON().id as string;
    if (!ids.has(id)) {
      ids.add(id);
      captured(route.request());
    }
    await route.fulfill({ status: 400, json: { error: 'validation_refused' } });
  });
  return { request };
}

/**
 * Answers Report uploads, Findings polls and Notice events in the page, for journeys that never read
 * server state. Every live upload spends one of the test address's 50 daily Reports, and the whole
 * browser suite shares that budget. A 404 on Findings or events would restore the Report, so all three are answered.
 */
export async function stubReportServer(page: Page) {
  await page.route('**/api/reports', route => route.request().method() === 'POST'
    ? route.fulfill({ status: 201, json: { id: route.request().postDataJSON().id } })
    : route.fallback());
  await page.route('**/api/reports/*/findings', route => route.fulfill({ json: { status: 'pending' } }));
  await page.route('**/api/reports/*/events', route => route.fulfill({ status: 201, json: { id: route.request().postDataJSON().id } }));
}

/** Stands in for OpenStreetMap so map steps never leave the machine. */
export async function blankTiles(page: Page) {
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/58BAwAI/AL+hc2rNAAAAABJRU5ErkJggg==', 'base64');
  await page.route('https://tile.openstreetmap.org/**', route => route.fulfill({ status: 200, contentType: 'image/png', body: png }));
}

/** Waits out a screen's view transition, whose overlay takes clicks that do not wait for their target. */
export async function settled(page: Page) {
  await page.waitForFunction(() => !document.documentElement.matches(':active-view-transition'));
}

/** Presses a control that stays pressable while it is aria-disabled, which Playwright would otherwise wait out. */
export async function press(page: Page, name: string) {
  await settled(page);
  await footer(page).getByRole('button', { name, exact: true }).click({ force: true });
}

/** From Kiedy to an answered Sprawdź for an Event happening now: Teraz, past any compass, then the home answer. */
export async function finishFromWhen(page: Page, atHome: boolean) {
  await answerNow(page);
  await pastCompass(page);
  await answerHome(page, atHome);
}

/** Opens tiles only when the journey needs to inspect or choose a map point. */
export async function openMap(page: Page) {
  const show = page.getByRole('button', { name: 'Pokaż mapę', exact: true });
  await expect(show.or(page.getByRole('button', { name: 'Ukryj mapę', exact: true }))).toBeVisible();
  if (await show.count()) await show.click();
}

/** On Gdzie's map, places a typed point (exactly, at the radius slider's first stop, if asked) and moves on to Sprawdź. */
export async function choosePoint(page: Page, lat: number, lon: number, exact = false) {
  await openMap(page);
  if (!await page.locator('details.advanced').evaluate(element => (element as HTMLDetailsElement).open)) {
    await page.getByText('Wpisz współrzędne', { exact: true }).click();
  }
  await page.getByLabel('Szerokość geograficzna').fill(String(lat));
  await page.getByLabel('Długość geograficzna').fill(String(lon));
  await page.getByRole('button', { name: 'Wskaż wpisany punkt' }).click();
  if (exact) await page.getByLabel('Jak dokładnie?').press('Home');
  await footer(page).getByRole('button', { name: 'Dalej' }).click();
  await expect(heading(page, 'Sprawdź i zapisz')).toBeVisible();
}

/** Turns Kiedy's hour wheel to a number of hours with the keyboard and waits for it to settle there. */
export async function chooseHours(page: Page, hours: number) {
  const wheel = page.getByRole('spinbutton', { name: 'Ile godzin temu?' });
  await wheel.focus();
  await page.keyboard.press('Home');
  for (let hour = 1; hour < hours; hour++) await page.keyboard.press('ArrowDown');
  await expect(wheel).toHaveAttribute('aria-valuenow', String(hours));
}

/** Chromium's emulated GPS keeps wall time even when page.clock moves the browser clock. */
export async function clockedGeolocation(page: Page) {
  await page.addInitScript(() => {
    const watch = navigator.geolocation.watchPosition.bind(navigator.geolocation);
    navigator.geolocation.watchPosition = (success, failure, options) => watch(position => success({
      coords: position.coords, timestamp: Date.now()
    } as GeolocationPosition), failure, options);
  });
}

/** Enter on the opener, then Tab at once: focus must never enter the panel while it is still revealing, and Anuluj must not take focus back. */
export async function expectQuickTabStaysOut(page: Page, opener: Locator, panelSelector: string) {
  await opener.focus();
  await page.evaluate(selector => {
    const w = window as unknown as { inside: number };
    w.inside = 0;
    const loop = () => { const panel = document.querySelector(selector); if (panel && panel.contains(document.activeElement)) w.inside++; requestAnimationFrame(loop); };
    requestAnimationFrame(loop);
  }, panelSelector);
  await page.keyboard.press('Enter');
  await page.keyboard.press('Tab');
  const moved = await page.evaluate(() => document.activeElement?.textContent?.trim());
  await page.waitForTimeout(800);
  expect(await page.evaluate(() => (window as unknown as { inside: number }).inside), 'frames with focus inside the revealing panel').toBe(0);
  expect(await page.evaluate(() => document.activeElement?.textContent?.trim()), 'focus stays where the user moved it').toBe(moved);
}
