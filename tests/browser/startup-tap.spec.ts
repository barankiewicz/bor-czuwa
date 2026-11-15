import { test, expect, type Page } from '@playwright/test';

test.use({ serviceWorkers: 'block' });

const draftLine = 'Otwieram szkic…';

type Frame = { t: number; present: boolean; text: string; opacity: number; line: DOMRect | null; alert: DOMRect | null };
type Hooks = {
  __held: () => number; __release: (keep?: boolean) => void; __fail: () => void;
  __settled: () => boolean; __paint: () => void; __tapDuringChange: (mode: 'sync' | 'microtask') => void; __tap: () => void; __loadingAt: number; __frames: Frame[];
};
const hooks = (page: Page) => page.evaluateHandle(() => window as unknown as Hooks);

// Holds start-up the way a slow phone does, and lets the test choose the order of events instead of the scheduler:
// - every IndexedDB open made while the hold is on waits for its success event until `__release`;
//   `__release(true)` lets the waiting opens through and keeps holding the ones that come after;
// - `__tapDuringChange` taps the logo while start-up's screen change after its storage read is in flight, and holds
//   the tap's own screen change (the paint that has not landed yet) until `__paint`; a newer change skipping it
//   runs its update first, as the browser does;
// - `__settled` is true once start-up has moved past the restore decision and storage has gone quiet.
// Each frame records the start-up status region and any alert.
async function prepare(page: Page) {
  await page.addInitScript(() => {
    const w = window as unknown as Record<string, unknown>;
    let holding = sessionStorage.getItem('hold-start') === '1';
    sessionStorage.removeItem('hold-start');
    const waiting: (() => void)[] = [];
    const gates = new Set<{ open: boolean }>();
    const requests: IDBOpenDBRequest[] = [];
    let pending = 0;
    let continued = false;
    w.__held = () => waiting.length;
    w.__release = (keep = false) => {
      holding = keep;
      for (const gate of gates) gate.open = true;
      gates.clear();
      waiting.splice(0).forEach(run => run());
    };
    // Fails the held opens instead, the way a broken or full storage answers start-up.
    w.__fail = () => { holding = false; waiting.length = 0; requests.splice(0).forEach(request => request.dispatchEvent(new Event('error'))); };
    const open = IDBFactory.prototype.open;
    IDBFactory.prototype.open = function (this: IDBFactory, ...args: Parameters<IDBFactory['open']>) {
      const request = open.apply(this, args);
      pending++;
      let counted = false;
      const done = () => { if (!counted) { counted = true; pending--; } };
      const gate = { open: !holding };
      if (holding) { gates.add(gate); requests.push(request); }
      const add = request.addEventListener.bind(request);
      add('error', done);
      request.addEventListener = ((type: string, listener: EventListener, options?: AddEventListenerOptions) => type === 'success'
        ? add(type, event => { const run = () => { done(); listener(event); }; if (gate.open) run(); else waiting.push(run); }, options)
        : add(type, listener, options)) as typeof request.addEventListener;
      return request;
    };
    const transaction = IDBDatabase.prototype.transaction;
    IDBDatabase.prototype.transaction = function (this: IDBDatabase, ...args: Parameters<IDBDatabase['transaction']>) {
      const tx = transaction.apply(this, args);
      pending++;
      let counted = false;
      const done = () => { if (!counted) { counted = true; pending--; } };
      for (const type of ['complete', 'abort', 'error']) tx.addEventListener(type, done);
      return tx;
    };
    // Start-up asks whether storage is kept right after it decides on the restore, so this marks the decision.
    const storage = navigator.storage;
    if (storage?.persisted) {
      const persisted = storage.persisted.bind(storage);
      storage.persisted = () => { continued = true; return persisted(); };
    }
    // Screen changes: the tap's update waits for `__paint`.
    const queue: { run: () => void }[] = [];
    let holdNext = false;
    let armed: 'sync' | 'microtask' | undefined;
    const tap = () => { holdNext = true; document.querySelector<HTMLElement>('.brand')!.click(); };
    w.__tapDuringChange = (mode: 'sync' | 'microtask') => { armed = mode; };
    w.__tap = tap;
    const start = document.startViewTransition?.bind(document);
    if (start) {
      document.startViewTransition = ((update?: ViewTransitionUpdateCallback) => {
        if (!holdNext) {
          const transition = start(update);
          const mode = armed;
          armed = undefined;
          if (mode === 'sync') tap();
          else if (mode === 'microtask') queueMicrotask(tap);
          return transition;
        }
        holdNext = false;
        let finish!: () => void;
        const updated = new Promise<void>(resolve => finish = resolve);
        const entry = { run: () => { const at = queue.indexOf(entry); if (at < 0) return; queue.splice(at, 1); void Promise.resolve(update?.()).then(finish); } };
        queue.push(entry);
        return { updateCallbackDone: updated, ready: updated, finished: updated, skipTransition: () => entry.run(), types: new Set() } as unknown as ViewTransition;
      }) as typeof document.startViewTransition;
    }
    w.__paint = () => { while (queue.length) queue[0].run(); };
    // Quiet across two frames: no held or running storage work, and start-up has made its decision.
    let quietFrames = 0;
    const watch = () => { quietFrames = continued && !waiting.length && pending === 0 ? quietFrames + 1 : 0; requestAnimationFrame(watch); };
    requestAnimationFrame(watch);
    w.__settled = () => quietFrames >= 2;

    const frames: Frame[] = [];
    w.__frames = frames;
    w.__loadingAt = 0;
    const sample = () => {
      const region = document.querySelector('.startup-status');
      if (region && !w.__loadingAt) w.__loadingAt = performance.now();
      const line = region?.firstElementChild;
      const alert = document.querySelector('[role="alert"]');
      frames.push({ t: performance.now(), present: !!region && region.getAttribute('role') === 'status',
        text: region?.textContent ?? '', opacity: line ? Number(getComputedStyle(line).opacity) : 0,
        line: line ? line.getBoundingClientRect().toJSON() : null, alert: alert ? alert.getBoundingClientRect().toJSON() : null });
      requestAnimationFrame(sample);
    };
    // The region is in the first paint, so it is found as soon as the body exists.
    new MutationObserver((_, observer) => {
      if (document.querySelector('.startup-status')) { w.__loadingAt = performance.now(); observer.disconnect(); }
    }).observe(document, { childList: true, subtree: true });
    requestAnimationFrame(sample);
  });
}

