import { test, expect, type Page } from '@playwright/test';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { footer, heading, toReview } from './stages.ts';

// Ticket 30: everything that appears or moves on the Report-ready screen travels there over frames.
// A move may not start, stop or change speed faster than 0.086 px/ms² (24 px of speed per 16.7 ms
// frame). A curve that starts from rest, such as sine in-out, stays far under it; an ease that starts
// at full speed (cubic out, 3 × distance / duration) breaks it for any move longer than about 96 px.
test.use({ serviceWorkers: 'block' });

const findings = await readFile(new URL('./computed-findings.json', import.meta.url), 'utf8');
const challenge = { algorithm: 'SHA-256', challenge: createHash('sha256').update('fixture0').digest('hex'), salt: 'fixture', signature: 'fixture-signature', maxnumber: 1 };
const MAX_ACCELERATION = 0.086;

type Server = { releaseUpload(): void; findings: 'pending' | 'computed' | 'unavailable' };
/** Holds the Report upload until released and answers Findings reads with whatever `findings` says. */
async function server(page: Page): Promise<Server> {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const state: Server = { releaseUpload: () => release(), findings: 'pending' };
  await page.route('**/api/**', async route => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/api/challenge') return route.fulfill({ json: challenge });
    if (path === '/api/reports' && route.request().method() === 'POST') {
      await gate;
      return route.fulfill({ status: 201, json: { id: route.request().postDataJSON().id } });
    }
    if (path.endsWith('/findings')) {
      if (state.findings === 'unavailable') return route.fulfill({ status: 503, json: {} });
      return route.fulfill({ contentType: 'application/json', body: state.findings === 'computed' ? findings : '{"status":"pending"}' });
    }
    return route.fulfill({ status: 503, json: {} });
  });
  return state;
}

/** From Sprawdź through the save, once the screen change has finished. */
async function saved(page: Page) {
  await page.context().setGeolocation({ latitude: 53.403481, longitude: 22.658699, accuracy: 8 });
  await page.goto('/');
  await toReview(page, 'Człowiek z bronią', false);
  await footer(page).getByRole('button', { name: 'Zapisz zgłoszenie' }).click();
  await expect(heading(page, 'Zgłoszenie')).toBeVisible();
  await page.waitForFunction(() => !document.documentElement.matches(':active-view-transition'));
}

type Sample = { t: number; y: Record<string, number | null>; o: Record<string, number | null>; text: string; exposed: number };
/**
 * Samples every rendered frame: each selector's top in the viewport (what is painted, so a scroll
 * counts as movement), its effective opacity, the status line's text, and how many of its texts
 * assistive technology can reach. Values are read after the frame renders, because a
 * ResizeObserver can still change layout after requestAnimationFrame and before paint. Returns
 * only once three frames are recorded, so the acceleration check also covers a move that starts
 * on the trigger's first frame. Stops `margin` frames after `done` first holds; if it never holds
 * within 6 s, collecting fails rather than passing on whatever was seen.
 */
