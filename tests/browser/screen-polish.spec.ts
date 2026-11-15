import { test, expect } from '@playwright/test';
import { answerNow, blankTiles, footer, heading, startEvent } from './stages.ts';

test.beforeEach(async ({ page, context }) => {
  await context.setGeolocation({ latitude: 53.45, longitude: 22.8, accuracy: 8 });
  await blankTiles(page);
  await page.route('**/api/challenge', route => route.abort());
  await page.goto('/');
});

test('direction names its unknown answer, leaves distance unset and excludes the open Draft from pending work', async ({ page }) => {
  await startEvent(page, 'Strzał');
  await expect(page.locator('.when-note')).toBeVisible();
  await expect(page.locator('.task-count')).toHaveCount(0);
  await answerNow(page);
  await expect(page.getByText('Dotknij tarczy po stronie, z której słychać strzał.', { exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Nie wiem, skąd', exact: true })).toBeVisible();
  const target = page.getByRole('slider', { name: 'Tarcza kierunku' });
  await expect(target).toHaveAttribute('aria-valuetext', 'Kierunek nie wybrany');
  await target.focus();
  for (let stop = 0; stop < 4; stop++) await page.keyboard.press('PageUp');
  await expect(target).toHaveAttribute('aria-valuetext', 'Kierunek nie wybrany, około 500 m');
  await page.getByRole('button', { name: 'Nie wiem, jak daleko' }).click();
  await expect(target).toHaveAttribute('aria-valuetext', 'Kierunek nie wybrany');
  await footer(page).getByRole('button', { name: 'Dokończę później' }).click();
  await expect(heading(page, 'Co się stało?')).toBeVisible();
  await expect(page.locator('.task-count')).toHaveText('1');
  await startEvent(page, 'Człowiek z bronią');
  await expect(page.locator('.when-note')).toHaveCount(0);
  await expect(page.locator('.task-count')).toHaveText('1');
});

test('320 px at doubled text keeps one masthead row and scrolls secondary actions', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 640 });
  await page.evaluate(() => document.documentElement.style.fontSize = '34px');
  await startEvent(page, 'Strzał');
  await answerNow(page);
  await page.waitForFunction(() => !document.documentElement.matches(':active-view-transition'));
  await page.evaluate(async () => { await document.fonts.ready; });
  const later = page.getByRole('button', { name: 'Dokończę później' }).filter({ visible: true });
  await expect(later).toBeVisible();
  expect(await later.evaluate(node => !!node.closest('.screen-body'))).toBe(true);
  await page.getByRole('button', { name: 'Nie wiem, skąd', exact: true }).focus();
  await page.keyboard.press('Tab');
  await expect(later).toBeFocused();
  const dimensions = await later.evaluate(node => {
    const masthead = document.querySelector('.masthead')!.getBoundingClientRect();
    const pane = document.querySelector('.screen-body')!;
    const body = pane.getBoundingClientRect(), action = node.getBoundingClientRect();
    return {
      masthead: masthead.height, headerTop: masthead.top, headerBottom: masthead.bottom,
      viewportHeight: innerHeight, font: getComputedStyle(document.documentElement).fontSize,
      actionTop: action.top, actionBottom: action.bottom, paneTop: body.top, paneBottom: body.bottom,
      overflow: document.documentElement.scrollWidth - innerWidth,
    };
  });
  expect(dimensions.masthead).toBeLessThanOrEqual(80);
  expect(dimensions.headerTop).toBeGreaterThanOrEqual(0);
  expect(dimensions.headerBottom).toBeLessThanOrEqual(dimensions.viewportHeight);
  expect(dimensions.font).toBe('34px');
  expect(dimensions.actionTop).toBeGreaterThanOrEqual(dimensions.paneTop);
  expect(dimensions.actionBottom).toBeLessThanOrEqual(dimensions.paneBottom);
  expect(dimensions.overflow).toBe(0);
  await later.click();
  await expect(heading(page, 'Co się stało?')).toBeVisible();
});

