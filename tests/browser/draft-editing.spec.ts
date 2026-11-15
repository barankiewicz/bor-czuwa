import { test, expect, type BrowserContext, type Page } from '@playwright/test';
import { answerHome, answerNow, chooseHours, choosePoint, finishFromWhen, footer, heading, openMap, reportPost, save } from './stages.ts';

test.use({ serviceWorkers: 'block' });

const point = { lat: 52.2297, lon: 21.0122 };

/** Holds every location request until the test answers it, with a fix or with a refusal. */
async function heldLocation(page: Page) {
  await page.addInitScript(() => {
    const requests: { success: PositionCallback; failure?: PositionErrorCallback; options?: PositionOptions }[] = [];
    Object.defineProperty(navigator.geolocation, 'watchPosition', {
      value: (success: PositionCallback, failure?: PositionErrorCallback, options?: PositionOptions) => {
        // The theme's own coarse request for noc is not the Draft's.
        if (options?.enableHighAccuracy) requests.push({ success, failure, options });
        return requests.length;
      }
    });
    Object.assign(window, { locateCalls: () => requests.length, locateOptions: () => requests.map(item => item.options) });
    window.addEventListener('test-location', event => {
      const { index, lat, lon, code } = (event as CustomEvent).detail;
      const request = requests[index];
      if (code) request.failure?.({ code, message: '', PERMISSION_DENIED: 1, POSITION_UNAVAILABLE: 2, TIMEOUT: 3 } as GeolocationPositionError);
      else request.success({ coords: { latitude: lat, longitude: lon, accuracy: 8 }, timestamp: Date.now() } as GeolocationPosition);
    });
  });
  return {
    asked: (count: number) => expect.poll(() => page.evaluate(() => (window as unknown as { locateCalls(): number }).locateCalls())).toBe(count),
    fix: (index = 0) => page.evaluate(detail => window.dispatchEvent(new CustomEvent('test-location', { detail })), { index, ...point }),
    fail: (code: 1 | 2 | 3, index = 0) => page.evaluate(detail => window.dispatchEvent(new CustomEvent('test-location', { detail })), { index, code })
  };
}

const draftCard = (page: Page) => page.getByRole('button', { name: /^Dokończ zgłoszenie/ });

test('a fix arriving as the Event is chosen is kept', async ({ page }) => {
  const location = await heldLocation(page);
  await page.goto('/');
  await footer(page).getByRole('button', { name: 'Zapisz miejsce i czas' }).click();
  await expect(page.locator('#receipt')).toContainText('Czas zapisany');
  await location.asked(1);
  // The tap on the Event and the phone's fix land in the same moment.
  await page.evaluate(detail => {
    [...document.querySelectorAll<HTMLButtonElement>('.event-row')].find(row => row.textContent?.trim() === 'Człowiek z bronią')!.click();
    window.dispatchEvent(new CustomEvent('test-location', { detail }));
  }, { index: 0, ...point });
  await expect(heading(page, 'Kiedy to się stało?')).toBeVisible();
  await answerNow(page);
  // With the phone's position kept, a person with a gun seen now is placed by direction, not on the map.
  await expect(page.getByRole('slider', { name: 'Tarcza kierunku' })).toBeVisible();
  await page.reload();
  await expect(page.getByRole('slider', { name: 'Tarcza kierunku' })).toBeVisible();
});

test('a fix arriving after the Report is saved does not bring the Draft back', async ({ page }) => {
  const location = await heldLocation(page);
  await reportPost(page);
  await page.goto('/');
  await page.getByRole('button', { name: 'Kłusownictwo', exact: true }).click();
  await location.asked(1);
  await page.getByRole('button', { name: 'Kilka godzin temu' }).click();
  await footer(page).getByRole('button', { name: 'Dalej' }).click();
  await choosePoint(page, point.lat, point.lon);
  await answerHome(page, false);
  await save(page);
  await expect(heading(page, /^Zgłoszenie$/)).toBeVisible();
  await location.fix();
  await page.waitForTimeout(500);
  await page.goto('/');
  await expect(heading(page, 'Co się stało?')).toBeVisible();
  await expect(draftCard(page)).toHaveCount(0);
});