async function sample(page: Page, selectors: string[], done: string, margin = 40) {
  await page.evaluate(({ selectors, done, margin }) => {
    const samples: unknown[] = [];
    const w = window as unknown as { motion: { samples: unknown[]; finished: boolean; held: boolean } };
    w.motion = { samples, finished: false, held: false };
    const condition = new Function(`return (${done})`) as () => boolean;
    const opacity = (el: Element) => { let o = 1; for (let n: Element | null = el; n; n = n.parentElement) o *= Number(getComputedStyle(n).opacity); return o; };
    let after = -1;
    const start = performance.now();
    const read = (t: number) => {
      const y: Record<string, number | null> = {}; const o: Record<string, number | null> = {};
      for (const selector of selectors) {
        const el = document.querySelector(selector);
        y[selector] = el ? el.getBoundingClientRect().top : null;
        o[selector] = el ? opacity(el) : null;
      }
      const line = document.querySelector('.report-status small .result-stack');
      samples.push({ t, y, o, text: document.querySelector('.report-status')?.textContent ?? '',
        exposed: line ? [...line.children].filter(child => !child.closest('[aria-hidden="true"]')).length : 0 });
      if (after < 0 && condition()) { after = 0; w.motion.held = true; }
      if (after >= 0) after++;
      if (after > margin || t - start > 6000) { w.motion.finished = true; return; }
      requestAnimationFrame(frame);
    };
    const frame = (t: number) => { setTimeout(() => read(t), 0); };
    requestAnimationFrame(frame);
  }, { selectors, done, margin });
  await page.waitForFunction(() => (window as unknown as { motion: { samples: unknown[] } }).motion.samples.length >= 3);
  return async () => {
    await page.waitForFunction(() => (window as unknown as { motion: { finished: boolean } }).motion.finished, undefined, { timeout: 10_000 });
    const { samples, held } = await page.evaluate(() => (window as unknown as { motion: { samples: Sample[]; held: boolean } }).motion);
    expect(held, `sampling ended before this held: ${done}`).toBe(true);
    return samples;
  };
}

/** Waits until nothing animates and every element of the screen has kept its place for 3 frames. */
async function quiet(page: Page) {
  await page.waitForFunction(() => new Promise<boolean>(resolve => {
    const rects = () => [...document.querySelectorAll('main *')].map(el => { const r = el.getBoundingClientRect(); return `${r.x},${r.y},${r.width},${r.height}`; }).join('|');
    let last = rects(); let still = 0;
    const frame = () => {
      const now = rects();
      still = now === last && document.getAnimations().length === 0 && !document.documentElement.matches(':active-view-transition') ? still + 1 : 0;
      last = now;
      if (still >= 3) resolve(true); else requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);
  }));
}

/** The largest speed change between frames, in px/ms², for one selector (frames where it exists). */
function acceleration(samples: Sample[], selector: string) {
  const points = samples.filter(sample => sample.y[selector] !== null);
  let worst = 0; let previous = 0;
  for (let i = 1; i < points.length; i++) {
    const dt = points[i].t - points[i - 1].t;
    if (dt <= 0) continue;
    const speed = (points[i].y[selector]! - points[i - 1].y[selector]!) / dt;
    if (i > 1) worst = Math.max(worst, Math.abs(speed - previous) / dt);
    previous = speed;
  }
  return worst;
}
/** Positions strictly between where a selector started and where it ended. */
function between(samples: Sample[], selector: string) {
  const ys = samples.map(sample => sample.y[selector]).filter((y): y is number => y !== null);
  const [from, to] = [ys[0], ys.at(-1)!];
  return new Set(ys.filter(y => Math.abs(y - from) > 0.5 && Math.abs(y - to) > 0.5).map(y => Math.round(y))).size;
}