test('missing map point looks unavailable and its attribution offers a 56 px target', async ({ page }) => {
  await startEvent(page, 'Człowiek z bronią');
  await page.getByRole('button', { name: 'Kilka godzin temu' }).click();
  await footer(page).getByRole('button', { name: 'Dalej', exact: true }).click();
  const next = footer(page).getByRole('button', { name: 'Dalej', exact: true });
  await expect(next).toHaveAttribute('aria-disabled', 'true');
  // Unavailable is the soft fill with no outline, so it reads neither as the action nor as a secondary (ticket 29).
  const soft = await page.evaluate(() => {
    const probe = document.createElement('i');
    probe.style.background = 'var(--soft)';
    document.body.append(probe);
    const value = getComputedStyle(probe).backgroundColor;
    probe.remove();
    return value;
  });
  await expect(next).toHaveCSS('border-top-color', 'rgba(0, 0, 0, 0)');
  await expect(next).toHaveCSS('background-color', soft);
  await page.mouse.move(0, 0);
  const unavailableBackground = await next.evaluate(node => getComputedStyle(node).backgroundColor);
  await next.hover();
  await expect(next).toHaveCSS('background-color', unavailableBackground);
  await page.getByRole('button', { name: 'Pokaż mapę', exact: true }).click();
  const attribution = page.getByRole('link', { name: 'OpenStreetMap contributors' });
  expect((await attribution.boundingBox())!.height).toBeGreaterThanOrEqual(56);
});

test('a pointer keeps each control in its state', async ({ page }) => {
  const token = (name: string) => page.evaluate(value => {
    const probe = document.createElement('i');
    probe.style.background = `var(${value})`;
    document.body.append(probe);
    const color = getComputedStyle(probe).backgroundColor;
    probe.remove();
    return color;
  }, name);
  await startEvent(page, 'Strzał');
  // A chosen answer keeps its paper face, and a text action never grows a filled block (ticket 29).
  const other = page.getByRole('button', { name: 'Innego dnia', exact: true });
  await other.click();
  await expect(other).toHaveAttribute('aria-pressed', 'true');
  await other.hover();
  await expect(other).toHaveCSS('background-color', await token('--paper'));
  const later = footer(page).getByRole('button', { name: 'Dokończę później' });
  await later.hover();
  await expect(later).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
  await later.click();
  await page.getByRole('button', { name: 'Moje zapisy', exact: true }).click();
  await page.getByRole('button', { name: 'Usuń szkic' }).first().click();
  const confirm = page.getByRole('group', { name: 'Usunąć szkic?' });
  // The destructive button keeps paper on ink under the pointer; Anuluj deepens like any filled button.
  const remove = confirm.getByRole('button', { name: 'Usuń', exact: true });
  await remove.hover();
  await expect(remove).toHaveCSS('background-color', await token('--ink'));
  const cancel = confirm.getByRole('button', { name: 'Anuluj', exact: true });
  await cancel.hover();
  await expect(cancel).toHaveCSS('background-color', await token('--fill-hover'));
});

test('save confirmation finishes its fade before the next screen appears', async ({ page }, testInfo) => {
  await startEvent(page, 'Strzał');
  await footer(page).getByRole('button', { name: 'Dokończę później' }).click();
  const confirmation = page.locator('.brief-confirmation');
  await expect(confirmation).toBeVisible();
  await expect(confirmation).toHaveCSS('opacity', '1');
  await page.evaluate(() => {
    const samples: { at: number; heading: string; opacity: number | null }[] = [];
    (window as unknown as { polishFrames: typeof samples }).polishFrames = samples;
    const start = performance.now();
    const sample = () => {
      const toast = document.querySelector('.brief-confirmation');
      samples.push({ at: performance.now() - start, heading: document.querySelector('main h1')?.textContent ?? '',
        opacity: toast ? Number(getComputedStyle(toast).opacity) : null });
      if (performance.now() - start < 900) requestAnimationFrame(sample);
    };
    requestAnimationFrame(sample);
  });
  await page.getByRole('button', { name: 'Menu', exact: true }).click();
  await expect(heading(page, 'Menu')).toBeVisible();
  await page.waitForTimeout(950);
  const frames = await page.evaluate(() => (window as unknown as {
    polishFrames: { at: number; heading: string; opacity: number | null }[];
  }).polishFrames);
  expect(frames.some(frame => frame.opacity !== null && frame.opacity > 0 && frame.opacity < 1)).toBe(true);
  expect(frames.filter(frame => frame.heading === 'Menu').every(frame => frame.opacity === null)).toBe(true);
  await testInfo.attach('confirmation-frames', { body: JSON.stringify(frames, null, 2), contentType: 'application/json' });
});
