import { test, expect, type Page } from '@playwright/test';
import { footer, heading } from './stages.ts';

// After quick capture one screen says what was saved and asks what happened (faza 3 ticket 06).
const eventNames = ['Strzał', 'Człowiek z bronią', 'Szczątki w lesie', 'Ranne zwierzę', 'Kłusownictwo'];
const clock = (page: Page) => page.evaluate(() => new Date().toLocaleTimeString('pl-PL', { hour: '2-digit', minute: '2-digit' }));

async function expectReceipt(page: Page, fresh: boolean) {
  const panel = page.locator('#receipt');
  await expect(panel).toHaveAttribute('role', 'status');
  await expect(heading(page, 'Co się stało?')).toBeVisible();
  await expect(page.locator('.event-row')).toHaveCount(5);
  for (const name of eventNames) await expect(page.getByRole('button', { name, exact: true })).toBeInViewport({ ratio: 1 });
  // The last row sits above the footer: choosing an Event needs no swipe at 390 × 844.
  const gap = await page.evaluate(() => document.querySelector('.screen-foot')!.getBoundingClientRect().top
    - [...document.querySelectorAll('.event-row')].at(-1)!.getBoundingClientRect().bottom);
  expect(gap).toBeGreaterThanOrEqual(0);
  await expect(footer(page).getByRole('button')).toHaveText(['Dokończę później']);
  await expect(page.locator('.steps')).toHaveCount(0);
  for (const gone of ['Tylko na Twoim urządzeniu', 'Usunięcie danych przeglądarki', 'Wróć do listy', 'Dokończ ten szkic']) {
    await expect(page.getByText(gone)).toHaveCount(0);
  }
  await expect(page.getByText('Możesz już odejść.', { exact: false })).toHaveCount(fresh ? 1 : 0);
}

test('quick capture lands on one screen that keeps the place and time and asks what happened', async ({ page, context }) => {
  await context.setGeolocation({ latitude: 52.1, longitude: 19.4, accuracy: 9 });
  await page.goto('/');
  await page.getByRole('button', { name: 'Zapisz miejsce i czas' }).click();
  await expect(page.locator('#receipt strong')).toHaveText('Miejsce i czas zapisane');
  await expect(page.locator('#receipt small')).toHaveText(`dziś ${await clock(page)} · Dokładność 9 m`);
  await expectReceipt(page, true);
  await expect(page.locator('#receipt')).toBeFocused();
  // Budget 3 / 2 / 0: home, this screen, Kiedy.
  await page.getByRole('button', { name: 'Strzał', exact: true }).click();
  await expect(heading(page, 'Kiedy to się stało?')).toBeVisible();
  await expect(page.locator('.steps')).toHaveCount(1);
  await expect(page.locator('.steps li')).toHaveText(['Co', 'Kiedy', 'Gdzie', 'Sprawdź']);
  await expect(page.locator('.steps li.done')).toHaveText(['Co']);
  await expect(page.locator('.steps li[aria-current="step"]')).toHaveText('Kiedy');
  await page.goBack();
  await expectReceipt(page, true);
  await page.goBack();
  await expect(page.getByRole('button', { name: 'Zapisz miejsce i czas' })).toBeVisible();
});

test('without a fix the receipt keeps the time and says the place comes later', async ({ page, context }) => {
  await context.clearPermissions();
  await page.goto('/');
  await page.getByRole('button', { name: 'Zapisz miejsce i czas' }).click();
  await expect(page.locator('#receipt strong')).toHaveText('Czas zapisany');
  await expect(page.locator('#receipt small')).toHaveText(`dziś ${await clock(page)} · miejsce wskażesz później`);
  await expectReceipt(page, true);
  await page.getByRole('button', { name: 'Kłusownictwo', exact: true }).click();
  await expect(heading(page, 'Kiedy to się stało?')).toBeVisible();
  await expect(page.locator('.steps li.done')).toHaveText(['Co']);
});