test('saving crossfades from Sprawdź into the Report-ready screen', async ({ page }) => {
  await page.addInitScript(() => {
    const real = document.startViewTransition.bind(document);
    const log: { before?: string; after?: string; skipped: boolean; blend: number[] }[] = [];
    (window as unknown as { transitions: typeof log }).transitions = log;
    document.startViewTransition = ((update: () => unknown) => {
      const entry: (typeof log)[number] = { skipped: false, blend: [] };
      log.push(entry);
      const transition = real(async () => {
        entry.before = document.querySelector('main h1')?.textContent ?? undefined;
        await update();
        entry.after = document.querySelector('main h1')?.textContent ?? undefined;
      });
      const skip = transition.skipTransition.bind(transition);
      transition.skipTransition = () => { entry.skipped = true; skip(); };
      // How far the new screen had faded in on each frame of this transition.
      const frame = () => {
        if (!document.documentElement.matches(':active-view-transition') || entry.skipped) return;
        entry.blend.push(Number(getComputedStyle(document.documentElement, '::view-transition-new(root)').opacity));
        requestAnimationFrame(frame);
      };
      void transition.ready.then(() => requestAnimationFrame(frame), () => {});
      return transition;
    }) as typeof document.startViewTransition;
  });
  await server(page);
  await page.context().setGeolocation({ latitude: 53.403481, longitude: 22.658699, accuracy: 8 });
  await page.goto('/');
  await toReview(page, 'Człowiek z bronią', false);
  await page.evaluate(() => { (window as unknown as { transitions: unknown[] }).transitions.length = 0; });
  await footer(page).getByRole('button', { name: 'Zapisz zgłoszenie' }).click();
  await expect(heading(page, 'Zgłoszenie')).toBeVisible();
  await page.waitForFunction(() => !document.documentElement.matches(':active-view-transition'));
  await quiet(page);
  const log = await page.evaluate(() => (window as unknown as { transitions: { before?: string; after?: string; skipped: boolean; blend: number[] }[] }).transitions);
  // Exactly one transition changes the screen, from Sprawdź, and nothing skips it.
  const arrival = log.filter(entry => entry.after === 'Zgłoszenie' && entry.before !== 'Zgłoszenie');
  expect(arrival.map(({ before, after, skipped }) => ({ before, after, skipped }))).toEqual([{ before: 'Sprawdź i zapisz', after: 'Zgłoszenie', skipped: false }]);
  expect(log.every(entry => !entry.skipped)).toBe(true);
  // And it was painted as a blend: several frames with the Report part-way faded in.
  expect(arrival[0].blend.filter(value => value > 0.02 && value < 0.98).length).toBeGreaterThanOrEqual(3);
});

test('the sync result crossfades its lines and moves what sits below over frames', async ({ page }) => {
  const api = await server(page);
  await saved(page);
  const collect = await sample(page, ['.report-done', '.report-status .result-stack > *:nth-child(2)', '.findings-waiting .result-stack > *:nth-child(2)'],
    `(document.querySelector('.report-status')?.textContent ?? '').includes('Zapisano na serwerze.')`);
  api.releaseUpload();
  const samples = await collect();
  expect(samples.at(-1)!.text).toContain('Zapisano na serwerze.');
  // The waiting line drops from two lines to one, so the button below moves, smoothly and over frames.
  expect(between(samples, '.report-done')).toBeGreaterThanOrEqual(3);
  expect(acceleration(samples, '.report-done')).toBeLessThan(MAX_ACCELERATION);
  // Old and new text are both on screen for some frames: a crossfade, not a swap.
  expect(samples.some(sample => sample.y['.report-status .result-stack > *:nth-child(2)'] !== null)).toBe(true);
  expect(samples.some(sample => sample.y['.findings-waiting .result-stack > *:nth-child(2)'] !== null)).toBe(true);
});

test('arriving Findings grow from rest: nothing below jumps on the first frame', async ({ page }) => {
  const api = await server(page);
  await saved(page);
  api.releaseUpload();
  await expect(page.locator('.findings-waiting')).toContainText('Czekamy na pomiary.');
  await quiet(page);
  const collect = await sample(page, ['.report-done', 'details.disclosure', '.findings-result'],
    `!!document.querySelector('.findings-result') && !document.querySelector('.findings-waiting') && document.getAnimations().length === 0`, 10);
  api.findings = 'computed';
  const samples = await collect();
  expect(between(samples, '.report-done')).toBeGreaterThanOrEqual(8);
  expect(acceleration(samples, '.report-done')).toBeLessThan(MAX_ACCELERATION);
  expect(acceleration(samples, 'details.disclosure')).toBeLessThan(MAX_ACCELERATION);
  // The Findings themselves fade in from (nearly) nothing.
  const first = samples.find(sample => sample.o['.findings-result'] !== null && sample.o['.findings-result']! > 0);
  expect(first!.o['.findings-result']!).toBeLessThan(0.35);
});