const frames = async (page: Page) => (await hooks(page)).evaluate(w => w.__frames);

/** Saves a Draft by quick capture and returns the address of its step. */
async function draftAddress(page: Page) {
  await page.context().setGeolocation({ latitude: 52.1, longitude: 19.4, accuracy: 12 });
  await page.goto('/');
  await page.getByRole('button', { name: 'Zapisz miejsce i czas' }).click();
  await expect(page.locator('#receipt')).toBeVisible();
  return page.url();
}

/** Opens the address with start-up held until `__release` runs. */
async function openHeld(page: Page, address: string) {
  await page.evaluate(() => sessionStorage.setItem('hold-start', '1'));
  await page.goto(address, { waitUntil: 'domcontentloaded' });
  await page.locator('.brand').waitFor({ state: 'visible' });
  await page.waitForFunction(() => (window as unknown as Hooks).__held() > 0);
}

/** Waits until start-up has settled, lets the held screen changes paint, and says where the Reporter ended. */
async function ending(page: Page) {
  await page.waitForFunction(() => (window as unknown as Hooks).__settled());
  await page.evaluate(() => (window as unknown as Hooks).__paint());
  await page.locator('.continuation, #receipt').first().waitFor({ state: 'visible', timeout: 8000 });
  const url = new URL(page.url());
  return (await page.locator('#receipt').count()) ? `draft step at ${url.search}` : url.search ? `home at ${url.search}` : 'home';
}

test.beforeEach(async ({ page }) => { await prepare(page); });

test('a logo tap while storage answers ends on home, 25 of 25', async ({ page }) => {
  test.setTimeout(180_000);
  const address = await draftAddress(page);
  const endings: string[] = [];
  for (let run = 0; run < 25; run++) {
    await openHeld(page, address);
    // Storage answers and start-up starts drawing what it read; the tap lands before that change has
    // painted, in the same task for half the runs and one microtask later for the others.
    await page.evaluate(mode => {
      const w = window as unknown as Hooks;
      w.__tapDuringChange(mode);
      w.__release();
    }, run % 2 === 0 ? 'sync' as const : 'microtask' as const);
    endings.push(await ending(page));
  }
  console.log(`tap while storage answers: ${JSON.stringify(endings.reduce<Record<string, number>>((all, end) => ({ ...all, [end]: (all[end] ?? 0) + 1 }), {}))}`);
  expect(endings.filter(end => end !== 'home')).toEqual([]);
  await expect(page.locator('.continuation')).toContainText('Dokończ zgłoszenie');
});

test('without a tap the Draft step comes back, 5 of 5', async ({ page }) => {
  const address = await draftAddress(page);
  const endings: string[] = [];
  for (let run = 0; run < 5; run++) {
    await openHeld(page, address);
    await page.evaluate(() => (window as unknown as Hooks).__release());
    endings.push(await ending(page));
  }
  expect(endings).toEqual(Array(5).fill(`draft step at ${new URL(address).search}`));
});

