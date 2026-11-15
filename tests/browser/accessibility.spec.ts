import { blankTiles, openMap, openNoticeRow, expectCurrentConfirmation } from './stages.ts';
import { test, expect, firefox, type Page } from '@playwright/test';
import { finishFromWhen, leaveCompass, setEstimate } from './stages.ts';
import { readFile } from 'node:fs/promises';
import { android, seedDrafts } from './native-notifications.ts';
import { undersizedTargets, untilSettled } from '../../scripts/faza6-targets.mjs';
import { translate } from '../../src/lib/strings.ts';
import { demoRecipient, openLegalDraft, pdfConfirmation, pdfSwitch } from './demo.ts';

const points = JSON.parse(await readFile(new URL('../../data/fixtures/acceptance.json', import.meta.url), 'utf8'));
// A real computed result for the edge point, so these journeys do not spend the server's 50 Reports a day.
const computedFindings = await readFile(new URL('./computed-findings.json', import.meta.url), 'utf8');

async function answerForServer(page: Page) {
  await page.route('**/api/reports', route => route.fulfill({ status: 201, contentType: 'application/json', body: '{"id":"accepted"}' }));
  await page.route('**/api/reports/*/findings', route => route.fulfill({ status: 200, contentType: 'application/json', body: computedFindings }));
  await page.route('**/api/reports/*/events', route => route.fulfill({ status: 201, contentType: 'application/json', body: '{}' }));
}

// The product contract: 56 CSS px effective targets for cold or gloved thumbs, text reflowing at
// 320 CSS px with doubled text, and AA contrast in each palette.
const configs = [
  { name: '390', width: 390, height: 844, text: 1, touch: true },
  { name: '320@200%', width: 320, height: 640, text: 2, touch: true },
  { name: '390@200%', width: 390, height: 844, text: 2, touch: true },
  { name: 'landscape', width: 844, height: 390, text: 1, touch: true },
  { name: 'desktop', width: 1280, height: 800, text: 1, touch: false }
];

type Measure = { hits: string[]; clips: string[]; contrast: string[] };

/** Measures the rendered page. A radio or checkbox inside a label counts as its label's box. */
function measure(page: Page, withContrast: boolean): Promise<Measure> {
  return page.evaluate(withContrast => {
    const describe = (el: Element) => {
      const text = (el.getAttribute('aria-label') || el.textContent || (el as HTMLInputElement).name || '').replace(/\s+/g, ' ').trim().slice(0, 48);
      return `${el.tagName.toLowerCase()}${el.className && typeof el.className === 'string' ? '.' + el.className.split(' ')[0] : ''} "${text}"`;
    };
    const shown = (el: Element) => {
      const rect = el.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0 && el.checkVisibility({ visibilityProperty: true, opacityProperty: false });
    };
    const hits: string[] = [];
    const clips: string[] = [];
    const contrast: string[] = [];
    const seen = new Set<Element>();
    const controls = document.querySelectorAll('button, a[href], summary, input:not([type=hidden]), select, textarea, [tabindex]:not([tabindex="-1"])');
    for (const control of controls) {
      if (!shown(control) && !(control instanceof HTMLInputElement)) continue;
      let target: Element = control;
      if (control instanceof HTMLInputElement && ['radio', 'checkbox', 'file'].includes(control.type)) target = control.closest('label') ?? control;
      if (!shown(target) || seen.has(target)) continue;
      seen.add(target);
      // WCAG 2.5.8 exempts links inside a sentence; the product contract does too.
      const inline = control instanceof HTMLAnchorElement && getComputedStyle(control).display === 'inline';
      const rect = target.getBoundingClientRect();
      if (!inline && (rect.height < 55.5 || rect.width < 55.5)) hits.push(`${describe(target)} ${Math.round(rect.width)}x${Math.round(rect.height)}`);
      if (rect.left < -0.5 || rect.right > innerWidth + 0.5) clips.push(`${describe(target)} outside viewport ${Math.round(rect.left)}..${Math.round(rect.right)}`);
      for (let parent = target.parentElement; parent; parent = parent.parentElement) {
        const style = getComputedStyle(parent);
        const box = parent.getBoundingClientRect();
        const clipsX = ['hidden', 'clip'].includes(style.overflowX);
        const clipsY = ['hidden', 'clip'].includes(style.overflowY);
        if (clipsX && (rect.left < box.left - 0.5 || rect.right > box.right + 0.5) && !parent.matches('.map-surface, .area-canvas'))
          clips.push(`${describe(target)} clipped by ${describe(parent).slice(0, 30)} ${Math.round(rect.right)}>${Math.round(box.right)}`);
        if (clipsY && (rect.top < box.top - 0.5 || rect.bottom > box.bottom + 0.5) && !parent.matches('.app-shell'))
          clips.push(`${describe(target)} clipped vertically by ${describe(parent).slice(0, 30)}`);
      }
      if (control instanceof HTMLButtonElement && control.scrollWidth > control.clientWidth + 1)
        clips.push(`${describe(control)} text overflows ${control.scrollWidth}>${control.clientWidth}`);
    }
    for (const scroller of document.querySelectorAll('.screen-body, .masthead, .screen-foot')) {
      if (scroller.scrollWidth <= scroller.clientWidth + 1) continue;
      // Name the innermost elements that stick out, so the report says what forces the width.
      const edge = scroller.getBoundingClientRect().right;
      const culprits = [...scroller.querySelectorAll('*')].filter(el => el.getBoundingClientRect().right > edge + 1
        && ![...el.children].some(child => child.getBoundingClientRect().right > edge + 1)).slice(0, 3).map(describe);
      clips.push(`${describe(scroller).slice(0, 30)} scrolls sideways ${scroller.scrollWidth}>${scroller.clientWidth} because of ${culprits.join(', ')}`);
    }
    if (withContrast) {
      const rgb = (value: string) => value.match(/[\d.]+/g)!.map(Number);
      const luminance = ([r, g, b]: number[]) => {
        const channel = (c: number) => { c /= 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
        return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
      };
      const ratio = (a: number[], b: number[]) => { const [x, y] = [luminance(a), luminance(b)].sort((m, n) => n - m); return (x + 0.05) / (y + 0.05); };
      const background = (el: Element | null): number[] => {
        for (; el; el = el.parentElement) {
          const color = rgb(getComputedStyle(el).backgroundColor);
          if (color.length < 4 || color[3] > 0.5) return color;
        }
        return [255, 255, 255];
      };
      const reported = new Set<string>();
      const walker = document.createTreeWalker(document.querySelector('.app-shell') ?? document.body, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        const el = node.parentElement!;
        if (!node.textContent!.trim() || !shown(el) || el.closest('.sr-only, .area-map, .map-shell, button:disabled, [aria-hidden="true"]')) continue;
        const style = getComputedStyle(el);
        const size = parseFloat(style.fontSize);
        const large = size >= 24 || (size >= 18.66 && Number(style.fontWeight) >= 700);
        const value = ratio(rgb(style.color), background(el));
        const key = `${describe(el)} ${value.toFixed(2)}`;
        if (value < (large ? 3 : 4.5) && !reported.has(key)) { reported.add(key); contrast.push(key); }
      }
      // Field borders and choice glyphs are non-text contrast: 3:1 against what surrounds them. A field draws
      // its rule as a 2 px bottom border (page.css), so that is the colour read; the top border is 0 px wide.
      for (const field of document.querySelectorAll('input:not([type=radio]):not([type=checkbox]):not([type=file]), select, textarea')) {
        if (!shown(field)) continue;
        const value = ratio(rgb(getComputedStyle(field).borderBottomColor), background(field.parentElement));
        if (value < 3) contrast.push(`${describe(field)} border ${value.toFixed(2)}`);
      }
      for (const choice of document.querySelectorAll('input[type=radio], input[type=checkbox]')) {
        if (!shown(choice)) continue;
        const value = ratio(rgb(getComputedStyle(choice).accentColor.startsWith('rgb') ? getComputedStyle(choice).accentColor : getComputedStyle(choice).color), background(choice.parentElement));
        if (value < 3) contrast.push(`${describe(choice.closest('label') ?? choice)} glyph ${value.toFixed(2)}`);
      }
    }
    return { hits, clips, contrast };
  }, withContrast);
}

/** Visible text smaller than the app's supporting size at default text (0.88 × 17 px), its minimum for reading
 *  outdoors. Absolute on purpose: under 360 px the chrome caps doubled text at 22 px, which is still well above it. */
function smallText(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const floor = 0.88 * 17 - 0.05;
    const found = new Set<string>();
    const walker = document.createTreeWalker(document.querySelector('.app-shell') ?? document.body, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const el = node.parentElement!;
      const rect = el.getBoundingClientRect();
      if (!node.textContent!.trim() || !rect.width || !rect.height || el.closest('.sr-only, [aria-hidden="true"]')) continue;
      const size = parseFloat(getComputedStyle(el).fontSize);
      if (size < floor) found.add(`${el.tagName.toLowerCase()}.${String(el.className).split(' ')[0]} "${node.textContent!.trim().slice(0, 32)}" ${size.toFixed(2)}px`);
    }
    return [...found];
  });
}