test('Spróbuj teraz fades in under a failed Findings read', async ({ page }) => {
  const api = await server(page);
  await saved(page);
  api.releaseUpload();
  await expect(page.locator('.findings-waiting')).toContainText('Czekamy na pomiary.');
  const button = '.findings-waiting button';
  const collect = await sample(page, [button, '.report-done'], `!!document.querySelector('${button}') && document.getAnimations().length === 0`, 10);
  api.findings = 'unavailable';
  const samples = await collect();
  const seen = samples.filter(sample => sample.o[button] !== null && sample.o[button]! > 0);
  expect(seen.length).toBeGreaterThan(0);
  expect(seen[0].o[button]!).toBeLessThan(0.35);
  expect(seen.filter(sample => sample.o[button]! < 0.98).length).toBeGreaterThanOrEqual(3);
  expect(acceleration(samples, '.report-done')).toBeLessThan(MAX_ACCELERATION);
});

test('the withdrawal confirmation unfolds without the screen jumping', async ({ page }) => {
  const api = await server(page);
  await saved(page);
  api.releaseUpload();
  await expect(page.locator('.report-status')).toContainText('Zapisano na serwerze.');
  await page.locator('.withdrawal-action').scrollIntoViewIfNeeded();
  await quiet(page);
  const collect = await sample(page, ['.report-done', '.withdrawal-confirm', '.withdrawal-action'],
    `!!document.querySelector('.withdrawal-confirm') && document.getAnimations().length === 0`, 10);
  await page.locator('.withdrawal-action').click();
  const samples = await collect();
  for (const selector of ['.report-done', '.withdrawal-action']) {
    expect(acceleration(samples, selector), selector).toBeLessThan(MAX_ACCELERATION);
  }
  const first = samples.find(sample => sample.o['.withdrawal-confirm'] !== null && sample.o['.withdrawal-confirm']! > 0);
  expect(first!.o['.withdrawal-confirm']!).toBeLessThan(0.35);
});

test('Szczegóły zgłoszenia opens and shuts without what sits below jumping', async ({ page }) => {
  const api = await server(page);
  await saved(page);
  api.releaseUpload();
  await expect(page.locator('.report-status')).toContainText('Zapisano na serwerze.');
  await page.locator('details.disclosure > summary').scrollIntoViewIfNeeded();
  await quiet(page);
  for (const open of [true, false]) {
    const body = 'details.disclosure > .disclosure-body';
    const collect = await sample(page, ['.report-done', '.withdrawal-action', body],
      `document.querySelector('details.disclosure').open === ${open} && document.getAnimations().length === 0`, 10);
    await page.locator('details.disclosure > summary').click();
    const samples = await collect();
    expect(between(samples, '.report-done'), `open ${open}`).toBeGreaterThanOrEqual(4);
    expect(acceleration(samples, '.report-done'), `open ${open}`).toBeLessThan(MAX_ACCELERATION);
    // Opening, the details fade in: some frames are painted part-way, none starts near full opacity.
    if (open) {
      const fading = samples.map(sample => sample.o[body]).filter((o): o is number => o !== null && o > 0.02 && o < 0.98);
      expect(fading.length).toBeGreaterThanOrEqual(3);
      expect(fading[0]).toBeLessThan(0.35);
    }
  }
});