test('a tap between the restore\'s read and its screen change is not undone', async ({ page }) => {
  const address = await draftAddress(page);
  for (let run = 0; run < 5; run++) {
    await openHeld(page, address);
    // Storage answers start-up; the restore's own read is then held, so the restore is under way.
    await page.evaluate(() => (window as unknown as Hooks).__release(true));
    await page.waitForFunction(() => (window as unknown as Hooks).__held() > 0);
    // The tap's own screen change is held, so the restore's read finishes before the tap has painted.
    await page.evaluate(() => { const w = window as unknown as Hooks; w.__tap(); w.__release(); });
    expect(await ending(page)).toBe('home');
  }
});

test('a slow start says what is opening after 300 ms, and the line goes with the loading screen', async ({ page }) => {
  const address = await draftAddress(page);
  await openHeld(page, address);
  await page.waitForFunction(() => performance.now() - (window as unknown as Hooks).__loadingAt > 1500);
  const held = await frames(page);
  const loadingAt = await page.evaluate(() => (window as unknown as Hooks).__loadingAt);
  expect(held.find(frame => frame.present), 'the status region is painted while start-up waits').toBeTruthy();
  expect(held.filter(frame => frame.present && frame.t - loadingAt < 250 && frame.text)).toEqual([]);
  expect(held.filter(frame => frame.t - loadingAt > 500).map(frame => frame.text)).not.toContain('');
  await expect(page.getByRole('status').filter({ hasText: draftLine })).toHaveCount(1);
  // It fades in rather than appearing at full strength.
  const shown = held.filter(frame => frame.text);
  expect(shown[0].opacity).toBeLessThan(0.5);
  expect(shown.at(-1)!.opacity).toBe(1);
  await page.evaluate(() => (window as unknown as Hooks).__release());
  expect(await ending(page)).toMatch(/^draft step/);
  await expect(page.getByText(draftLine)).toHaveCount(0);
  await page.waitForFunction(() => !(window as unknown as Hooks).__frames.at(-1)!.present);
  const after = (await frames(page)).filter(frame => frame.t > held.at(-1)!.t);
  // Once the Draft step is drawn, no frame shows the line again.
  const drawn = after.findIndex(frame => !frame.present);
  expect(drawn).toBeGreaterThanOrEqual(0);
  expect(after.slice(drawn).filter(frame => frame.text)).toEqual([]);
});

test('a start that finishes within 300 ms never paints the line', async ({ page }) => {
  const address = await draftAddress(page);
  for (let run = 0; run < 3; run++) {
    await openHeld(page, address);
    // Released 120 ms after the loading screen appeared, which is no later than the 300 ms timer started.
    const releasedAfter = await page.evaluate(() => new Promise<number>(resolve => {
      const w = window as unknown as Hooks;
      setTimeout(() => { w.__release(); resolve(performance.now() - w.__loadingAt); }, Math.max(0, 120 - (performance.now() - w.__loadingAt)));
    }));
    expect(releasedAfter).toBeLessThan(200);
    expect(await ending(page)).toMatch(/^draft step/);
    const all = await frames(page);
    expect(all.filter(frame => frame.present).length, 'the empty region is painted while loading').toBeGreaterThan(0);
    expect(all.filter(frame => frame.text)).toEqual([]);
  }
});

test('a start that fails after the line appeared shows the error without the two meeting or moving', async ({ page }) => {
  const address = await draftAddress(page);
  await openHeld(page, address);
  await expect(page.getByRole('status').filter({ hasText: draftLine })).toHaveCount(1);
  await page.evaluate(() => (window as unknown as Hooks).__fail());
  await expect(page.getByRole('alert')).toBeVisible();
  await expect(page.getByText(draftLine)).toHaveCount(0);
  await page.waitForFunction(() => { const all = (window as unknown as Hooks).__frames; return all.length > 40 && !all.at(-1)!.text; });
  const withAlert = (await frames(page)).filter(frame => frame.alert);
  console.log(`error frames (line opacity, line box, error top): ${withAlert.slice(0, 14).map(frame => `${frame.opacity.toFixed(2)} ${frame.line ? `${Math.round(frame.line.top)}-${Math.round(frame.line.bottom)}` : '-'} ${Math.round(frame.alert!.top)}`).join(' | ')}`);
  const overlaps = withAlert.filter(frame => frame.line && frame.opacity > 0 && frame.line.bottom > frame.alert!.top && frame.line.top < frame.alert!.bottom);
  expect(overlaps, 'the leaving line and the error never share a box').toEqual([]);
  expect([...new Set(withAlert.map(frame => Math.round(frame.alert!.top)))], 'the error stays where it first painted').toHaveLength(1);
});