async function openEverything(page: Page) {
  await page.$$eval('.screen-body details', all => all.forEach(item => { (item as HTMLDetailsElement).open = true; }));
  await page.waitForTimeout(250);
}

async function settle(page: Page) {
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(250);
}

async function computedReport(page: Page) {
  await page.context().setGeolocation({ latitude: points.edge.point.lat, longitude: points.edge.point.lon, accuracy: 8 });
  await page.goto('/');
  await page.getByRole('button', { name: 'Człowiek z bronią', exact: true }).click();
  await finishFromWhen(page, false);
  await page.getByRole('button', { name: 'Zapisz zgłoszenie' }).click();
  await expect(page.locator('.report-status')).toBeVisible({ timeout: 30_000 });
  // The sync row crossfades once the upload lands; walk the page only after it has.
  await expect(page.locator('.report-status > li').first()).toContainText('Zapisano na serwerze', { timeout: 30_000 });
  await page.waitForFunction(() => document.getAnimations().every(animation =>
    animation.playState !== 'running' || animation.effect?.getTiming().iterations === Infinity));
}

/** Walks the journey and hands each state to the check. */
async function journey(page: Page, touch: boolean, check: (state: string) => Promise<void>) {
  await blankTiles(page);
  await answerForServer(page);
  await page.context().setGeolocation({ latitude: points.barn.point.lat, longitude: points.barn.point.lon, accuracy: 12 });
  await page.goto('/');
  await page.getByRole('button', { name: 'Zapisz miejsce i czas' }).click();
  await expect(page.locator('#receipt')).toBeVisible();
  await settle(page); await check('receipt');
  await page.getByRole('button', { name: 'Bór czuwa' }).click();
  await settle(page); await check('home');
  await page.getByRole('button', { name: 'Menu' }).click();
  await settle(page); await check('menu');
  await page.getByRole('button', { name: 'Informacje na początek' }).click();
  await settle(page); await check('welcome');
  await page.getByRole('button', { name: 'Wróć do aplikacji' }).click();
  await page.getByRole('button', { name: 'Wróć do aplikacji' }).click();

  // Each completion step: Kiedy with its hour select, the shot dial, Sprawdź at home, the map, remains.
  await page.getByRole('button', { name: 'Strzał', exact: true }).click();
  await page.getByRole('button', { name: 'Kilka godzin temu' }).click();
  await settle(page); await check('when: hours');
  await page.getByRole('button', { name: /^Teraz/ }).click();
  await expect(page.getByRole('heading', { name: 'Skąd słychać strzał?' })).toBeVisible();
  await setEstimate(page, 0, 1000);
  await settle(page); await check('where: compass');
  await page.locator('.screen-foot').getByRole('button', { name: 'Dalej' }).click();
  await page.locator('#home-check').getByRole('button', { name: 'Tak', exact: true }).click();
  await openEverything(page);
  await settle(page); await check('review: shot at home');

  // No fix: the map with its radius and the folded search.
  await page.context().clearPermissions();
  await page.goto('/');
  await page.getByRole('button', { name: 'Człowiek z bronią', exact: true }).click();
  await page.getByRole('button', { name: /^Teraz/ }).click();
  await openMap(page);
  await page.locator('.map-surface').click({ position: { x: 120, y: 120 } });
  await openEverything(page);
  await settle(page); await check('where: map');

  await page.goto('/');
  await page.getByRole('button', { name: 'Szczątki w lesie', exact: true }).click();
  await page.getByRole('button', { name: /^Teraz/ }).click();
  await openMap(page);
  await page.locator('.map-surface').click({ position: { x: 120, y: 120 } });
  await page.locator('.screen-foot').getByRole('button', { name: 'Dalej' }).click();
  await expect(page.getByText('Z galerii')).toBeVisible();
  await page.evaluate(async () => {
    const canvas = Object.assign(document.createElement('canvas'), { width: 40, height: 30 });
    const blob = await new Promise<Blob>(resolve => canvas.toBlob(value => resolve(value!), 'image/jpeg'));
    const input = document.querySelector<HTMLInputElement>('input[type=file]')!;
    const transfer = new DataTransfer();
    transfer.items.add(new File([blob], 'remains.jpg', { type: 'image/jpeg' }));
    input.files = transfer.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await expect(page.locator('.photo-tile')).toHaveCount(1);
  await page.locator('#home-check').getByRole('button', { name: 'Nie', exact: true }).click();
  await openEverything(page);
  await settle(page); await check('review: remains');
  await page.context().grantPermissions(['geolocation']);

  await computedReport(page);
  await openEverything(page);
  await settle(page); await check('report');
  // Ticket 30: every source of the Findings sits in one sheet, held to the same contract.
  await page.getByRole('button', { name: 'Skąd te wyniki' }).click();
  await expect(page.getByRole('dialog', { name: 'Skąd te wyniki' })).toBeVisible();
  await settle(page); await check('report: sources');
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog', { name: 'Skąd te wyniki' })).toBeHidden();
  // The service worker would answer from its cache, so the first directory load fails in the page.
  await page.evaluate(() => {
    const original = window.fetch;
    window.fetch = (input, init) => String(input).includes('/_app/immutable/assets/') && String(input).endsWith('.json')
      && !document.documentElement.dataset.directoryReachable ? Promise.reject(new TypeError('offline')) : original(input, init);
  });
  await page.getByRole('button', { name: 'Przygotuj powiadomienie' }).click();
  await expect(page.getByRole('alert')).toContainText('Nie udało się wczytać katalogu urzędów.');
  await settle(page); await check('recipients: directory unavailable');
  await page.evaluate(() => { document.documentElement.dataset.directoryReachable = 'yes'; });
  await page.getByRole('button', { name: 'Spróbuj ponownie' }).click();
  await expect(page.getByRole('heading', { name: 'Proponowane urzędy' })).toBeVisible();
  await page.getByRole('button', { name: 'Wybierz inną jednostkę po nazwie' }).click();
  await page.getByLabel('Nazwa lub miejscowość').fill('Monkach');
  await settle(page); await check('recipients');
  await page.getByRole('button', { name: 'Dalej: podpis' }).click();
  await page.getByRole('radio', { name: 'Z podpisem' }).check();
  await settle(page); await check('signature');
  await page.getByLabel('Imię i nazwisko').fill('Test Testowa');
  await page.getByLabel('Adres do korespondencji').fill('ul. Leśna 1, 19-100 Mońki');
  await page.getByRole('button', { name: 'Przygotuj powiadomienia' }).click();
  await settle(page); await check('notices');
  await openNoticeRow(page);
  await openEverything(page);
  await settle(page); await check('notice');
  // Each handoff state of the Notice, then the six-week check-in it leads to.
  await page.getByRole('button', { name: pdfSwitch }).first().click();
  await openEverything(page);
  await settle(page); await check('notice: PDF route');
  await page.locator('.screen-foot').getByRole('button', { name: 'Pobierz PDF' }).click();
  await expect(page.getByRole('heading', { name: 'Udało się wysłać?' })).toBeVisible();
  // The app moves focus to the question once the screen change has finished; walking before that
  // starts the walk at an element Tab cannot reach and shifts its starting point.
  await expect(page.locator('#handoff-question')).toBeFocused();
  await settle(page); await check('notice: handoff question');
  await page.getByRole('button', { name: pdfConfirmation, exact: true }).click();
  await expectCurrentConfirmation(page, 'Zapisano Twoje potwierdzenie. To nie jest potwierdzenie doręczenia.');
  await openEverything(page);
  await settle(page); await check('notice: confirmed');
  await page.getByRole('button', { name: 'Wszystkie powiadomienia' }).click();
  await settle(page); await check('notices: one confirmed');
  if (process.env.VITE_CHECK_IN_ENABLED === 'true') {
    await page.clock.setFixedTime(new Date(Date.now() + 43 * 24 * 60 * 60 * 1000));
    await page.goto('/');
    await page.locator('.continuation .record-main').click();
    await expect(page.getByRole('heading', { name: /^Czy .* odpowiedziała\?$/ })).toBeVisible();
    await settle(page); await check('check-in');
    await page.getByRole('button', { name: 'Wszczęto postępowanie', exact: true }).click();
    await page.getByRole('button', { name: 'Zmień datę' }).click();
    await settle(page); await check('check-in: saved');
  }
  await page.getByRole('button', { name: 'Moje zapisy' }).click();
  await settle(page); await check('library');
}

for (const config of configs) {
  test.describe(`at ${config.name}`, () => {
    test.use({ viewport: { width: config.width, height: config.height }, hasTouch: config.touch, isMobile: config.touch, actionTimeout: 15_000 });

    test('every control keeps a 56 px target, nothing is clipped and no text is too small', async ({ page }) => {
      test.setTimeout(180_000);
      // Set after parsing: an init script runs before <html> exists.
      if (config.text !== 1) await page.addInitScript(scale => document.addEventListener('DOMContentLoaded', () => {
        document.documentElement.style.fontSize = `${17 * scale}px`;
      }), config.text);
      const failures: string[] = [];
      await journey(page, config.touch, async state => {
        expect(await page.evaluate(() => parseFloat(getComputedStyle(document.body).fontSize))).toBe(17 * config.text);
        const { hits, clips } = await measure(page, false);
        failures.push(...hits.map(item => `${state}: target ${item}`), ...clips.map(item => `${state}: ${item}`));
        failures.push(...(await smallText(page)).map(item => `${state}: small text ${item}`));
        // The Faza 6 collector's own measurement must agree: no false rows once the page has settled.
        await untilSettled(page);
        failures.push(...(await undersizedTargets(page)).map(item => `${state}: collector target ${item}`));
      });
      expect(failures).toEqual([]);
    });
  });
}

test.describe('in every palette', () => {
  test.use({ hasTouch: true, isMobile: true, actionTimeout: 15_000 });
  test('text and field borders meet AA contrast in light, dark and noc', async ({ page }) => {
    test.setTimeout(180_000);
    const failures: string[] = [];
    await journey(page, true, async state => {
      for (const theme of ['light', 'dark', 'noc']) {
        await page.evaluate(value => { document.documentElement.dataset.theme = value; }, theme);
        await settle(page);
        const { contrast } = await measure(page, true);
        failures.push(...contrast.map(item => `${theme} ${state}: ${item}`));
      }
    });
    expect(failures).toEqual([]);
  });
});

/** Tabs through the whole page and returns every stop whose ring is missing or faint, or that sits under something else. */
async function tabWalk(page: Page) {
  const problems: string[] = [];
  const stops: string[] = [];
  let last: string | undefined;
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  for (let press = 0; press < 300; press++) {
    await page.keyboard.press('Tab');
    const stop = await page.evaluate(() => {
      const el = document.activeElement;
      if (!el || el === document.body) return null;
      const name = `${el.tagName.toLowerCase()} "${(el.getAttribute('aria-label') || el.textContent || (el as HTMLInputElement).name || '').replace(/\s+/g, ' ').trim().slice(0, 40)}"`;
      const ringed = (node: Element) => { const style = getComputedStyle(node); return style.outlineStyle !== 'none' && parseFloat(style.outlineWidth) >= 2; };
      // A hidden file input shows its ring on the label that looks like the button, the hour wheel on its frame.
      const holder = ringed(el) ? el : el.matches('.file-button input') ? el.closest('label')! : el.matches('.wheel') ? el.closest('.frame')! : null;
      const ring = !!holder && ringed(holder);
      // The ring needs 3:1 against what it is drawn on: the ground around the control, or the control itself
      // when it is drawn inside (teal on the orange band was 1.01:1).
      let faint = '';
      if (ring) {
        const rgb = (value: string) => value.match(/[\d.]+/g)!.map(Number);
        const luminance = ([r, g, b]: number[]) => {
          const channel = (c: number) => { c /= 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
          return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
        };
        const behind = (node: Element | null): number[] => {
          for (; node; node = node.parentElement) { const color = rgb(getComputedStyle(node).backgroundColor); if (color.length < 4 || color[3] > 0.5) return color; }
          return [255, 255, 255];
        };
        const style = getComputedStyle(holder!);
        const [x, y] = [luminance(rgb(style.outlineColor)), luminance(behind(parseFloat(style.outlineOffset) < 0 ? holder : holder!.parentElement))].sort((m, n) => n - m);
        const ratio = (x + 0.05) / (y + 0.05);
        if (ratio < 3) faint = ratio.toFixed(2);
      }
      const rect = el.getBoundingClientRect();
      const x = Math.min(Math.max(rect.left + rect.width / 2, 0), innerWidth - 1);
      const y = Math.min(Math.max(rect.top + Math.min(rect.height / 2, 20), 0), innerHeight - 1);
      const hit = document.elementFromPoint(x, y);
      const covered = !hit || !(el.contains(hit) || hit.contains(el) || hit === el.closest('label'));
      return { key: `${name}#${[...document.querySelectorAll('*')].indexOf(el)}`, name, ring, faint, covered };
    });
    if (!stop) { last = undefined; continue; }
    // Tab walks a date field's day, month and year before leaving it: one stop, not a trap.
    // Coming back to the same element after focus left the page is the cycle, not a repeat.
    if (last === stop.key) continue;
    last = stop.key;
    if (stops[0] === stop.key) return { problems, stops: stops.length };
    stops.push(stop.key);
    if (!stop.ring) problems.push(`no visible focus: ${stop.name}`);
    if (stop.faint) problems.push(`faint focus ring ${stop.faint}:1: ${stop.name}`);
    if (stop.covered) problems.push(`focus obscured: ${stop.name}`);
  }
  problems.push(`focus did not cycle within 300 presses (${stops.length} stops)`);
  return { problems, stops: stops.length };
}

test.describe('with a keyboard', () => {
  test.use({ viewport: { width: 1280, height: 800 }, actionTimeout: 15_000 });
  test('every stop shows its ring, stays visible and focus never traps', async ({ page }) => {
    test.setTimeout(240_000);
    const failures: string[] = [];
    const headingFirst = ['home', 'menu', 'welcome', 'notices', 'library'];
    await journey(page, false, async state => {
      // The receipt's status panel takes focus, so it is read before the question under it.
      if (state === 'receipt' && await page.evaluate(() => document.activeElement?.id) !== 'receipt') failures.push('receipt: focus is not on the status panel');
      if (headingFirst.includes(state)) {
        const focused = await page.evaluate(() => document.activeElement?.tagName);
        if (focused !== 'H1') failures.push(`${state}: screen change left focus on ${focused}`);
      }
      const { problems, stops } = await tabWalk(page);
      if (stops < 3) failures.push(`${state}: only ${stops} focus stops`);
      failures.push(...problems.map(item => `${state}: ${item}`));
    });
    expect(failures).toEqual([]);
  });
});

test.describe('with reduced motion', () => {
  test.use({ hasTouch: true, isMobile: true, actionTimeout: 15_000 });
  test('nothing animates anywhere in the journey', async ({ page }) => {
    test.setTimeout(180_000);
    await page.emulateMedia({ reducedMotion: 'reduce' });
    const failures: string[] = [];
    // Record every animation that starts, so a short one that ends before a check is still caught.
    await page.addInitScript(() => document.addEventListener('animationstart', event => {
      const target = event.target as Element;
      if (parseFloat(getComputedStyle(target).animationDuration) > 0)
        ((window as unknown as { moved: string[] }).moved ??= []).push(`${target.tagName.toLowerCase()}.${target.className} ${event.animationName}`);
    }, true));
    await journey(page, true, async state => {
      const moved = await page.evaluate(() => {
        const running = document.getAnimations().filter(animation => Number(animation.effect?.getComputedTiming().duration) > 0)
          .map(animation => `${(animation as CSSAnimation).animationName ?? (animation as CSSTransition).transitionProperty}`);
        const started = (window as unknown as { moved?: string[] }).moved ?? [];
        (window as unknown as { moved: string[] }).moved = [];
        return [...started, ...running];
      });
      failures.push(...moved.map(item => `${state}: ${item}`));
    });
    expect(failures).toEqual([]);
  });
});

test.describe('on a phone', () => {
  test.use({ hasTouch: true, isMobile: true, actionTimeout: 15_000 });
  test('a tap at the far end of a choice row selects it, and progress reaches the live region', async ({ page, context }) => {
    test.setTimeout(90_000);
    await context.setGeolocation({ latitude: points.edge.point.lat, longitude: points.edge.point.lon, accuracy: 8 });
    await page.addInitScript(() => document.addEventListener('DOMContentLoaded', () => {
      const heard: string[] = [];
      Object.assign(window, { heard });
      new MutationObserver(() => {
        const text = document.querySelector('[role="status"][aria-live="polite"]')?.textContent?.trim();
        if (text && heard.at(-1) !== text) heard.push(text);
      }).observe(document.body, { subtree: true, childList: true, characterData: true });
    }));
    await answerForServer(page);
    await page.goto('/');
    await page.getByRole('button', { name: 'Człowiek z bronią', exact: true }).click();
    await page.getByRole('button', { name: /^Teraz/ }).click();
    await leaveCompass(page);
    const no = page.locator('#home-check').getByRole('button', { name: 'Nie', exact: true });
    const box = (await no.boundingBox())!;
    await no.tap({ position: { x: box.width - 8, y: box.height / 2 } });
    // An answered question folds into the privacy line.
    await expect(page.locator('.privacy')).toContainText('W zgłoszeniu zapiszemy to miejsce.');
    await page.getByRole('button', { name: 'Zapisz zgłoszenie' }).click();
    await expect(page.locator('.report-status')).toBeVisible({ timeout: 30_000 });
    await expect.poll(() => page.evaluate(() => (window as unknown as { heard: string[] }).heard)).toEqual(expect.arrayContaining(['Szkic zapisany na urządzeniu.', 'Zgłoszenie zapisane na urządzeniu.', 'Pomiar odległości jest dostępny.']));
  });
});

test.describe('across the app', () => {
  test.use({ actionTimeout: 15_000 });

  test('the brand mark follows the palette and the console stays clean', async ({ page }) => {
    const errors: string[] = [];
    page.on('console', message => { if (message.type() === 'error') errors.push(message.text().slice(0, 120)); });
    page.on('pageerror', error => errors.push(error.message.slice(0, 120)));
    await page.goto('/');
    await expect(page.getByRole('heading', { name: 'Co się stało?' })).toBeVisible();
    await settle(page);
    for (const theme of ['light', 'dark', 'noc']) {
      await page.evaluate(value => { document.documentElement.dataset.theme = value; }, theme);
      const mark = await page.evaluate(() => {
        const token = (name: string) => { const probe = document.createElement('i'); probe.style.color = `var(${name})`; document.body.append(probe); const value = getComputedStyle(probe).color; probe.remove(); return value; };
        // On the orange header band the whole one-colour mark takes the band's text colour.
        const paths = [...document.querySelectorAll('.brand-mark svg path')];
        return { paths: paths.length, inkOnBand: paths.every(path => getComputedStyle(path).fill === token('--on-band')),
          named: !!document.querySelector('.brand-mark svg title, .brand-mark svg[role]'), hidden: document.querySelector('.brand-mark')!.getAttribute('aria-hidden') };
      });
      expect(mark, theme).toEqual({ paths: 1, inkOnBand: true, named: false, hidden: 'true' });
    }
    expect(errors).toEqual([]);
  });

  // The ring is teal on the page and paper on the orange band, so it is checked where both meet, in every palette.
  test('the focus ring stands out on the band and on the page', async ({ page }) => {
    test.setTimeout(120_000);
    const failures: string[] = [];
    for (const path of ['/', '/legal/terms/v1/']) {
      await page.goto(path);
      await settle(page);
      for (const theme of ['light', 'dark', 'noc']) {
        await page.evaluate(value => { document.documentElement.dataset.theme = value; }, theme);
        failures.push(...(await tabWalk(page)).problems.map(item => `${path} ${theme}: ${item}`));
        expect(await page.evaluate(() => document.documentElement.dataset.theme)).toBe(theme);
      }
    }
    expect(failures).toEqual([]);
  });

  // A screen change focuses its heading for screen readers. A tap or click must not leave a box
  // around it; a key press keeps the keyboard ring, so a keyboard user sees where they are.
  const headingRing = (page: Page) => page.evaluate(() => {
    const el = document.activeElement!;
    return `${el.tagName} ${getComputedStyle(el).outlineStyle}`;
  });
  for (const input of ['click', 'tap', 'keyboard'] as const) {
    test(`a heading focused after ${input} navigation ${input === 'keyboard' ? 'keeps' : 'draws no'} ring`, async ({ browser }) => {
      const touch = input === 'tap';
      const context = await browser.newContext({ viewport: touch ? { width: 390, height: 844 } : { width: 1280, height: 800 }, hasTouch: touch, isMobile: touch });
      await context.addInitScript(() => localStorage.setItem('first-launch-seen', '1'));
      const page = await context.newPage();
      await page.goto('/');
      await expect(page.getByRole('heading', { name: 'Co się stało?' })).toBeVisible();
      // A cold start focuses the heading before any input; the browser alone would ring it.
      await expect.poll(() => headingRing(page)).toBe('H1 none');
      for (const [name, heading] of [['Moje zapisy', 'Moje zapisy'], ['Bór czuwa', 'Co się stało?'], ['Menu', 'Menu']]) {
        const control = page.getByRole('banner').getByRole('button', { name, exact: true });
        if (input === 'click') await control.click();
        else if (input === 'tap' && name === 'Menu') {
          // An on-screen keyboard's Enter (Android reports 229) moves a touch user on with no pointer event.
          // A trusted key event, so the browser's own focus-visible heuristic sees it as Android's would.
          const cdp = await context.newCDPSession(page);
          await cdp.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Unidentified', windowsVirtualKeyCode: 229 });
          await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Unidentified', windowsVirtualKeyCode: 229 });
          await control.dispatchEvent('click');
        } else if (input === 'tap') await control.tap();
        else { await control.focus(); await page.keyboard.press('Enter'); }
        await expect(page.locator('main h1')).toHaveText(heading);
        await expect.poll(() => headingRing(page)).toBe(input === 'keyboard' ? 'H1 solid' : 'H1 none');
      }
      await context.close();
    });
  }

  test('at 320 px with doubled text the home footer stays within a fifth of the screen', async ({ browser }) => {
    const context = await browser.newContext({ viewport: { width: 320, height: 640 }, hasTouch: true, isMobile: true });
    await context.addInitScript(() => localStorage.setItem('first-launch-seen', '1'));
    const page = await context.newPage();
    await page.addInitScript(() => document.addEventListener('DOMContentLoaded', () => { document.documentElement.style.fontSize = '34px'; }));
    await page.goto('/');
    await expect(page.getByRole('heading', { name: 'Co się stało?' })).toBeVisible();
    await settle(page);
    const { footer, masthead } = await page.evaluate(() => ({
      footer: document.querySelector('.screen-foot')!.getBoundingClientRect().height,
      masthead: document.querySelector('.masthead')!.getBoundingClientRect().height
    }));
    test.info().annotations.push({ type: 'masthead', description: `${Math.round(masthead)} px of 640` });
    expect(footer / 640, `footer ${Math.round(footer)} px`).toBeLessThanOrEqual(0.2);
    // Capture is the button alone: no tagline under it, on screen or for a screen reader (ticket 29 filler cut).
    await expect(page.getByText('Jeden dotyk. Dokończysz później.')).toHaveCount(0);
    await context.close();
  });

  test('at 320 px with doubled text Sprawdź keeps the footer to its action and says no help comes in the step', async ({ browser }) => {
    const context = await browser.newContext({ viewport: { width: 320, height: 640 }, hasTouch: true, isMobile: true,
      permissions: ['geolocation'], geolocation: { latitude: 53.4, longitude: 22.8, accuracy: 12 } });
    await context.addInitScript(() => localStorage.setItem('first-launch-seen', '1'));
    const page = await context.newPage();
    await page.addInitScript(() => document.addEventListener('DOMContentLoaded', () => { document.documentElement.style.fontSize = '34px'; }));
    await page.goto('/');
    await page.getByRole('button', { name: 'Człowiek z bronią', exact: true }).click();
    await finishFromWhen(page, false);
    await settle(page);
    const footer = await page.evaluate(() => document.querySelector('.screen-foot')!.getBoundingClientRect().height);
    // Three lines of the no-help sentence in the footer took it to 229 px, over a third of the screen.
    expect(footer / 640, `footer ${Math.round(footer)} px`).toBeLessThanOrEqual(0.2);
    await expect(page.locator('.screen-foot .no-help')).toBeHidden();
    await expect(page.locator('.scroll-extras .no-help')).toHaveText('Zgłoszenie nie sprowadza pomocy.');
    await page.locator('.scroll-extras .no-help').scrollIntoViewIfNeeded();
    await expect(page.locator('.scroll-extras .no-help')).toBeVisible();
    await context.close();
  });
});

// The camera keeps a dark surround in every palette; its chrome must stay legible on it, and the
// shutter sits in the footer under the thumb.
test.describe('on the camera', () => {
  for (const config of configs.filter(item => item.name !== '390@200%')) {
    test(`at ${config.name} the chrome and shutter meet AA in every palette`, async ({ browser }) => {
      test.setTimeout(90_000);
      const context = await browser.newContext({ viewport: { width: config.width, height: config.height }, hasTouch: config.touch, isMobile: config.touch });
      const page = await context.newPage();
      await context.grantPermissions(['geolocation']);
      await context.setGeolocation({ latitude: points.edge.point.lat, longitude: points.edge.point.lon, accuracy: 8 });
      await context.addInitScript(() => localStorage.setItem('first-launch-seen', '1'));
      if (config.text !== 1) await page.addInitScript(scale => document.addEventListener('DOMContentLoaded', () => {
        document.documentElement.style.fontSize = `${17 * scale}px`;
      }), config.text);
      await page.addInitScript(() => {
        Object.defineProperty(navigator.mediaDevices, 'getUserMedia', { configurable: true, value: async () => {
          const canvas = document.createElement('canvas');
          canvas.width = 320; canvas.height = 240;
          const draw = canvas.getContext('2d')!;
          setInterval(() => draw.fillRect(0, 0, 320, 240), 33);
          return canvas.captureStream(30);
        } });
      });
      await page.goto('/');
      await page.getByRole('button', { name: 'Szczątki w lesie', exact: true }).click();
      await finishFromWhen(page, false);
      // Remains ask for their photo openly, with no disclosure to open first.
      await page.getByRole('button', { name: 'Zrób zdjęcie' }).click();
      await expect(page.locator('video')).toHaveJSProperty('videoWidth', 320);
      const failures: string[] = [];
      if (!await page.locator('.screen-foot .primary', { hasText: 'Zrób zdjęcie' }).count()) failures.push('the shutter is not the footer primary');
      for (const theme of ['light', 'dark', 'noc']) {
        await page.evaluate(value => { document.documentElement.dataset.theme = value; }, theme);
        await settle(page);
        const { hits, clips, contrast } = await measure(page, true);
        failures.push(...[...hits, ...clips, ...contrast].map(item => `${theme}: ${item}`));
        // A pointer resting on a control paints its hover fill under the same text.
        if (!config.touch) for (const name of ['Wróć', 'Menu']) {
          await page.getByRole('button', { name, exact: true }).hover();
          failures.push(...(await measure(page, true)).contrast.map(item => `${theme} hovering ${name}: ${item}`));
        }
        await page.mouse.move(0, 0);
        // The focus ring takes the camera's tokens too.
        if (!config.touch) failures.push(...(await tabWalk(page)).problems.map(item => `${theme}: ${item}`));
        // The app re-derives its theme on a clock and on a fix; a palette that changed mid-check proves nothing.
        expect(await page.evaluate(() => document.documentElement.dataset.theme)).toBe(theme);
      }
      expect(failures).toEqual([]);
      await context.close();
    });
  }
});

test.describe('on the legal pages', () => {
  // Noon and midnight in Poland at the app's default position, so the palette follows the sun as in the app.
  const palettes = [
    { theme: 'light', colorScheme: 'light' as const, time: '2026-10-02T10:00:00Z' },
    { theme: 'dark', colorScheme: 'dark' as const, time: '2026-10-02T10:00:00Z' },
    { theme: 'noc', colorScheme: 'light' as const, time: '2026-10-02T22:00:00Z' }
  ];
  for (const config of configs) {
    test(`at ${config.name} they take the app's palette and keep a 56 px way back in reach`, async ({ browser }) => {
      test.setTimeout(120_000);
      const failures: string[] = [];
      for (const palette of palettes) {
        const context = await browser.newContext({ viewport: { width: config.width, height: config.height }, hasTouch: config.touch,
          isMobile: config.touch, colorScheme: palette.colorScheme });
        const page = await context.newPage();
        await page.clock.setFixedTime(new Date(palette.time));
        if (config.text !== 1) await page.addInitScript(scale => document.addEventListener('DOMContentLoaded', () => {
          document.documentElement.style.fontSize = `${17 * scale}px`;
        }), config.text);
        // Every painted frame's ground, from the first one, so a page that starts light and turns dark is caught.
        await page.addInitScript(() => {
          const grounds: string[] = [];
          (window as unknown as { grounds: string[] }).grounds = grounds;
          const sample = () => { if (document.body) grounds.push(getComputedStyle(document.body).backgroundColor); requestAnimationFrame(sample); };
          requestAnimationFrame(sample);
        });
        for (const path of ['/legal/privacy/v1/', '/legal/terms/v1/']) {
          const at = `${palette.theme} ${path}`;
          await page.goto(path);
          await settle(page);
          const theme = await page.evaluate(() => document.documentElement.dataset.theme);
          if (theme !== palette.theme) failures.push(`${at}: palette ${theme ?? 'none'}`);
          const ground = await page.evaluate(() => {
            const probe = document.createElement('div');
            probe.style.background = 'var(--ground)';
            document.body.append(probe);
            const value = getComputedStyle(probe).backgroundColor;
            probe.remove();
            return value;
          });
          const grounds = [...new Set(await page.evaluate(() => (window as unknown as { grounds: string[] }).grounds))];
          if (grounds.some(item => item !== ground)) failures.push(`${at}: grounds painted ${grounds.join(' then ')}, app ground ${ground}`);
          const { hits, clips, contrast } = await measure(page, true);
          failures.push(...[...hits, ...clips, ...contrast].map(item => `${at}: ${item}`));
          if (demoRecipient) {
            await openLegalDraft(page);
            const draft = await measure(page, true);
            failures.push(...[...draft.hits, ...draft.clips, ...draft.contrast].map(item => `${at} draft: ${item}`));
          }
          if (await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1)) failures.push(`${at}: page scrolls sideways`);
          // The general measure exempts links set in a sentence; the way back is a control and gets no exemption.
          const start = await page.getByRole('link', { name: 'Wróć do aplikacji' }).boundingBox();
          if (!start || start.width < 55.5 || start.height < 55.5) failures.push(`${at}: the way back is ${Math.round(start?.width ?? 0)}x${Math.round(start?.height ?? 0)}`);
          // A bar that stays on screen keeps to the home footer's budget at 320 px with doubled text.
          const bar = await page.locator('.legal-bar').boundingBox();
          if (!bar || bar.height > config.height * 0.2) failures.push(`${at}: the bar takes ${Math.round((bar?.height ?? 0) / config.height * 100)}% of the viewport`);
          // A heading reached by its anchor lands below the bar, not under it.
          if (path === '/legal/privacy/v1/') {
            await page.evaluate(() => { location.hash = 'jesli-zgloszenie-dotyczy-ciebie'; });
            await page.waitForTimeout(100);
            const [heading, under] = await page.evaluate(() => [document.getElementById('jesli-zgloszenie-dotyczy-ciebie')!.getBoundingClientRect().top,
              document.querySelector('.legal-bar')!.getBoundingClientRect().bottom]);
            if (heading < under - 0.5) failures.push(`${at}: the anchored heading sits under the bar (${Math.round(heading)} < ${Math.round(under)})`);
          }
          // The way back stays one tap away at the end of the document.
          await page.evaluate(() => scrollTo(0, document.documentElement.scrollHeight));
          await page.waitForTimeout(100);
          const back = page.getByRole('link', { name: 'Wróć do aplikacji' });
          const box = await back.boundingBox();
          if (!box || box.y < -0.5 || box.y + box.height > config.height + 0.5) failures.push(`${at}: the way back is out of view at the end`);
          if (!config.touch) failures.push(...(await tabWalk(page)).problems.map(item => `${at}: ${item}`));
        }
        await context.close();
      }
      expect(failures).toEqual([]);
    });
  }

  test('the way back returns to the screen that opened the page', async ({ page }) => {
    await page.goto('/');
    await page.getByRole('button', { name: 'Menu' }).click();
    await page.getByRole('link', { name: 'Polityka prywatności' }).click();
    await page.getByRole('link', { name: 'Wróć do aplikacji' }).click();
    await expect(page.getByRole('heading', { name: 'Menu', level: 1 })).toBeVisible();
    // The browser's own back, like Android's gesture, lands in the app too.
    await page.getByRole('link', { name: 'Regulamin serwisu' }).click();
    await openLegalDraft(page);
    await expect(page.getByRole('heading', { name: 'Regulamin serwisu' })).toBeVisible();
    await page.goBack();
    await expect(page.getByRole('heading', { name: 'Menu', level: 1 })).toBeVisible();
    // Through the Terms' own link to the Privacy policy, the way back still leads into the app.
    await page.getByRole('link', { name: 'Regulamin serwisu' }).click();
    await openLegalDraft(page);
    await page.getByRole('link', { name: 'polityka prywatności' }).click();
    await openLegalDraft(page);
    await expect(page.getByRole('heading', { name: 'Polityka prywatności' })).toBeVisible();
    await page.getByRole('link', { name: 'Wróć do aplikacji' }).click();
    await expect(page.getByRole('heading', { name: 'Co się stało?' })).toBeVisible();
    // Opened from outside the app, the way back leads to home.
    await page.goto('/legal/terms/v1/');
    await page.getByRole('link', { name: 'Wróć do aplikacji' }).click();
    await expect(page.getByRole('heading', { name: 'Co się stało?' })).toBeVisible();
  });
});

// The Android Menu's Draft reminder switch and the exact-alarm advice under it (faza 4 ticket 14), which
// the web journey above never shows.
test.describe('the Android reminder switch', () => {
  for (const config of configs) {
    test(`keeps its targets, reflow, text size and contrast at ${config.name}`, async ({ browser }) => {
      const context = await browser.newContext({ viewport: { width: config.width, height: config.height },
        hasTouch: config.touch, isMobile: config.touch,
        storageState: { cookies: [], origins: [{ origin: new URL(test.info().project.use.baseURL!).origin, localStorage: [{ name: 'first-launch-seen', value: '1' }] }] } });
      const page = await context.newPage();
      if (config.text !== 1) await page.addInitScript(scale => document.addEventListener('DOMContentLoaded', () => {
        document.documentElement.style.fontSize = `${17 * scale}px`;
      }), config.text);
      await page.goto('/');
      await expect(page.getByRole('heading', { name: 'Co się stało?' })).toBeVisible();
      await seedDrafts(page, [{ id: 'draft-a11y', eventType: 0, capturedAt: new Date().toISOString() }]);
      await android(context, { permission: 'granted', exact: 'denied' });
      await page.reload();
      await page.getByRole('button', { name: 'Menu' }).click();
      await expect(page.getByText('Przypomnienie może się spóźnić')).toBeVisible();
      await settle(page);
      const failures: string[] = [];
      for (const theme of ['light', 'dark', 'noc']) {
        await page.evaluate(value => { document.documentElement.dataset.theme = value; }, theme);
        const { hits, clips, contrast } = await measure(page, true);
        failures.push(...[...hits, ...clips, ...contrast].map(item => `${theme}: ${item}`));
      }
      failures.push(...(await smallText(page)).map(item => `small text ${item}`));
      expect(failures).toEqual([]);
      // Reachable and operable from the keyboard, with a visible focus ring.
      const toggle = page.getByRole('switch', { name: 'Przypomnienia o szkicach' });
      for (let step = 0; step < 20 && !await toggle.evaluate(el => el === document.activeElement); step++) await page.keyboard.press('Tab');
      expect(await toggle.evaluate(el => el.matches(':focus-visible') && getComputedStyle(el).outlineStyle === 'solid')).toBe(true);
      await page.keyboard.press('Space');
      await expect(toggle).not.toBeChecked();
      await context.close();
    });
  }
});

// Faza 7/28: on first paint the welcome language row starts in the first pane, clear of the footer.
// Audit 09's critics saw it half under the footer at 390 light and dark, noc, desktop and 320 at 200%.
test.describe('on the welcome screen', () => {
  const cases = [
    { name: '390 light', width: 390, height: 844, text: 1, touch: true, colorScheme: 'light' as const, time: '2026-10-02T10:00:00Z', theme: 'light' },
    { name: '390 dark', width: 390, height: 844, text: 1, touch: true, colorScheme: 'dark' as const, time: '2026-10-02T10:00:00Z', theme: 'dark' },
    { name: '390 noc', width: 390, height: 844, text: 1, touch: true, colorScheme: 'light' as const, time: '2026-10-02T22:00:00Z', theme: 'noc' },
    { name: 'desktop', width: 1280, height: 800, text: 1, touch: false, colorScheme: 'light' as const, time: '2026-10-02T10:00:00Z', theme: 'light' },
    { name: '320@200%', width: 320, height: 640, text: 2, touch: true, colorScheme: 'light' as const, time: '2026-10-02T10:00:00Z', theme: 'light' }
  ];
  for (const item of cases) {
    test(`at ${item.name} the language row is inside the first pane on first paint`, async ({ browser }) => {
      // The private demo's test-mail notice sits above the welcome text on purpose.
      test.skip(!!demoRecipient, 'private demo notice takes the first pane');
      const context = await browser.newContext({ viewport: { width: item.width, height: item.height }, hasTouch: item.touch, isMobile: item.touch, colorScheme: item.colorScheme });
      await context.addInitScript(() => localStorage.removeItem('first-launch-seen'));
      const page = await context.newPage();
      await page.clock.setFixedTime(new Date(item.time));
      if (item.text !== 1) await page.addInitScript(scale => document.addEventListener('DOMContentLoaded', () => {
        document.documentElement.style.fontSize = `${17 * scale}px`;
      }), item.text);
      await page.goto('/');
      await expect(page.getByRole('heading', { name: 'Zanim zaczniesz' })).toBeVisible();
      await settle(page);
      expect(await page.evaluate(() => document.documentElement.dataset.theme)).toBe(item.theme);
      const where = await page.evaluate(() => {
        const box = (selector: string) => { const rect = document.querySelector(selector)!.getBoundingClientRect(); return { top: Math.round(rect.top), bottom: Math.round(rect.bottom) }; };
        return { row: box('.welcome-language'), pane: box('.screen-body'), footer: box('.screen-foot'), scrollTop: document.querySelector('.screen-body')!.scrollTop };
      });
      test.info().annotations.push({ type: 'welcome', description: JSON.stringify(where) });
      expect(where.scrollTop).toBe(0);
      expect(where.row.top, 'row top above the footer top').toBeLessThan(where.footer.top);
      expect(where.row.top, 'row inside the pane').toBeGreaterThanOrEqual(where.pane.top);
      expect(where.row.bottom, 'row inside the pane').toBeLessThanOrEqual(Math.min(where.pane.bottom, where.footer.top));
      // Entry focus is the heading; the first Tab from there reaches the language choice.
      await expect.poll(() => page.evaluate(() => document.activeElement?.tagName)).toBe('H1');
      await page.keyboard.press('Tab');
      await expect(page.getByRole('button', { name: 'Polski', exact: true })).toBeFocused();
      await page.keyboard.press('Tab');
      await expect(page.getByRole('button', { name: 'English', exact: true })).toBeFocused();
      await context.close();
    });
  }
});

// Faza 7 ticket 27: the Notice is Polish whatever the interface, blocked primaries explain themselves
// to a keyboard and a screen reader, and headings fit the narrowest column.
test.describe('Notice language and blocked primaries', () => {
  test.use({ actionTimeout: 15_000 });
  const edge = () => ({ latitude: points.edge.point.lat, longitude: points.edge.point.lon, accuracy: 8 });

  async function toReport(page: Page, stub: (page: Page) => Promise<void>) {
    await stub(page);
    await page.context().setGeolocation(edge());
    await page.goto('/');
    await page.getByRole('button', { name: 'Człowiek z bronią', exact: true }).click();
    await finishFromWhen(page, false);
    await page.getByRole('button', { name: 'Zapisz zgłoszenie' }).click();
  }
  async function toRecipients(page: Page, stub = answerForServer) {
    await toReport(page, stub);
    await page.getByRole('button', { name: 'Przygotuj powiadomienie' }).click();
    await expect(page.getByLabel(/Komenda Powiatowa Policji w Mońkach/)).toBeChecked();
  }
  const primary = (page: Page) => page.locator('.screen-foot .primary');
  const reasonOf = (page: Page) => page.locator('.screen-foot .primary').evaluate(button => {
    const id = button.getAttribute('aria-describedby');
    const target = id ? document.getElementById(id) : null;
    return { disabled: button.getAttribute('aria-disabled'), native: (button as HTMLButtonElement).disabled, id,
      text: target?.textContent?.trim() ?? null, live: target?.getAttribute('aria-live') ?? null };
  });
  /** Tab from the top of the page until the primary has focus; false when it cannot be reached. */
  async function tabToPrimary(page: Page) {
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    for (let press = 0; press < 80; press++) {
      await page.keyboard.press('Tab');
      if (await page.evaluate(() => document.activeElement?.matches('.screen-foot .primary') ?? false)) return true;
    }
    return false;
  }

  async function toNotice(page: Page) {
    await toRecipients(page);
    await page.getByRole('button', { name: 'Dalej: podpis' }).click();
    await page.getByRole('radio', { name: 'Z podpisem' }).check();
    await page.getByLabel('Imię i nazwisko').fill('Jan Kowalski');
    await page.getByLabel('Adres do korespondencji').fill('Leśna 1');
    await page.getByRole('button', { name: 'Przygotuj powiadomienia' }).click();
    await openNoticeRow(page);
    await expect(page.locator('.notice-body')).toHaveCount(1);
  }
  const languages = (page: Page, selectors: string[]) => page.evaluate(selectors => Object.fromEntries(selectors.map(selector =>
    [selector, document.querySelector(selector)?.closest('[lang]')?.getAttribute('lang') ?? 'missing'])), selectors);
  const mail = { '.notice-subject': 'pl', '.notice-body': 'pl' };

  test('the Notice subject and body are Polish under the Polish and the English interface', async ({ page }) => {
    await toNotice(page);
    expect(await page.evaluate(() => document.documentElement.lang)).toBe('pl');
    expect(await languages(page, Object.keys(mail))).toEqual(mail);
    await page.getByRole('button', { name: 'Menu' }).click();
    await page.getByRole('button', { name: 'English', exact: true }).click();
    await page.goBack();
    await expect(page.locator('.notice-body')).toHaveCount(1);
    expect(await page.evaluate(() => document.documentElement.lang)).toBe('en');
    expect(await languages(page, Object.keys(mail))).toEqual(mail);
  });

  test('the Notice heading text and accessible name are the plain authority name', async ({ page }) => {
    await toNotice(page);
    const name = 'Komenda Powiatowa Policji w Mońkach';
    expect(await page.locator('main h1').evaluate(h1 => h1.textContent)).toBe(name);
    await expect(page.getByRole('heading', { level: 1, name, exact: true })).toHaveCount(1);
    expect(await page.evaluate(() => document.querySelector('main h1')!.getAttribute('lang'))).toBe('pl');
  });

  test('the PDF preview text is Polish under the Polish and the English interface', async ({ page }) => {
    await toNotice(page);
    await page.getByRole('button', { name: pdfSwitch }).first().click();
    await expect(page.locator('.pdf-body')).toHaveCount(1);
    expect(await page.evaluate(() => document.documentElement.lang)).toBe('pl');
    expect(await languages(page, ['.pdf-body'])).toEqual({ '.pdf-body': 'pl' });
    await page.getByRole('button', { name: 'Menu' }).click();
    await page.getByRole('button', { name: 'English', exact: true }).click();
    await page.goBack();
    await expect(page.locator('.pdf-body')).toHaveCount(1);
    expect(await page.evaluate(() => document.documentElement.lang)).toBe('en');
    expect(await languages(page, ['.pdf-body'])).toEqual({ '.pdf-body': 'pl' });
  });

  test('recipients and signature primaries stay reachable, say why, and send focus to what blocks them', async ({ page }) => {
    await toRecipients(page);
    await page.getByLabel(/Komenda Powiatowa Policji w Mońkach/).uncheck();
    await page.getByLabel(/Państwowa Straż Łowiecka - podlaskie/).uncheck();
    expect(await reasonOf(page)).toEqual({ disabled: 'true', native: false, id: expect.any(String), text: 'Zaznacz co najmniej jeden urząd.', live: 'polite' });
    expect(await tabToPrimary(page)).toBe(true);
    await page.evaluate(() => (document.activeElement as HTMLElement).blur());
    await primary(page).click({ force: true });
    expect(await page.evaluate(() => {
      const first = [...document.querySelectorAll<HTMLInputElement>('.screen-body .recipient-choice input')].find(input => input.checkVisibility());
      return !!first && document.activeElement === first;
    })).toBe(true);
    await expect(page.getByRole('heading', { name: 'Do kogo napisać?' })).toBeVisible();
    await page.getByLabel(/Komenda Powiatowa Policji w Mońkach/).check();
    await page.getByRole('button', { name: 'Dalej: podpis' }).click();
    await page.getByRole('radio', { name: 'Z podpisem' }).check();
    await expect(page.getByLabel('Imię i nazwisko')).toBeVisible();
    // Saving the choice holds the primary natively disabled for a moment; the reason line is the settled state.
    await expect.poll(() => reasonOf(page)).toEqual({ disabled: 'true', native: false, id: expect.any(String), text: 'Podaj imię, nazwisko i adres do korespondencji.', live: 'polite' });
    expect(await tabToPrimary(page)).toBe(true);
    await page.evaluate(() => (document.activeElement as HTMLElement).blur());
    await primary(page).click({ force: true });
    await expect(page.getByLabel('Imię i nazwisko')).toBeFocused();
    await expect(page.getByRole('heading', { name: 'Jak chcesz się podpisać?' })).toBeVisible();
  });

  test('the status region does not keep the measurement line after leaving the Report', async ({ page }) => {
    await toReport(page, answerForServer);
    const region = page.locator('p.sr-only[role="status"]');
    await expect(region).toHaveText('Pomiar odległości jest dostępny.', { timeout: 30_000 });
    await page.getByRole('button', { name: 'Przygotuj powiadomienie' }).click();
    await expect(page.getByRole('heading', { name: 'Do kogo napisać?' })).toBeVisible();
    await expect(region).toHaveText('');
  });

  test('a catalogue that failed to load keeps the recipients primary natively disabled', async ({ page }) => {
    await toReport(page, answerForServer);
    await page.evaluate(() => {
      const original = window.fetch;
      window.fetch = (input, init) => String(input).includes('/_app/immutable/assets/') && String(input).endsWith('.json')
        ? Promise.reject(new TypeError('offline')) : original(input, init);
    });
    await page.getByRole('button', { name: 'Przygotuj powiadomienie' }).click();
    await expect(page.getByRole('alert')).toContainText('Nie udało się wczytać katalogu urzędów.');
    const state = await primary(page).evaluate(button => ({ native: (button as HTMLButtonElement).disabled, aria: button.getAttribute('aria-disabled'), describedby: button.getAttribute('aria-describedby') }));
    expect(state.native).toBe(true);
    expect(state.aria).not.toBe('true');
    expect(state.describedby).toBeNull();
  });

  // With nothing suggested the search is opened from the button under the status sentence (Faza 7/28),
  // so that button is the way to add an office and takes the focus.
  test('with no suggested offices a blocked press focuses the way to choose by name', async ({ page }) => {
    await page.route('**/api/recipients', route => route.fulfill({ status: 200, json: {
      candidates: [], ambiguity: { ambiguous: false, roles: [], unresolved: ['police', 'psl'] },
      inside: { nationalPark: false, reserve: false }, places: { gmina: null, powiat: null, nadlesnictwo: null } } }));
    await toReport(page, answerForServer);
    await page.getByRole('button', { name: 'Przygotuj powiadomienie' }).click();
    const opener = page.getByRole('button', { name: 'Wybierz jednostkę po nazwie', exact: true });
    await expect(opener).toBeVisible();
    expect(await reasonOf(page)).toMatchObject({ disabled: 'true', text: 'Zaznacz co najmniej jeden urząd.' });
    // The screen change still moves focus to the heading as the lookup lands; press after that, as a person would.
    await expect(page.getByRole('heading', { name: 'Do kogo napisać?' })).toBeFocused();
    await untilSettled(page);
    await primary(page).click({ force: true });
    await expect(opener).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(page.getByLabel('Nazwa lub miejscowość')).toBeFocused();
  });

  test('while the recipient lookup is loading the primary stays natively disabled', async ({ page }) => {
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    await page.route('**/api/recipients', async route => { await held; await route.fulfill({ status: 200, json: {
      candidates: [], ambiguity: { ambiguous: false, roles: [], unresolved: ['police', 'psl'] },
      inside: { nationalPark: false, reserve: false }, places: { gmina: null, powiat: null, nadlesnictwo: null } } }); });
    await toReport(page, answerForServer);
    await page.getByRole('button', { name: 'Przygotuj powiadomienie' }).click();
    await expect(page.getByText('Sprawdzam właściwe urzędy…')).toBeVisible();
    const state = () => primary(page).evaluate(button => ({ native: (button as HTMLButtonElement).disabled, aria: button.getAttribute('aria-disabled') === 'true' }));
    expect(await state()).toEqual({ native: true, aria: false });
    release();
    await expect(page.getByRole('button', { name: 'Wybierz jednostkę po nazwie', exact: true })).toBeVisible();
    await expect.poll(state).toEqual({ native: false, aria: true });
  });

  test('the signature primary never points at a reason line that is not on the page', async ({ page }) => {
    await toRecipients(page);
    await page.getByRole('button', { name: 'Dalej: podpis' }).click();
    await expect(page.getByRole('heading', { name: 'Jak chcesz się podpisać?' })).toBeVisible();
    await page.evaluate(() => {
      const dangling: string[] = [];
      (window as unknown as { __dangling: string[] }).__dangling = dangling;
      const watch = () => {
        const button = document.querySelector('.screen-foot .primary');
        const id = button?.getAttribute('aria-describedby');
        if (id && !document.getElementById(id)) dangling.push(id);
        requestAnimationFrame(watch);
      };
      watch();
    });
    await page.getByRole('radio', { name: 'Z podpisem' }).check();
    await expect(page.getByLabel('Imię i nazwisko')).toBeVisible();
    await expect.poll(() => reasonOf(page).then(state => state.text)).toBe('Podaj imię, nazwisko i adres do korespondencji.');
    expect(await page.evaluate(() => (window as unknown as { __dangling: string[] }).__dangling)).toEqual([]);
  });

  // At 320 px with doubled text the footer hides its reason and the scrolling step shows it, so that copy must be the live one.
  test('at 320 px with doubled text the visible reason lines are polite live regions', async ({ browser }) => {
    const context = await browser.newContext({ viewport: { width: 320, height: 640 }, hasTouch: true, isMobile: true, geolocation: edge(), permissions: ['geolocation'] });
    await context.addInitScript(() => localStorage.setItem('first-launch-seen', '1'));
    const page = await context.newPage();
    await page.addInitScript(() => document.addEventListener('DOMContentLoaded', () => { document.documentElement.style.fontSize = '34px'; }));
    await toRecipients(page);
    const visibleReason = (text: RegExp) => page.evaluate(source => {
      const reason = [...document.querySelectorAll('small')].find(item => new RegExp(source).test(item.textContent ?? '') && item.checkVisibility());
      return reason ? { live: reason.closest('[aria-live]')?.getAttribute('aria-live') ?? null, inFooter: !!reason.closest('.screen-foot') } : null;
    }, text.source);
    await page.getByLabel(/Komenda Powiatowa Policji w Mońkach/).uncheck();
    await page.getByLabel(/Państwowa Straż Łowiecka - podlaskie/).uncheck();
    await expect.poll(() => visibleReason(/Zaznacz co najmniej/)).toEqual({ live: 'polite', inFooter: false });
    await page.getByLabel(/Komenda Powiatowa Policji w Mońkach/).check();
    await page.getByRole('button', { name: 'Dalej: podpis' }).click();
    await page.getByRole('radio', { name: 'Z podpisem' }).check();
    await expect.poll(() => visibleReason(/Podaj imię/)).toEqual({ live: 'polite', inFooter: false });
    await context.close();
  });

  test('the map controls are a labelled group', async ({ page }) => {
    await blankTiles(page);
    await page.context().clearPermissions();
    await page.goto('/');
    await page.getByRole('button', { name: 'Człowiek z bronią', exact: true }).click();
    await page.getByRole('button', { name: /^Teraz/ }).click();
    await openMap(page);
    await expect(page.locator('.map-tools')).toHaveRole('group');
    await expect(page.getByRole('group', { name: 'Sterowanie mapą' })).toBeVisible();
  });

  // 200% text must make headings larger too: in px they grow with the root and stay at least as large as body text.
  test('the heading grows with the text setting and is never smaller than body text', async ({ browser }) => {
    const sizes: string[] = [];
    for (const width of [320, 390]) {
      const measured: number[] = [];
      for (const root of [17, 34]) {
        const context = await browser.newContext({ viewport: { width, height: 640 }, hasTouch: true, isMobile: true });
        await context.addInitScript(() => localStorage.setItem('first-launch-seen', '1'));
        const page = await context.newPage();
        await page.addInitScript(px => document.addEventListener('DOMContentLoaded', () => { document.documentElement.style.fontSize = `${px}px`; }), root);
        await page.goto('/');
        await expect(page.locator('main h1')).toBeVisible();
        await settle(page);
        const { heading, body } = await page.evaluate(() => ({ heading: parseFloat(getComputedStyle(document.querySelector('main h1')!).fontSize), body: parseFloat(getComputedStyle(document.body).fontSize) }));
        expect(heading / body, `${width} px, ${root} px root: heading ${heading} body ${body}`).toBeGreaterThanOrEqual(1);
        measured.push(heading);
        await context.close();
      }
      sizes.push(`${width}: ${measured.join(' -> ')}`);
      expect(measured[1], sizes.join('; ')).toBeGreaterThan(measured[0]);
    }
  });

  // Rendered line breaks of the real Notice heading, in Chromium and in Firefox, at 320 px with doubled text (34 px root).
  // The names are real directory names, written into the stored Notice one by one and drawn by the app itself, so any
  // markup or text change in the heading (soft hyphens, wrappers, a changed lang) shows up in the breaks.
  //
  // What is a correct break. Polish syllable division, written out by hand below (source: the syllabification rules of
  // Polish orthography, for example the PWN "Wielki słownik ortograficzny" rules on dividing words at line ends: a break
  // falls between syllables, a consonant cluster is split before the last consonant of a group that cannot start a word,
  // and the digraphs ch cz sz rz dz dź dż, and ć ś ź written as two letters in "ci si zi", are never split).
  // Offsets are letters from the start of the word.
  //   1. A break on one of those syllable boundaries is correct (a browser dictionary may take it).
  //   2. A break anywhere else is accepted only when the line was full: the next letter would not have fitted. That is the
  //      overflow-wrap fallback for a word wider than the 280 px column, which neither browser here can avoid without a
  //      Polish dictionary (neither ships one in this test setup), and which inserts nothing: copy, search and the screen
  //      reader name keep the plain word. A break with room left on the line is a wrong break and fails.
  //   3. The heading never scrolls sideways.
  // Verified on the Polish dictionary of a real Firefox: the same predicate accepts its dictionary breaks (rule 1).
  const polishSyllables = ['pań-stwo-wa', 'straż', 'ło-wiec-ka', 'za-chod-nio-po-mor-skie', 'urząd', 'mia-sta', 'os-trow-ca', 'świę-to-krzy-skie-go',
    'miej-ski', 'w', 'szcze-brze-szy-nie', 'gmi-ny', 'wierz-cho-sła-wi-ce', 'mod-li-bo-rzy-cach', 'kon-stan-ty-no-wie', 'łódz-kim', 'cze-cho-wi-cach',
    'dzie-dzi-cach', 're-gio-nal-na', 'dy-rek-cja', 'och-ro-ny', 'śro-do-wi-ska', 'go-rzo-wie', 'wiel-ko-pol-skim', 'war-miń-sko', 'ma-zur-skie'];
  const polishBreaks: Record<string, number[]> = Object.fromEntries(polishSyllables.map(word => {
    const parts = word.split('-');
    return [parts.join(''), parts.slice(0, -1).map((_, index) => parts.slice(0, index + 1).join('').length)];
  }));
  const hyphenationNames = ['Państwowa Straż Łowiecka - zachodniopomorskie', 'Urząd Miasta Ostrowca Świętokrzyskiego', 'Urząd Miejski w Szczebrzeszynie',
    'Urząd Gminy Wierzchosławice', 'Urząd Miejski w Modliborzycach', 'Urząd Miejski w Konstantynowie Łódzkim', 'Urząd Miejski w Czechowicach-Dziedzicach',
    'Regionalna Dyrekcja Ochrony Środowiska w Gorzowie Wielkopolskim', 'Państwowa Straż Łowiecka - warmińsko-mazurskie'];

  type Break = { name: string; word: string; at: number; roomLeft: boolean };
  const readStored = (page: Page) => page.evaluate(() => new Promise<unknown>((resolve, reject) => {
    const open = indexedDB.open('bor-czuwa');
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const request = open.result.transaction('reports').objectStore('reports').getAll();
      request.onsuccess = () => resolve(request.result[0]);
    };
  }));
  const writeStored = (page: Page, stored: unknown, name: string | null) => page.evaluate(([record, authority]) => new Promise<void>((resolve, reject) => {
    const copy = JSON.parse(JSON.stringify(record));
    if (authority) for (const notice of copy.notices ?? []) notice.recipient.name = authority;
    const open = indexedDB.open('bor-czuwa');
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const transaction = open.result.transaction('reports', 'readwrite');
      transaction.objectStore('reports').put(copy);
      transaction.oncomplete = () => resolve();
    };
  }), [stored, name] as const);
  /** Every in-word line break of the drawn heading, and whether the line still had room for the next letter. */
  const headingBreaks = (page: Page, name: string) => page.evaluate(authority => {
    const h1 = document.querySelector('main h1')!;
    const node = h1.firstChild!;
    const box = h1.getBoundingClientRect();
    const right = box.right - parseFloat(getComputedStyle(h1).paddingRight);
    const found: { word: string; at: number; roomLeft: boolean }[] = [];
    // Offsets are in the plain name; any soft hyphen in the drawn text is skipped, so wrong breaks stay measurable on its own.
    const where: number[] = [];
    (node as Text).data.split('').forEach((letter, index) => { if (letter !== String.fromCharCode(0xad)) where.push(index); });
    for (const match of authority.matchAll(/[^\s-]+/g)) {
      let previous: { top: number; right: number } | undefined;
      for (let at = 0; at < match[0].length; at++) {
        const range = document.createRange();
        range.setStart(node, where[match.index! + at]);
        range.setEnd(node, where[match.index! + at] + 1);
        const rect = range.getBoundingClientRect();
        if (previous && Math.round(rect.top) > previous.top + 2) found.push({ word: match[0].toLowerCase(), at, roomLeft: previous.right + rect.width <= right + 0.5 });
        previous = { top: Math.round(rect.top), right: rect.right };
      }
    }
    return { found, sideways: document.documentElement.scrollWidth > innerWidth || h1.scrollWidth > h1.clientWidth, text: h1.textContent };
  }, name);

  for (const engine of ['chromium', 'firefox'] as const) for (const language of ['pl', 'en'] as const) {
    test(`${engine}: long authority names break only on Polish syllables or by a full line at 320 px with doubled text (${language} interface)`, async ({ browser: chromiumBrowser }) => {
      test.setTimeout(180_000);
      // The Notice is made in Chromium (headless Firefox gives no GPS fix here); Firefox gets its stored record carried over.
      const maker = await chromiumBrowser.newContext({ viewport: { width: 320, height: 640 }, hasTouch: true, isMobile: true, geolocation: edge(), permissions: ['geolocation'] });
      await maker.addInitScript(() => localStorage.setItem('first-launch-seen', '1'));
      const made = await maker.newPage();
      await made.addInitScript(() => document.addEventListener('DOMContentLoaded', () => { document.documentElement.style.fontSize = '34px'; }));
      await toNotice(made);
      const stored = await readStored(made);
      const target = new URL(made.url());
      const own = engine === 'firefox' ? await firefox.launch() : null;
      try {
        const context = own
          ? await own.newContext({ viewport: { width: 320, height: 640 }, locale: 'pl-PL' })
          : maker;
        await context.addInitScript(lang => { localStorage.setItem('first-launch-seen', '1'); localStorage.setItem('interface-language', lang); }, language);
        const page = own ? await context.newPage() : made;
        if (own) {
          await page.addInitScript(() => document.addEventListener('DOMContentLoaded', () => { document.documentElement.style.fontSize = '34px'; }));
          await answerForServer(page);
          await page.goto('/');
          await expect(page.locator('main h1')).toBeVisible();
        } else {
          await page.evaluate(lang => localStorage.setItem('interface-language', lang), language);
        }
        const wrong: Break[] = [];
        const forced: string[] = [];
        const syllable: string[] = [];
        for (const name of hyphenationNames) {
          await writeStored(page, stored, name);
          await page.goto(`/${target.search}`);
          await expect(page.locator('main h1')).toHaveText(name);
          expect(await page.evaluate(() => document.documentElement.lang)).toBe(language);
          await settle(page);
          const { found, sideways, text } = await headingBreaks(page, name);
          expect(text, 'the heading holds the plain name, no inserted characters').toBe(name);
          expect(sideways, `${name} scrolls sideways`).toBe(false);
          for (const item of found) {
            if ((polishBreaks[item.word] ?? []).includes(item.at)) syllable.push(`${item.word}:${item.at}`);
            else if (item.roomLeft) wrong.push({ name, ...item });
            else forced.push(`${item.word}:${item.at}`);
          }
        }
        test.info().annotations.push({ type: 'syllable breaks', description: syllable.join(' ') || 'none' }, { type: 'full-line breaks', description: forced.join(' ') || 'none' });
        expect(wrong).toEqual([]);
        // Without this the loop could pass on a heading that never wrapped.
        expect(syllable.length + forced.length).toBeGreaterThan(0);
      } finally {
        await own?.close();
        await maker.close();
      }
    });
  }
});