test('a retried upload changes the screen through its own transitions, never a whole-page crossfade', async ({ page }) => {
  // A whole-page crossfade freezes the old screen over the moving one, so moved content shows twice.
  await page.addInitScript(() => {
    const real = document.startViewTransition.bind(document);
    (window as unknown as { crossfades: number }).crossfades = 0;
    document.startViewTransition = ((update: () => unknown) => {
      (window as unknown as { crossfades: number }).crossfades++;
      return real(update as () => Promise<void>);
    }) as typeof document.startViewTransition;
  });
  let challengeFails = true;
  await page.route('**/api/**', async route => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/api/challenge') return challengeFails ? route.fulfill({ status: 503, json: {} }) : route.fulfill({ json: challenge });
    if (path === '/api/reports' && route.request().method() === 'POST') return route.fulfill({ status: 201, json: { id: route.request().postDataJSON().id } });
    if (path.endsWith('/findings')) return route.fulfill({ json: { status: 'pending' } });
    return route.fulfill({ status: 503, json: {} });
  });
  await saved(page);
  const retry = page.locator('.report-status').getByRole('button', { name: 'Spróbuj teraz' });
  await expect(retry).toBeVisible({ timeout: 15_000 });
  await quiet(page);
  const collect = await sample(page, ['.report-done'], `(document.querySelector('.report-status')?.textContent ?? '').includes('Zapisano na serwerze.') && document.getAnimations().length === 0`, 10);
  await page.evaluate(() => { (window as unknown as { crossfades: number }).crossfades = 0; });
  challengeFails = false;
  await retry.click();
  const samples = await collect();
  expect(samples.at(-1)!.text).toContain('Zapisano na serwerze.');
  expect(await page.evaluate(() => (window as unknown as { crossfades: number }).crossfades)).toBe(0);
  expect(acceleration(samples, '.report-done')).toBeLessThan(MAX_ACCELERATION);
});

test('while the status line crossfades, assistive technology only gets the new text', async ({ page }) => {
  // role=status is atomic: a stale line still in the accessibility tree would be read out with the new one.
  const api = await server(page);
  await saved(page);
  const collect = await sample(page, ['.report-status small'],
    `(document.querySelector('.report-status')?.textContent ?? '').trim() === 'Zapisano na serwerze.' && document.getAnimations().length === 0`, 10);
  api.releaseUpload();
  const samples = await collect();
  expect(samples.at(-1)!.text.trim()).toBe('Zapisano na serwerze.');
  expect(Math.max(...samples.map(sample => sample.exposed))).toBe(1);
  await expect(page.getByRole('list', { name: 'Stan zgłoszenia' }).getByRole('status')).toHaveText('Zapisano na serwerze.');
});

/** Rows of one IndexedDB store, read in the page. */
function storeRows(page: Page, store: string) {
  return page.evaluate(async store => {
    const db = await new Promise<IDBDatabase>(resolve => { const r = indexedDB.open('bor-czuwa'); r.onsuccess = () => resolve(r.result); });
    const rows = await new Promise<unknown[]>(resolve => { const q = db.transaction(store).objectStore(store).getAll(); q.onsuccess = () => resolve(q.result); });
    db.close();
    return rows;
  }, store);
}