test('finishing later confirms itself, and every way back lands on the receipt', async ({ page, context }) => {
  await context.setGeolocation({ latitude: 52.1, longitude: 19.4, accuracy: 9 });
  await page.goto('/');
  await page.getByRole('button', { name: 'Zapisz miejsce i czas' }).click();
  await expect(page.locator('#receipt strong')).toHaveText('Miejsce i czas zapisane');
  const draftId = new URL(page.url()).searchParams.get('draft');
  await footer(page).getByRole('button', { name: 'Dokończę później' }).click();
  await expect(page.locator('.brief-confirmation')).toHaveText('Zapisane na telefonie. Dokończysz, kiedy zechcesz.');
  await expect(page.getByRole('button', { name: 'Zapisz miejsce i czas' })).toBeVisible();

  // From home: the same screen, without "Możesz już odejść", focus on the panel.
  await page.getByRole('button', { name: /^Dokończ zgłoszenie .* · Dalej: Co się stało\?$/ }).click();
  await expectReceipt(page, false);
  await expect(page.locator('#receipt')).toBeFocused();

  // From Moje zapisy.
  await page.getByRole('button', { name: 'Moje zapisy', exact: true }).click();
  await page.getByRole('button', { name: /^Dokończ zgłoszenie .* · Dalej: Co się stało\?$/ }).click();
  await expectReceipt(page, false);

  // A stale location from the two-screen receipt, and the old choose-event one, both land here.
  for (const screen of ['saved', 'choose-event']) {
    await page.goto(`/?screen=${screen}&draft=${draftId}`);
    await expectReceipt(page, false);
    expect(new URL(page.url()).searchParams.get('screen')).toBe('choose-event');
  }
});

test('an Event row on home still goes straight to Kiedy', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Człowiek z bronią', exact: true }).click();
  await expect(heading(page, 'Kiedy to się stało?')).toBeVisible();
  await expect(page.locator('.steps li').first()).toHaveText('Kiedy');
  await expect(page.locator('.steps li', { hasText: /^Co$/ })).toHaveCount(0);
});

test('changing the Event from Sprawdź keeps the step header, not the receipt', async ({ page, context }) => {
  await context.setGeolocation({ latitude: 52.1, longitude: 19.4, accuracy: 9 });
  await page.goto('/');
  await page.getByRole('button', { name: 'Zapisz miejsce i czas' }).click();
  await page.getByRole('button', { name: 'Człowiek z bronią', exact: true }).click();
  await page.getByRole('button', { name: /^Teraz/ }).click();
  await page.locator('.screen-foot').getByRole('button', { name: 'Pomiń' }).click();
  await expect(heading(page, 'Sprawdź i zapisz')).toBeVisible();
  await page.getByRole('button', { name: 'Zmień: Co' }).click();
  await expect(heading(page, 'Co się stało?')).toBeVisible();
  await expect(page.locator('#receipt')).toHaveCount(0);
  await expect(page.locator('.steps li[aria-current="step"]')).toHaveText('Co');
});

test('the confirmation after "Dokończę później" fades in and out, and the rows under it never move', async ({ page, context }) => {
  test.setTimeout(20_000);
  await context.setGeolocation({ latitude: 52.1, longitude: 19.4, accuracy: 9 });
  await page.goto('/');
  await page.getByRole('button', { name: 'Zapisz miejsce i czas' }).click();
  await expect(page.locator('#receipt strong')).toHaveText('Miejsce i czas zapisane');
  await page.evaluate(() => {
    const frames: { o: number | null; row: number | null }[] = [];
    (window as unknown as { frames6: typeof frames }).frames6 = frames;
    const tick = () => {
      const brief = document.querySelector('.brief-confirmation');
      frames.push({ o: brief ? Number(getComputedStyle(brief).opacity) : null,
        row: document.querySelector('.event-row')?.getBoundingClientRect().top ?? null });
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
  await footer(page).getByRole('button', { name: 'Dokończę później' }).click();
  await expect(page.locator('.brief-confirmation')).toBeVisible();
  await expect(page.locator('.brief-confirmation')).toHaveCount(0, { timeout: 6_000 });
  const frames = await page.evaluate(() => (window as unknown as { frames6: { o: number | null; row: number | null }[] }).frames6);
  const shown = frames.map((frame, index) => ({ ...frame, index })).filter(frame => frame.o !== null);
  // Nothing painted at full strength in its first frame or its last: no pop in, no pop out.
  expect(shown[0].o).toBeLessThan(0.5);
  expect(shown.at(-1)!.o).toBeLessThan(0.5);
  // Home's rows stay where they landed while the confirmation comes and goes.
  const rows = new Set(frames.slice(shown[0].index).map(frame => Math.round(frame.row ?? -1)));
  expect([...rows]).toHaveLength(1);
});