test('a fix arriving after the Draft is deleted does not bring it back', async ({ page }) => {
  const location = await heldLocation(page);
  await page.goto('/');
  await page.getByRole('button', { name: 'Kłusownictwo', exact: true }).click();
  await location.asked(1);
  await page.getByRole('button', { name: 'Dokończę później' }).click();
  await page.getByRole('button', { name: 'Moje zapisy', exact: true }).click();
  await page.getByRole('button', { name: 'Usuń szkic' }).click();
  await page.getByRole('group', { name: 'Usunąć szkic?' }).getByRole('button', { name: 'Usuń', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Usuń szkic' })).toHaveCount(0);
  await location.fix();
  await page.waitForTimeout(500);
  await page.goto('/');
  await expect(heading(page, 'Co się stało?')).toBeVisible();
  await expect(draftCard(page)).toHaveCount(0);
});

test('typing a note under three photos writes the Draft a few times, not once per letter', async ({ page, context }) => {
  await context.setGeolocation({ latitude: point.lat, longitude: point.lon, accuracy: 8 });
  await page.addInitScript(() => {
    let writes = 0;
    const put = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function (...args: Parameters<typeof put>) {
      if (this.name === 'drafts') writes++;
      return put.apply(this, args);
    };
    Object.assign(window, { draftWrites: () => writes, resetDraftWrites: () => { writes = 0; } });
  });
  await page.goto('/');
  await page.getByRole('button', { name: 'Kłusownictwo', exact: true }).click();
  await answerNow(page);
  await footer(page).getByRole('button', { name: /^(Pomiń kierunek i odległość|Dalej)$/ }).click();
  await expect(heading(page, 'Sprawdź i zapisz')).toBeVisible();
  await answerHome(page, false);
  await page.locator('summary', { hasText: 'Zdjęcia' }).click();
  for (let count = 1; count <= 3; count++) {
    await page.evaluate(async () => {
      const canvas = document.createElement('canvas');
      canvas.width = 1600; canvas.height = 1200;
      const ctx = canvas.getContext('2d')!;
      ctx.fillStyle = `hsl(${Math.random() * 360} 60% 50%)`; ctx.fillRect(0, 0, 1600, 1200);
      const blob = await new Promise<Blob>(resolve => canvas.toBlob(value => resolve(value!), 'image/jpeg')!);
      const input = document.querySelector<HTMLInputElement>('.screen-body input[type=file]')!;
      const transfer = new DataTransfer();
      transfer.items.add(new File([blob], 'photo.jpg', { type: 'image/jpeg' }));
      input.files = transfer.files;
      input.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await expect(page.locator('.photo-tile')).toHaveCount(count);
  }
  await page.locator('summary', { hasText: 'Notatka' }).click();
  const note = 'Wnyki przy ścieżce. '.repeat(15);
  expect(note).toHaveLength(300);
  await page.evaluate(() => (window as unknown as { resetDraftWrites(): void }).resetDraftWrites());
  await page.getByLabel('Co jeszcze chcesz przekazać?').pressSequentially(note, { delay: 15 });
  // Typing pauses here; one write follows the pause.
  await page.waitForTimeout(800);
  const writes = await page.evaluate(() => (window as unknown as { draftWrites(): number }).draftWrites());
  console.log(`Draft writes for a 300-character note: ${writes}`);
  expect(writes).toBeLessThanOrEqual(5);
  await page.reload();
  await expect(page.getByLabel('Co jeszcze chcesz przekazać?')).toHaveValue(note);
});

const retry = (page: Page) => page.getByRole('button', { name: 'Spróbuj ustalić miejsce ponownie' });

for (const leaving of ['navigation', 'visibilitychange', 'pagehide'] as const) {
  test(`a pending note is kept on ${leaving}, before its debounce expires`, async ({ page, context }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await context.setGeolocation({ latitude: point.lat, longitude: point.lon, accuracy: 8 });
    await page.clock.install();
    await page.goto('/');
    await page.getByRole('button', { name: 'Kłusownictwo', exact: true }).click();
    await answerNow(page);
    await footer(page).getByRole('button', { name: /^(Pomiń kierunek i odległość|Dalej)$/ }).click();
    await expect(heading(page, 'Sprawdź i zapisz')).toBeVisible();
    await answerHome(page, false);
    await page.locator('summary', { hasText: 'Notatka' }).click();
    // Stop time before typing so the debounce cannot store the note for us.
    await page.clock.pauseAt(new Date(Date.now() + 1000));
    await page.getByLabel('Co jeszcze chcesz przekazać?').fill('Wnyki przy ścieżce.');
    if (leaving === 'navigation') await page.getByRole('button', { name: 'Dokończę później' }).click();
    else await page.evaluate(leaving => {
      if (leaving === 'visibilitychange') {
        Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
        document.dispatchEvent(new Event('visibilitychange'));
      } else window.dispatchEvent(new PageTransitionEvent('pagehide'));
    }, leaving);
    // IndexedDB runs even while browser timers are paused; let the flush finish before reopening.
    await page.waitForTimeout(100);
    await page.reload();
    if (leaving === 'navigation') await draftCard(page).click();
    await expect(page.getByLabel('Co jeszcze chcesz przekazać?')).toHaveValue('Wnyki przy ścieżce.');
  });
}

/** From an Event row to Gdzie's map for something happening now, with the location request still open. */
async function toMapWhileLocating(page: Page) {
  const location = await heldLocation(page);
  await page.goto('/');
  await page.getByRole('button', { name: 'Kłusownictwo', exact: true }).click();
  await location.asked(1);
  await answerNow(page);
  await expect(heading(page, 'Gdzie to było?')).toBeVisible();
  // The phone is still trying, so there is nothing to retry yet.
  await expect(retry(page)).toHaveCount(0);
  return location;
}

test('a refused location says so and offers no retry', async ({ page }) => {
  const location = await toMapWhileLocating(page);
  await location.fail(1);
  // The status line under the method buttons names the refusal; no second alert repeats it.
  await expect(page.getByRole('status').filter({ hasText: 'Brak zgody na lokalizację.' })).toBeVisible();
  await expect(page.getByRole('alert')).toHaveCount(0);
  await expect(retry(page)).toHaveCount(0);
});

test('a location attempt runs for a minute, and one that runs out can be tried again', async ({ page }) => {
  const location = await toMapWhileLocating(page);
  const options = await page.evaluate(() => (window as unknown as { locateOptions(): PositionOptions[] }).locateOptions());
  expect(options[0]).toMatchObject({ timeout: 60_000, maximumAge: 60_000 });
  // Samples the message as it arrives: it grows and fades in rather than being painted in place.
  await page.evaluate(() => {
    const frames: { height: number; opacity: number }[] = [];
    Object.assign(window, { problemFrames: frames });
    const sample = () => {
      const block = document.querySelector<HTMLElement>('.location-problem');
      if (block) frames.push({ height: block.getBoundingClientRect().height, opacity: Number(getComputedStyle(block).opacity) });
      if (frames.length < 24) requestAnimationFrame(sample);
    };
    requestAnimationFrame(sample);
  });
  await location.fail(3);
  await expect(page.getByRole('alert')).toHaveText('Nie udało się ustalić miejsca. Możesz spróbować ponownie z bezpiecznego miejsca.');
  await expect.poll(() => page.evaluate(() => (window as unknown as { problemFrames: unknown[] }).problemFrames.length)).toBe(24);
  const frames = await page.evaluate(() => (window as unknown as { problemFrames: { height: number; opacity: number }[] }).problemFrames);
  const final = frames.at(-1)!;
  expect(frames[0].opacity).toBeLessThan(0.5);
  expect(frames[0].height).toBeLessThan(final.height / 2);
  for (let index = 1; index < frames.length; index++) {
    expect(frames[index].height).toBeGreaterThanOrEqual(frames[index - 1].height);
    expect(frames[index].opacity).toBeGreaterThanOrEqual(frames[index - 1].opacity);
  }
  expect(final.opacity).toBe(1);
  await page.evaluate(() => {
    const frames: { height: number; opacity: number }[] = [];
    Object.assign(window, { retryFrames: frames });
    const sample = () => {
      const block = document.querySelector<HTMLElement>('.location-problem');
      frames.push(block ? { height: block.getBoundingClientRect().height, opacity: Number(getComputedStyle(block).opacity) }
        : { height: 0, opacity: 0 });
      if (frames.length < 24) requestAnimationFrame(sample);
    };
    requestAnimationFrame(sample);
  });
  await retry(page).focus();
  await page.keyboard.press('Enter');
  await location.asked(1);
  await expect(retry(page)).toHaveCount(0);
  // The control that was pressed is gone while the phone tries, so focus waits on the heading.
  await expect(heading(page, 'Gdzie to było?')).toBeFocused();
  await expect.poll(() => page.evaluate(() => (window as unknown as { retryFrames: unknown[] }).retryFrames.length)).toBe(24);
  const retryFrames = await page.evaluate(() => (window as unknown as { retryFrames: { height: number; opacity: number }[] }).retryFrames);
  expect(retryFrames.some(frame => frame.opacity > 0 && frame.opacity < 1)).toBe(true);
  for (let index = 1; index < retryFrames.length; index++) {
    expect(retryFrames[index].height).toBeLessThanOrEqual(retryFrames[index - 1].height);
    expect(retryFrames[index].opacity).toBeLessThanOrEqual(retryFrames[index - 1].opacity);
  }
  expect(retryFrames.at(-1)).toEqual({ height: 0, opacity: 0 });
  await location.fix(0);
  await expect(page.getByRole('alert')).toHaveCount(0);
});

type StoredDraft = { id: string; occurredMode?: string; hoursAgo?: number; note?: string; manualLat?: string; photos?: { id: string }[] };
const readStore = <T>(page: Page, name: 'drafts' | 'reports') => page.evaluate(name => new Promise<T[]>((resolve, reject) => {
  const open = indexedDB.open('bor-czuwa');
  open.onerror = () => reject(open.error);
  open.onsuccess = () => {
    const all = open.result.transaction(name).objectStore(name).getAll();
    all.onsuccess = () => { open.result.close(); resolve(all.result); };
  };
}), name);
const storedDraft = async (page: Page) => (await readStore<StoredDraft>(page, 'drafts'))[0];
const noteBox = (page: Page) => page.getByLabel('Co jeszcze chcesz przekazać?');
async function openNote(page: Page) {
  const summary = page.locator('summary', { hasText: 'Notatka' });
  if (!await summary.evaluate(element => (element.parentElement as HTMLDetailsElement).open)) await summary.click();
}
async function typeNote(page: Page, text: string) {
  await openNote(page);
  await noteBox(page).fill(text);
  await expect.poll(async () => (await storedDraft(page))?.note).toBe(text);
}
/** Tab A starts a Draft and waits on Kiedy; tab B opens the same Draft on Sprawdź. Both have loaded it before either edits. */
async function twoTabs(context: BrowserContext, event = 'Kłusownictwo') {
  const a = await context.newPage();
  await a.goto('/');
  await a.getByRole('button', { name: event, exact: true }).click();
  await expect(heading(a, 'Kiedy to się stało?')).toBeVisible();
  const id = new URL(a.url()).searchParams.get('draft')!;
  const b = await context.newPage();
  await b.goto(`/?screen=details&draft=${id}`);
  await expect(b.locator('summary', { hasText: 'Notatka' })).toBeVisible();
  return { a, b, id };
}
async function setTime(page: Page) {
  await page.getByRole('button', { name: 'Kilka godzin temu' }).click();
  await expect.poll(async () => (await storedDraft(page)).occurredMode).toBe('within_hours');
}

for (const order of ['A time then B note', 'B note then A time']) {
  test(`two tabs on one Draft keep both fields: ${order}`, async ({ context }) => {
    const { a, b } = await twoTabs(context);
    if (order.startsWith('A')) { await setTime(a); await typeNote(b, 'Notatka z karty B'); }
    else { await typeNote(b, 'Notatka z karty B'); await setTime(a); }
    expect(await storedDraft(a)).toMatchObject({ occurredMode: 'within_hours', note: 'Notatka z karty B' });
  });
}

test('one tab keeps both fields', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Kłusownictwo', exact: true }).click();
  await setTime(page);
  await page.goto(`/?screen=details&draft=${new URL(page.url()).searchParams.get('draft')}`);
  await typeNote(page, 'Notatka');
  expect((await storedDraft(page)).occurredMode).toBe('within_hours');
});

test('when two tabs change one field, the later write wins', async ({ context }) => {
  const { a, b } = await twoTabs(context);
  await b.goto(a.url());
  await expect(heading(b, 'Kiedy to się stało?')).toBeVisible();
  await a.getByRole('button', { name: 'Kilka godzin temu' }).click();
  await chooseHours(a, 2);
  await expect.poll(async () => (await storedDraft(a)).hoursAgo).toBe(2);
  await b.getByRole('button', { name: 'Kilka godzin temu' }).click();
  await chooseHours(b, 3);
  await expect.poll(async () => (await storedDraft(a)).hoursAgo).toBe(3);
  // Tab A, which still holds 2, moves on and writes a note without reverting B's 3.
  await footer(a).getByRole('button', { name: 'Dalej' }).click();
  await choosePoint(a, point.lat, point.lon);
  await typeNote(a, 'Notatka z karty A');
  expect(await storedDraft(a)).toMatchObject({ hoursAgo: 3, note: 'Notatka z karty A' });
});

test('a Report saved from a tab that missed the other tab\'s note has the note', async ({ context }) => {
  const { a, b } = await twoTabs(context);
  await reportPost(a);
  await a.getByRole('button', { name: 'Kilka godzin temu' }).click();
  await footer(a).getByRole('button', { name: 'Dalej' }).click();
  await choosePoint(a, point.lat, point.lon);
  await answerHome(a, false);
  await typeNote(b, 'Notatka z karty B');
  await save(a);
  await expect(heading(a, /^Zgłoszenie$/)).toBeVisible();
  const [report] = await readStore<{ note?: string; report: { has_note: boolean } }>(a, 'reports');
  expect(report.note).toBe('Notatka z karty B');
  expect(report.report.has_note).toBe(true);
});

/** Waits until every write this origin queued before now has completed: transactions on one store run in order. */
const barrier = (page: Page) => page.evaluate(() => new Promise<void>((resolve, reject) => {
  const open = indexedDB.open('bor-czuwa');
  open.onerror = () => reject(open.error);
  open.onsuccess = () => {
    const tx = open.result.transaction('drafts', 'readwrite');
    tx.oncomplete = () => { open.result.close(); resolve(); };
  };
}));
const settleWrites = async (page: Page) => { await barrier(page); await page.waitForTimeout(0); await barrier(page); };
const reportsHeld = async (page: Page) => (await readStore(page, 'reports')).length;

async function deleteDraftInNewTab(context: BrowserContext) {
  const c = await context.newPage();
  await c.goto('/');
  await c.getByRole('button', { name: 'Moje zapisy', exact: true }).click();
  await c.getByRole('button', { name: 'Usuń szkic' }).click();
  await c.getByRole('group', { name: 'Usunąć szkic?' }).getByRole('button', { name: 'Usuń', exact: true }).click();
  await expect(c.getByRole('button', { name: 'Usuń szkic' })).toHaveCount(0);
  return c;
}
async function expectNoDraftCard(page: Page) {
  await page.goto('/');
  await expect(heading(page, 'Co się stało?')).toBeVisible();
  await expect(draftCard(page)).toHaveCount(0);
}
/** The page goes to the background the way a phone or a tab switch sends it: the app flushes as it would before being stopped. */
const setHidden = (page: Page, hidden: boolean) => page.evaluate(hidden => {
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => hidden ? 'hidden' : 'visible' });
  document.dispatchEvent(new Event('visibilitychange'));
}, hidden);

test('a Draft deleted in another tab is not brought back by a late edit or a leaving tab', async ({ context }) => {
  const { a, b } = await twoTabs(context);
  const c = await deleteDraftInNewTab(context);
  // Tab A's edit is stored at once; tab B's note is still waiting in its debounce when it leaves.
  await a.getByRole('button', { name: 'Kilka godzin temu' }).click();
  await openNote(b);
  await noteBox(b).fill('Spóźniona notatka');
  await b.goto('/');
  await settleWrites(c);
  expect(await readStore(c, 'drafts')).toEqual([]);
  await expectNoDraftCard(c);
  await expectNoDraftCard(a);
});

test('a Draft deleted in another tab is not brought back when the editing tab goes to the background', async ({ context }) => {
  const { b } = await twoTabs(context);
  const c = await deleteDraftInNewTab(context);
  await openNote(b);
  await noteBox(b).fill('Notatka przed ukryciem');
  await setHidden(b, true);
  await settleWrites(c);
  expect(await readStore(c, 'drafts')).toEqual([]);
  await setHidden(b, false);
  await settleWrites(c);
  expect(await readStore(c, 'drafts')).toEqual([]);
  await expectNoDraftCard(c);
});

test('a Draft saved as a Report in another tab is not brought back by a leaving tab', async ({ context }) => {
  const { a, b } = await twoTabs(context);
  await reportPost(a);
  await a.getByRole('button', { name: 'Kilka godzin temu' }).click();
  await footer(a).getByRole('button', { name: 'Dalej' }).click();
  await choosePoint(a, point.lat, point.lon);
  await answerHome(a, false);
  await save(a);
  await expect(heading(a, /^Zgłoszenie$/)).toBeVisible();
  await openNote(b);
  await noteBox(b).fill('Notatka po zapisie');
  await b.goto('/');
  await settleWrites(a);
  expect(await readStore(a, 'drafts')).toEqual([]);
  await expectNoDraftCard(a);
  expect(await reportsHeld(a)).toBe(1);
});

test('a stale tab saving after another tab saved gets no second Report', async ({ context }) => {
  const { a, b } = await twoTabs(context);
  await b.goto(`/?screen=when&draft=${new URL(a.url()).searchParams.get('draft')}`);
  await reportPost(a); await reportPost(b);
  for (const page of [a, b]) {
    await page.getByRole('button', { name: 'Kilka godzin temu' }).click();
    await footer(page).getByRole('button', { name: 'Dalej' }).click();
    await choosePoint(page, point.lat, point.lon);
    // Tab B has adopted tab A's answer by now, so it may not ask again.
    if (await page.locator('#home-check').isVisible()) await answerHome(page, false);
  }
  await save(a);
  await expect(heading(a, /^Zgłoszenie$/)).toBeVisible();
  await save(b);
  // Tab B ends on the home screen. A second Report would have opened its own Report screen.
  await expect(heading(b, 'Co się stało?').or(heading(b, /^Zgłoszenie$/))).toBeVisible();
  await expect(heading(b, 'Co się stało?')).toBeVisible();
  await settleWrites(a);
  expect(await reportsHeld(a)).toBe(1);
  await expectNoDraftCard(b);
});

for (const leave of ['navigates away', 'closes']) {
  test(`a tab that types a note and ${leave} at once keeps the other tab's time`, async ({ context }) => {
    const { a, b } = await twoTabs(context);
    await setTime(a);
    await openNote(b);
    await noteBox(b).fill('Notatka i od razu wyjście');
    // No wait: the note is still in its debounce when the page goes.
    if (leave === 'closes') await b.close({ runBeforeUnload: true });
    else await b.goto('/');
    const reader = leave === 'closes' ? a : b;
    if (leave === 'closes') await reader.goto('/');
    await expect(heading(reader, 'Co się stało?')).toBeVisible();
    await expect.poll(() => storedDraft(reader)).toMatchObject({ occurredMode: 'within_hours', note: 'Notatka i od razu wyjście' });
  });
}

test('a photo added in one tab survives a note from a tab that loaded the Draft before it', async ({ context }) => {
  await context.setGeolocation({ latitude: 52.1, longitude: 21.1, accuracy: 8 });
  const a = await context.newPage();
  await a.goto('/');
  await a.getByRole('button', { name: 'Szczątki w lesie', exact: true }).click();
  await finishFromWhen(a, false);
  const image = (shade: number) => a.evaluate(async shade => {
    const canvas = document.createElement('canvas'); canvas.width = 30; canvas.height = 20;
    const context = canvas.getContext('2d')!; context.fillStyle = `rgb(${shade},0,0)`; context.fillRect(0, 0, 30, 20);
    const blob = await new Promise<Blob>(resolve => canvas.toBlob(value => resolve(value!), 'image/png'));
    return Array.from(new Uint8Array(await blob.arrayBuffer()));
  }, shade);
  const addPhoto = async (name: string, shade: number, count: number) => {
    await a.locator('input[type=file]').setInputFiles({ name, mimeType: 'image/png', buffer: Buffer.from(await image(shade)) });
    await expect(a.locator('.photo-tile')).toHaveCount(count);
    await expect.poll(async () => (await storedDraft(a)).photos?.length).toBe(count);
  };
  await addPhoto('one.png', 10, 1);
  const b = await context.newPage();
  await b.goto(a.url());
  await expect(b.locator('.photo-tile')).toHaveCount(1);
  await addPhoto('two.png', 200, 2);
  await typeNote(b, 'Notatka z karty B');
  expect((await storedDraft(a)).photos?.length).toBe(2);
});

test('a tab still running the previous build keeps saving beside this one', async ({ context }) => {
  // The previous build's tab is open first: it made the version 6 database, holds a Draft and keeps its connection.
  const old = await context.newPage();
  await old.route('**/previous-build', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>previous build</title>' }));
  await old.goto('/previous-build');
  const id = 'previous-build-draft';
  await old.evaluate(id => new Promise<void>((resolve, reject) => {
    const open = indexedDB.open('bor-czuwa', 6);
    open.onupgradeneeded = () => {
      const db = open.result;
      db.createObjectStore('reports', { keyPath: 'report.id' });
      const now = new Date().toISOString();
      db.createObjectStore('drafts', { keyPath: 'id' }).put({ id, eventType: 4, capturedAt: now, lastActivityAt: now });
      db.createObjectStore('home', { keyPath: 'id' });
      db.createObjectStore('signer', { keyPath: 'id' });
      db.createObjectStore('withdrawals', { keyPath: 'id' });
    };
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const db = open.result;
      const previous = { db, closedByUpgrade: false, copy: undefined as unknown };
      Object.assign(window, { previous });
      db.onversionchange = () => { previous.closedByUpgrade = true; db.close(); };
      const read = db.transaction('drafts').objectStore('drafts').get(id);
      read.onsuccess = () => { previous.copy = read.result; resolve(); };
    };
  }), id);
  // This build opens the same Draft and stores an answer.
  const a = await context.newPage();
  await a.goto(`/?screen=when&draft=${id}`);
  await expect(heading(a, 'Kiedy to się stało?')).toBeVisible();
  await setTime(a);
  // The previous build's tab now saves a note from its own copy over its live connection.
  const saved = await old.evaluate(() => new Promise<string>(resolve => {
    const previous = (window as unknown as { previous: { db: IDBDatabase; copy: object } }).previous;
    try {
      const tx = previous.db.transaction('drafts', 'readwrite');
      tx.objectStore('drafts').put({ ...previous.copy, note: 'Notatka ze starej wersji' });
      tx.oncomplete = () => resolve('saved');
      tx.onerror = () => resolve(String(tx.error?.name));
    } catch (cause) { resolve((cause as Error).name); }
  }));
  expect(saved).toBe('saved');
  expect(await old.evaluate(() => (window as unknown as { previous: { closedByUpgrade: boolean } }).previous.closedByUpgrade)).toBe(false);
  expect((await storedDraft(a)).note).toBe('Notatka ze starej wersji');
  // This build's next edit keeps the previous build's note. (The previous build's whole-copy put removed the time, as it always could.)
  await footer(a).getByRole('button', { name: 'Dalej' }).click();
  await choosePoint(a, point.lat, point.lon);
  await expect.poll(async () => (await storedDraft(a)).manualLat).toBeTruthy();
  expect((await storedDraft(a)).note).toBe('Notatka ze starej wersji');
});

/*
 * Forced transaction orders. A third page holds the drafts store, so the writes the tabs start queue in
 * the order they were started; releasing it runs them in that order.
 */
type CountedWindow = Window & { draftWrites: number };
async function countDraftWrites(context: BrowserContext) {
  await context.addInitScript(() => {
    const counted = window as unknown as CountedWindow;
    counted.draftWrites = 0;
    const transaction = IDBDatabase.prototype.transaction;
    IDBDatabase.prototype.transaction = function (this: IDBDatabase, ...args: Parameters<typeof transaction>) {
      const [stores, mode] = args;
      if (mode === 'readwrite' && [stores].flat().includes('drafts')) counted.draftWrites++;
      return transaction.apply(this, args);
    } as typeof transaction;
  });
}
const writesStarted = (page: Page) => page.evaluate(() => (window as unknown as CountedWindow).draftWrites);
async function holdDrafts(context: BrowserContext) {
  const holder = await context.newPage();
  await holder.route('**/holder', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>holder</title>' }));
  await holder.goto('/holder');
  await holder.evaluate(() => new Promise<void>((resolve, reject) => {
    const open = indexedDB.open('bor-czuwa');
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const tx = open.result.transaction('drafts', 'readwrite'), store = tx.objectStore('drafts');
      let released = false;
      const keep = () => { if (!released) store.getKey('hold').onsuccess = () => { resolve(); keep(); }; };
      Object.assign(window, { release: () => { released = true; } });
      keep();
    };
  }));
  return { release: () => holder.evaluate(() => (window as unknown as { release(): void }).release()) };
}
/** Runs `act` and waits until it has started one more Draft write in `page`. */
async function started(page: Page, act: () => Promise<unknown>) {
  const before = await writesStarted(page);
  await act();
  await expect.poll(() => writesStarted(page)).toBeGreaterThan(before);
}

for (const first of ['B note', 'A hours']) {
  test(`queued writes from both tabs keep the later answer and the note: ${first} queued first`, async ({ context }) => {
    await countDraftWrites(context);
    const { a, b } = await twoTabs(context);
    await b.goto(a.url());
    await expect(heading(b, 'Kiedy to się stało?')).toBeVisible();
    await b.goto(`/?screen=details&draft=${new URL(a.url()).searchParams.get('draft')}`);
    await a.getByRole('button', { name: 'Kilka godzin temu' }).click();
    await chooseHours(a, 2);
    await expect.poll(async () => (await storedDraft(a)).hoursAgo).toBe(2);
    const hold = await holdDrafts(context);
    const note = () => started(b, async () => { await openNote(b); await noteBox(b).fill('Notatka z karty B'); });
    const hours = () => started(a, () => chooseHours(a, 3));
    if (first === 'B note') { await note(); await hours(); } else { await hours(); await note(); }
    await hold.release();
    await expect.poll(() => storedDraft(a)).toMatchObject({ hoursAgo: 3, note: 'Notatka z karty B' });
  });
}

test('a Report save queued behind a stale tab\'s note has the note and the time', async ({ context }) => {
  await countDraftWrites(context);
  const { a, b } = await twoTabs(context);
  await reportPost(a);
  await a.getByRole('button', { name: 'Kilka godzin temu' }).click();
  await chooseHours(a, 2);
  await footer(a).getByRole('button', { name: 'Dalej' }).click();
  await choosePoint(a, point.lat, point.lon);
  await answerHome(a, false);
  await settleWrites(a);
  const hold = await holdDrafts(context);
  await started(b, async () => { await openNote(b); await noteBox(b).fill('Notatka z karty B'); });
  await started(a, () => save(a));
  await hold.release();
  await expect(heading(a, /^Zgłoszenie$/)).toBeVisible();
  const [report] = await readStore<{ note: string; report: { occurred_at: unknown } }>(a, 'reports');
  expect(report.note).toBe('Notatka z karty B');
  expect(report.report.occurred_at).toBeTruthy();
  await settleWrites(a);
  expect(await readStore(a, 'drafts')).toEqual([]);
});

test('a write queued behind a deletion never puts the Draft back', async ({ context }) => {
  await countDraftWrites(context);
  await context.addInitScript(() => {
    const put = IDBObjectStore.prototype.put;
    Object.assign(window, { draftPuts: [] as string[] });
    IDBObjectStore.prototype.put = function (this: IDBObjectStore, ...args: Parameters<typeof put>) {
      if (this.name === 'drafts') (window as unknown as { draftPuts: string[] }).draftPuts.push((args[0] as { id: string }).id);
      return put.apply(this, args);
    };
  });
  const { a, b, id } = await twoTabs(context);
  const c = await context.newPage();
  await c.goto('/');
  await c.getByRole('button', { name: 'Moje zapisy', exact: true }).click();
  await settleWrites(c);
  for (const page of [a, b]) await page.evaluate(() => { (window as unknown as { draftPuts: string[] }).draftPuts.length = 0; });
  const hold = await holdDrafts(context);
  await started(c, async () => {
    await c.getByRole('button', { name: 'Usuń szkic' }).click();
    await c.getByRole('group', { name: 'Usunąć szkic?' }).getByRole('button', { name: 'Usuń', exact: true }).click();
  });
  await started(a, () => a.getByRole('button', { name: 'Kilka godzin temu' }).click());
  await started(b, async () => { await openNote(b); await noteBox(b).fill('Notatka po usunięciu'); });
  await hold.release();
  await settleWrites(c);
  expect(await readStore(c, 'drafts')).toEqual([]);
  for (const page of [a, b]) expect(await page.evaluate(() => (window as unknown as { draftPuts: string[] }).draftPuts)).not.toContain(id);
});

/** localStorage refuses every Draft note in this context, as when its quota is full. */
const refuseDraftNotes = (context: BrowserContext) => context.addInitScript(() => {
  const setItem = Storage.prototype.setItem;
  Storage.prototype.setItem = function (this: Storage, key: string, value: string) {
    if (key.startsWith('draft-')) throw new DOMException('probe quota refusal', 'QuotaExceededError');
    return setItem.call(this, key, value);
  };
});
/** Journal entries and kept photos in the pending database that nothing has applied or deleted yet. */
const journalRecords = (page: Page) => page.evaluate(() => new Promise<unknown[]>((resolve, reject) => {
  const open = indexedDB.open('bor-czuwa-pending');
  open.onerror = () => reject(open.error);
  open.onupgradeneeded = () => open.result.createObjectStore('items', { keyPath: 'id' });
  open.onsuccess = () => {
    const all = open.result.transaction('items').objectStore('items').getAll();
    // A closed Draft's own id is all a closure record holds; only entries and photos carry fields.
    all.onsuccess = () => { open.result.close(); resolve(all.result.filter(item => /^draft-(journal|photo):/.test(item.id))); };
  };
}));
const localNotes = (page: Page) => page.evaluate(() => Object.keys(localStorage).map(key => `${key}=${localStorage.getItem(key)}`));

test('with localStorage refusing notes, a stale tab leaving after a deletion does not bring the Draft back', async ({ context }) => {
  await refuseDraftNotes(context);
  const { b } = await twoTabs(context);
  const c = await deleteDraftInNewTab(context);
  await openNote(b);
  await noteBox(b).fill('Notatka bez localStorage');
  await b.goto('/');
  await expect(heading(b, 'Co się stało?')).toBeVisible();
  await settleWrites(c);
  expect(await readStore(c, 'drafts')).toEqual([]);
  await expectNoDraftCard(c);
  expect(await journalRecords(c)).toEqual([]);
});

test('with localStorage refusing notes, a stale tab that types a note and leaves at once keeps both tabs\' answers', async ({ context }) => {
  await refuseDraftNotes(context);
  const { a, b } = await twoTabs(context);
  await setTime(a);
  await openNote(b);
  await noteBox(b).fill('Notatka przy pełnej pamięci');
  await b.goto('/');
  await expect.poll(() => storedDraft(b)).toMatchObject({ occurredMode: 'within_hours', note: 'Notatka przy pełnej pamięci' });
  expect(await journalRecords(b)).toEqual([]);
});

test('with localStorage refusing notes, a note typed while the store is held and the page leaves is kept', async ({ context }) => {
  await refuseDraftNotes(context);
  await countDraftWrites(context);
  const { a, b } = await twoTabs(context);
  await setTime(a);
  const hold = await holdDrafts(context);
  await started(b, async () => { await openNote(b); await noteBox(b).fill('Notatka przy pełnej pamięci'); });
  await b.goto('/');
  await hold.release();
  await expect.poll(() => storedDraft(b)).toMatchObject({ occurredMode: 'within_hours', note: 'Notatka przy pełnej pamięci' });
  expect(await journalRecords(b)).toEqual([]);
});

test('a photo taken while the store is held, just before the page leaves, is kept', async ({ context }) => {
  await context.setGeolocation({ latitude: 52.1, longitude: 21.1, accuracy: 8 });
  await countDraftWrites(context);
  const a = await context.newPage();
  await a.goto('/');
  await a.getByRole('button', { name: 'Szczątki w lesie', exact: true }).click();
  await finishFromWhen(a, false);
  const image = (shade: number) => a.evaluate(async shade => {
    const canvas = document.createElement('canvas'); canvas.width = 30; canvas.height = 20;
    const context = canvas.getContext('2d')!; context.fillStyle = `rgb(${shade},0,0)`; context.fillRect(0, 0, 30, 20);
    const blob = await new Promise<Blob>(resolve => canvas.toBlob(value => resolve(value!), 'image/png'));
    return Array.from(new Uint8Array(await blob.arrayBuffer()));
  }, shade);
  await a.locator('input[type=file]').setInputFiles({ name: 'one.png', mimeType: 'image/png', buffer: Buffer.from(await image(10)) });
  await expect.poll(async () => (await storedDraft(a)).photos?.length).toBe(1);
  // Another tab writes, so tab A cannot prove its copy whole when it leaves.
  const b = await context.newPage();
  await b.goto(a.url());
  await typeNote(b, 'Notatka z karty B');
  const hold = await holdDrafts(context);
  const photo = Buffer.from(await image(200));
  await started(a, () => a.locator('input[type=file]').setInputFiles({ name: 'two.png', mimeType: 'image/png', buffer: photo }));
  // The photo is kept on its own, although the Draft's write still waits behind the held store.
  await expect.poll(async () => (await journalRecords(a)).length).toBe(1);
  await a.goto('/');
  await hold.release();
  await expect.poll(async () => (await storedDraft(b))?.photos?.length).toBe(2);
  expect((await storedDraft(b)).note).toBe('Notatka z karty B');
});

test('an unrelated edit queued after two tabs\' answers does not bring back the earlier answer', async ({ context }) => {
  await countDraftWrites(context);
  const { a, b, id } = await twoTabs(context);
  await b.goto(`/?screen=when&draft=${id}`);
  await expect(heading(b, 'Kiedy to się stało?')).toBeVisible();
  for (const page of [a, b]) await page.getByRole('button', { name: 'Kilka godzin temu' }).click();
  await settleWrites(a);
  const hold = await holdDrafts(context);
  await started(a, () => chooseHours(a, 2));
  await started(b, () => chooseHours(b, 3));
  // Tab A moves on and adds an unrelated answer while its own 2 hours have not been answered.
  await footer(a).getByRole('button', { name: 'Dalej' }).click();
  await started(a, async () => {
    await openMap(a);
    if (!await a.locator('details.advanced').evaluate(element => (element as HTMLDetailsElement).open)) await a.getByText('Wpisz współrzędne', { exact: true }).click();
    await a.getByLabel('Szerokość geograficzna').fill(String(point.lat));
    await a.getByLabel('Długość geograficzna').fill(String(point.lon));
    await a.getByRole('button', { name: 'Wskaż wpisany punkt' }).click();
  });
  await hold.release();
  await settleWrites(a);
  await expect.poll(async () => (await storedDraft(a)).manualLat).toBeTruthy();
  expect((await storedDraft(a)).hoursAgo).toBe(3);
});

test('a stale tab leaving after a deletion leaves no Draft field in localStorage or the journal', async ({ context }) => {
  await context.setGeolocation({ latitude: 52.123456, longitude: 21.654321, accuracy: 8 });
  const { b } = await twoTabs(context);
  const c = await deleteDraftInNewTab(context);
  await openNote(b);
  await noteBox(b).fill('Prywatna notatka po usunięciu');
  // The tab is closed, so it lists no Drafts again; tab C reads storage without listing either.
  await b.close({ runBeforeUnload: true });
  await settleWrites(c);
  expect(await readStore(c, 'drafts')).toEqual([]);
  const notes = (await localNotes(c)).join('\n');
  expect(notes).not.toContain('Prywatna notatka');
  expect(notes).not.toContain('52.123');
  expect(notes).not.toContain('21.654');
  expect(await journalRecords(c)).toEqual([]);
  await expectNoDraftCard(c);
  expect(await journalRecords(c)).toEqual([]);
});

/** localStorage refuses every change to a Draft note once `probe-refuse` is set, as when its quota fills up mid-session. */
const refuseDraftNotesLater = (context: BrowserContext) => context.addInitScript(() => {
  for (const name of ['setItem', 'removeItem'] as const) {
    const original = Storage.prototype[name] as (this: Storage, ...args: string[]) => void;
    (Storage.prototype as unknown as Record<string, unknown>)[name] = function (this: Storage, key: string, ...rest: string[]) {
      if (key.startsWith('draft-') && this.getItem('probe-refuse') === '1') throw new DOMException('probe quota refusal', 'QuotaExceededError');
      return original.call(this, key, ...rest);
    };
  }
});
const photoBytes = (page: Page) => page.evaluate(async () => {
  const canvas = document.createElement('canvas'); canvas.width = 30; canvas.height = 20;
  const context = canvas.getContext('2d')!; context.fillStyle = 'rgb(90,0,0)'; context.fillRect(0, 0, 30, 20);
  const blob = await new Promise<Blob>(resolve => canvas.toBlob(value => resolve(value!), 'image/png'));
  return Array.from(new Uint8Array(await blob.arrayBuffer()));
});

test('localStorage that starts refusing after a tab stored its note does not let that tab bring a deleted Draft back', async ({ context }) => {
  await refuseDraftNotesLater(context);
  const a = await context.newPage();
  await a.goto('/');
  await a.getByRole('button', { name: 'Kłusownictwo', exact: true }).click();
  await setTime(a);
  await footer(a).getByRole('button', { name: 'Dalej' }).click();
  await choosePoint(a, point.lat, point.lon);
  await answerHome(a, false);
  await expect(a.locator('summary', { hasText: 'Notatka' })).toBeVisible();
  // Only tab A has written, so its writer note still names its own last write.
  await settleWrites(a);
  await a.evaluate(() => localStorage.setItem('probe-refuse', '1'));
  const c = await deleteDraftInNewTab(context);
  await openNote(a);
  await noteBox(a).fill('late');
  await a.close({ runBeforeUnload: true });
  await settleWrites(c);
  expect(await readStore(c, 'drafts')).toEqual([]);
  await expectNoDraftCard(c);
});

test('a stale tab writing after a deletion keeps the Draft closed, goes home and leaves nothing when it closes', async ({ context }) => {
  const { b, id } = await twoTabs(context);
  const c = await deleteDraftInNewTab(context);
  await openNote(b);
  await noteBox(b).fill('Notatka po usunięciu');
  // Its write finds the Draft gone: the tab stops editing it and shows what exists.
  await expect(heading(b, 'Co się stało?')).toBeVisible();
  expect(await b.evaluate(id => localStorage.getItem(`draft-writer:${id}`), id)).toBe('closed');
  const hold = await holdDrafts(context);
  await b.close({ runBeforeUnload: true });
  await hold.release();
  await settleWrites(c);
  expect(await readStore(c, 'drafts')).toEqual([]);
  expect(await journalRecords(c)).toEqual([]);
  expect((await localNotes(c)).join('\n')).not.toContain('Notatka po usunięciu');
});

test('a photo a stale tab takes after a deletion is not kept', async ({ context }) => {
  const { b } = await twoTabs(context, 'Szczątki w lesie');
  const c = await deleteDraftInNewTab(context);
  await b.locator('input[type=file]').first().setInputFiles({ name: 'late.png', mimeType: 'image/png', buffer: Buffer.from(await photoBytes(b)) });
  await settleWrites(c);
  await b.waitForTimeout(300);
  expect(await readStore(c, 'drafts')).toEqual([]);
  expect(await journalRecords(c)).toEqual([]);
  await expect(heading(b, 'Co się stało?')).toBeVisible();
});

test('with localStorage refusing notes, a note typed after another tab\'s saved note and left behind a held store wins', async ({ context }) => {
  await refuseDraftNotes(context);
  await countDraftWrites(context);
  const { a, b, id } = await twoTabs(context);
  // Both tabs hold the Draft without a note; B then saves its note first.
  await a.goto(`/?screen=details&draft=${id}`);
  await expect(a.locator('summary', { hasText: 'Notatka' })).toBeVisible();
  await typeNote(b, 'B earlier');
  const hold = await holdDrafts(context);
  await openNote(a);
  await noteBox(a).fill('A later');
  // Leaving starts A's write behind the held store. The page that loads next has its own write
  // counter, and its list read waits behind the hold too, so the leave is not counted with started().
  await a.goto('/');
  await hold.release();
  await expect.poll(async () => (await storedDraft(b))?.note).toBe('A later');
  await expect.poll(() => journalRecords(b)).toEqual([]);
});