test('a withdrawal from another tab crossfades the open Report into Moje zapisy, never cuts it', async ({ page, context }) => {
  await page.addInitScript(() => {
    const real = document.startViewTransition.bind(document);
    const log: { before?: string; after?: string; skipped: boolean; blend: number[] }[] = [];
    (window as unknown as { transitions: typeof log }).transitions = log;
    document.startViewTransition = ((update: () => unknown) => {
      const entry: (typeof log)[number] = { before: document.querySelector('main h1')?.textContent ?? undefined, skipped: false, blend: [] };
      log.push(entry);
      const transition = real(async () => { await update(); entry.after = document.querySelector('main h1')?.textContent ?? undefined; });
      const skip = transition.skipTransition.bind(transition);
      transition.skipTransition = () => { entry.skipped = true; skip(); };
      const frame = () => {
        if (!document.documentElement.matches(':active-view-transition') || entry.skipped) return;
        entry.blend.push(Number(getComputedStyle(document.documentElement, '::view-transition-new(root)').opacity));
        requestAnimationFrame(frame);
      };
      void transition.ready.then(() => requestAnimationFrame(frame), () => {});
      return transition;
    }) as typeof document.startViewTransition;
  });
  const api = await server(page);
  await saved(page);
  api.releaseUpload();
  await expect(page.locator('.report-status')).toContainText('Zapisano na serwerze.');
  await quiet(page);
  const id = new URL(page.url()).searchParams.get('report')!;
  await page.evaluate(() => {
    // Every rendered frame: is the Report, a transition, Moje zapisy, or nothing painted?
    const frames: string[] = []; (window as unknown as { painted: string[] }).painted = frames;
    (window as unknown as { transitions: unknown[] }).transitions.length = 0;
    const read = () => {
      const vt = document.documentElement.matches(':active-view-transition');
      const h1 = document.querySelector('main h1')?.textContent;
      frames.push(vt ? 'transition' : h1 === 'Zgłoszenie' && document.querySelector('.ref-strip') ? 'report' : h1 === 'Moje zapisy' ? 'library' : `other:${h1 ?? ''}`);
      if (frames.length < 400 && !(frames.at(-1) === 'library' && frames.at(-10) === 'library')) requestAnimationFrame(() => setTimeout(read, 0));
    };
    requestAnimationFrame(() => setTimeout(read, 0));
  });
  // Another tab of the app withdraws this Report: it leaves storage and tells the others.
  const other = await context.newPage();
  await other.route('**/api/**', route => route.fulfill({ status: 503, json: {} }));
  await other.goto('/');
  await other.evaluate(async id => {
    const db = await new Promise<IDBDatabase>(resolve => { const r = indexedDB.open('bor-czuwa'); r.onsuccess = () => resolve(r.result); });
    const tx = db.transaction('reports', 'readwrite'); tx.objectStore('reports').delete(id);
    await new Promise(resolve => { tx.oncomplete = resolve; }); db.close();
    new BroadcastChannel('bor-czuwa-withdrawal').postMessage(id);
  }, id);
  await expect(heading(page, 'Moje zapisy')).toBeVisible();
  await page.waitForFunction(() => { const f = (window as unknown as { painted: string[] }).painted; return f.at(-1) === 'library' && f.at(-10) === 'library'; });
  const painted = await page.evaluate(() => (window as unknown as { painted: string[] }).painted);
  const log = await page.evaluate(() => (window as unknown as { transitions: { before?: string; after?: string; skipped: boolean; blend: number[] }[] }).transitions);
  // Never a frame with neither the Report nor Moje zapisy nor a crossfade between them.
  expect(painted.filter(frame => frame.startsWith('other'))).toEqual([]);
  expect(log.map(({ before, after, skipped }) => ({ before, after, skipped }))).toEqual([{ before: 'Zgłoszenie', after: 'Moje zapisy', skipped: false }]);
  expect(log[0].blend.filter(value => value > 0.02 && value < 0.98).length).toBeGreaterThanOrEqual(3);
});

test('a save followed at once by another navigation still lets the saved Draft go', async ({ page }) => {
  await server(page);
  await page.context().setGeolocation({ latitude: 53.403481, longitude: 22.658699, accuracy: 8 });
  await page.goto('/');
  await toReview(page, 'Człowiek z bronią', false);
  await footer(page).getByRole('button', { name: 'Zapisz zgłoszenie' }).click();
  // Leave before the Report screen has settled: this display() supersedes the one the save started.
  await page.getByRole('button', { name: 'Moje zapisy' }).click();
  await expect(heading(page, 'Moje zapisy')).toBeVisible();
  await quiet(page);
  expect(await storeRows(page, 'drafts')).toEqual([]);
  expect(await storeRows(page, 'reports')).toHaveLength(1);
  await expect(page.getByRole('button', { name: /^Dokończ zgłoszenie/ })).toHaveCount(0);
  // Back returns past the Report to the saved Draft's steps, which lead home, never to an editable Draft.
  await page.goBack();
  await expect(heading(page, 'Sprawdź i zapisz')).toHaveCount(0);
});
