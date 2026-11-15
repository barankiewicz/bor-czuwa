import { test, expect, type BrowserContext, type Page } from '@playwright/test';
import { finishFromWhen, settled } from './stages.ts';

test.use({ serviceWorkers: 'block' });

type Sample = { t: number; height: number; opacity: number; top: number; scroll: number; open: boolean };

/** How far the pane scrolled on every frame; the scroll that reveals it must travel, not jump. */
function travel(frames: Sample[]) {
  const tops = frames.map(frame => frame.scroll);
  const steps = tops.slice(1).map((top, index) => top - tops[index]);
  const moving = steps.map((step, index) => ({ step, index })).filter(({ step }) => Math.abs(step) > 0.5);
  return { total: tops[tops.length - 1] - tops[0], frames: moving.length, first: moving.length ? Math.abs(moving[0].step) : 0,
    largest: Math.max(0, ...steps.map(Math.abs)) };
}

/** Samples the alert's rect every frame, starting three frames before `trigger`, until it stops moving for 600 ms. */
async function recordReveal(page: Page, trigger: () => Promise<void>) {
  await page.evaluate(() => {
    const state = window as typeof window & { samples: Sample[]; sampling: boolean };
    state.samples = []; state.sampling = true;
    const details = document.querySelector('details.disclosure') as HTMLDetailsElement;
    const pane = document.querySelector('.screen-body')!;
    const effectiveOpacity = (element: Element | null) => {
      let value = 1;
      for (; element; element = element.parentElement) value *= Number(getComputedStyle(element).opacity);
      return value;
    };
    const tick = (now: number) => {
      const alert = document.getElementById('gallery-import-feedback');
      const rect = alert?.getBoundingClientRect();
      state.samples.push({ t: now, height: details.getBoundingClientRect().height, opacity: alert ? effectiveOpacity(alert) : 0,
        top: rect ? rect.top - pane.getBoundingClientRect().top : -1, scroll: pane.scrollTop, open: details.open });
      if (state.sampling) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))));
  await trigger();
  await expect(page.locator('.photo-controls').getByRole('alert')).toBeVisible();
  // Condition, not a sleep: the alert is inside the pane and has not moved for 600 ms.
  await page.waitForFunction(() => {
    const state = window as typeof window & { samples: Sample[]; since?: { top: number; at: number } };
    const last = state.samples[state.samples.length - 1];
    if (!last || last.top === -1) return false;
    if (!state.since || Math.abs(state.since.top - last.top) > 0.5) state.since = { top: last.top, at: last.t };
    const pane = document.querySelector('.screen-body')!.getBoundingClientRect();
    const alert = document.getElementById('gallery-import-feedback')!.getBoundingClientRect();
    return last.t - state.since.at > 600 && alert.top >= pane.top && alert.bottom <= pane.bottom;
  }, undefined, { polling: 'raf' });
  return page.evaluate(() => {
    const state = window as typeof window & { samples: Sample[]; sampling: boolean };
    state.sampling = false;
    return state.samples;
  });
}

// A decode that is still running when the Reporter closes and reopens Photos fails while the
// section is reopening. The pane is shorter then, so the alert must still end up in view.
test('gallery rejection that lands while Photos is still opening is revealed in the pane', async ({ page, context }) => {
  await context.setGeolocation({ latitude: 52.1, longitude: 21.1, accuracy: 8 });
  await page.addInitScript(() => {
    const original = window.createImageBitmap.bind(window);
    Object.defineProperty(window, 'createImageBitmap', { configurable: true,
      value: (source: ImageBitmapSource, options?: ImageBitmapOptions) => {
        if (source instanceof File && source.name === 'slow.png') return new Promise<ImageBitmap>((_resolve, reject) => {
          (window as typeof window & { failSlowPhoto?: () => void }).failSlowPhoto = () => reject(new Error('Controlled decoder failure'));
        });
        return original(source, options);
      } });
  });
  await page.goto('/');
  await page.getByRole('button', { name: 'Kłusownictwo', exact: true }).click();
  await finishFromWhen(page, false);
  const summary = page.locator('details.disclosure > summary', { hasText: 'Zdjęcia' });
  await summary.click();
  const input = page.locator('input[type=file]');
  await expect(input).toBeVisible();
  await settled(page);
  const image = Buffer.from(await page.evaluate(async () => {
    const canvas = document.createElement('canvas'); canvas.width = 30; canvas.height = 20;
    canvas.getContext('2d')!.fillRect(0, 0, 30, 20);
    const blob = await new Promise<Blob>(resolve => canvas.toBlob(value => resolve(value!), 'image/png'));
    return Array.from(new Uint8Array(await blob.arrayBuffer()));
  }));
  await input.setInputFiles({ name: 'slow.png', mimeType: 'image/png', buffer: image });
  await page.waitForFunction(() => typeof (window as typeof window & { failSlowPhoto?: () => void }).failSlowPhoto === 'function');
  // Close, wait for it to shut, reopen, and fail the decode in the same task as the reopening tap.
  await summary.click();
  await page.waitForFunction(() => !document.querySelector('details.disclosure input[type=file]')?.checkVisibility());
  await page.waitForFunction(() => document.getAnimations().length === 0);
  await summary.evaluate(element => {
    (element as HTMLElement).click();
    (window as typeof window & { failSlowPhoto: () => void }).failSlowPhoto();
  });
  const alert = page.locator('.photo-controls').getByRole('alert');
  await expect(alert).toHaveText('Nie udało się odczytać zdjęcia. Wybierz inny plik.');
  // The alert travels into the pane; wait for it to be inside and not moving.
  await page.waitForFunction(() => {
    const state = window as typeof window & { rest?: { top: number; at: number } };
    const r = document.getElementById('gallery-import-feedback')!.getBoundingClientRect(), p = document.querySelector('.screen-body')!.getBoundingClientRect();
    const now = performance.now();
    if (!state.rest || Math.abs(state.rest.top - r.top) > 0.5) state.rest = { top: r.top, at: now };
    return now - state.rest.at > 600 && r.top >= p.top && r.bottom <= p.bottom;
  }, undefined, { polling: 'raf' });
});

// Waiting for animations must not hold the alert back: something long-running elsewhere on the
// page cannot keep the Reporter from seeing that the import failed.
test('gallery rejection is revealed within 3 s although another animation runs for 30 s', async ({ page, context }) => {
  await context.setGeolocation({ latitude: 52.1, longitude: 21.1, accuracy: 8 });
  await page.goto('/');
  await page.getByRole('button', { name: 'Kłusownictwo', exact: true }).click();
  await finishFromWhen(page, false);
  await page.locator('details.disclosure > summary', { hasText: 'Zdjęcia' }).click();
  const input = page.locator('input[type=file]');
  await expect(input).toBeVisible();
  await settled(page);
  await page.waitForFunction(() => document.getAnimations().every(animation => animation.playState !== 'running'));
  await page.evaluate(() => { document.querySelector('.screen-foot')!.animate({ opacity: [1, 0.99] }, 30000); });
  await input.setInputFiles({ name: 'invalid.jpg', mimeType: 'image/jpeg', buffer: Buffer.from('not a photo') });
  const alert = page.locator('.photo-controls').getByRole('alert');
  await expect(alert).toBeVisible();
  // The alert starts outside the pane, so arriving is the scroll's doing and only the cap lets it start.
  expect(await alert.evaluate(element => {
    const r = element.getBoundingClientRect(), p = document.querySelector('.screen-body')!.getBoundingClientRect();
    return r.bottom <= p.bottom;
  })).toBe(false);
  await expect.poll(() => alert.evaluate(element => {
    const r = element.getBoundingClientRect(), p = document.querySelector('.screen-body')!.getBoundingClientRect();
    return r.top >= p.top && r.bottom <= p.bottom;
  }), { intervals: [50], timeout: 3000 }).toBe(true);
});

// Rejection after the Reporter shut Photos: the section opens with its usual motion and the alert
// is in view, without moving keyboard focus.
test('gallery rejection that lands while Photos is shut opens it smoothly and shows the alert', async ({ page, context }, testInfo) => {
  await context.setGeolocation({ latitude: 52.1, longitude: 21.1, accuracy: 8 });
  await page.addInitScript(() => {
    const original = window.createImageBitmap.bind(window);
    Object.defineProperty(window, 'createImageBitmap', { configurable: true,
      value: (source: ImageBitmapSource, options?: ImageBitmapOptions) => {
        if (source instanceof File && source.name === 'slow.png') return new Promise<ImageBitmap>((_resolve, reject) => {
          (window as typeof window & { failSlowPhoto?: () => void }).failSlowPhoto = () => reject(new Error('Controlled decoder failure'));
        });
        return original(source, options);
      } });
  });
  await page.goto('/');
  await page.getByRole('button', { name: 'Kłusownictwo', exact: true }).click();
  await finishFromWhen(page, false);
  const summary = page.locator('details.disclosure > summary', { hasText: 'Zdjęcia' });
  await summary.click();
  const input = page.locator('input[type=file]');
  await expect(input).toBeVisible();
  await settled(page);
  const image = Buffer.from(await page.evaluate(async () => {
    const canvas = document.createElement('canvas'); canvas.width = 30; canvas.height = 20;
    canvas.getContext('2d')!.fillRect(0, 0, 30, 20);
    const blob = await new Promise<Blob>(resolve => canvas.toBlob(value => resolve(value!), 'image/png'));
    return Array.from(new Uint8Array(await blob.arrayBuffer()));
  }));
  await input.setInputFiles({ name: 'slow.png', mimeType: 'image/png', buffer: image });
  await page.waitForFunction(() => typeof (window as typeof window & { failSlowPhoto?: () => void }).failSlowPhoto === 'function');
  await summary.click();
  await page.waitForFunction(() => !document.querySelector('details.disclosure input[type=file]')?.checkVisibility());
  await page.waitForFunction(() => document.getAnimations().length === 0);
  await summary.focus();
  const frames = await recordReveal(page, () => page.evaluate(() => (window as typeof window & { failSlowPhoto: () => void }).failSlowPhoto()));
  const alert = page.locator('.photo-controls').getByRole('alert');
  await expect(alert).toBeVisible();
  await expect(summary).toBeFocused();
  const geometry = await alert.evaluate(element => {
    const r = element.getBoundingClientRect(), p = document.querySelector('.screen-body')!.getBoundingClientRect();
    return r.top >= p.top && r.bottom <= p.bottom;
  });
  expect(geometry).toBe(true);
  await testInfo.attach('opening-frames', { contentType: 'application/json', body: JSON.stringify(frames.map(frame => ({ ...frame, t: Math.round(frame.t) }))) });
  const heights = frames.map(frame => frame.height), opacities = frames.map(frame => frame.opacity);
  const total = Math.max(...heights) - heights[0];
  const steps = (values: number[]) => values.slice(1).map((value, index) => Math.abs(value - values[index]));
  expect(total).toBeGreaterThan(40);
  expect(Math.max(...steps(heights))).toBeLessThan(total * 0.4);
  expect(Math.max(...steps(opacities))).toBeLessThan(0.5);
  expectSmoothTravel(travel(frames));
});

// The Reporter's page scrolls to the alert with a short, eased travel, never in one frame.
function expectSmoothTravel(move: ReturnType<typeof travel>) {
  expect(move.total).toBeGreaterThan(40);
  expect(move.first).toBeLessThan(12);
  expect(move.largest).toBeLessThan(30);
  expect(move.frames).toBeGreaterThanOrEqual(8);
}

test('gallery rejection with Photos open scrolls the alert into view over several frames', async ({ page, context }, testInfo) => {
  await context.setGeolocation({ latitude: 52.1, longitude: 21.1, accuracy: 8 });
  await page.goto('/');
  await page.getByRole('button', { name: 'Kłusownictwo', exact: true }).click();
  await finishFromWhen(page, false);
  await page.locator('details.disclosure > summary', { hasText: 'Zdjęcia' }).click();
  const input = page.locator('input[type=file]');
  await expect(input).toBeVisible();
  await settled(page);
  await page.waitForFunction(() => document.getAnimations().every(animation => animation.playState !== 'running'));
  await input.evaluate(element => { (element as HTMLInputElement).focus({ preventScroll: true }); document.querySelector('.screen-body')!.scrollTop = 0; });
  const frames = await recordReveal(page, () => input.setInputFiles({ name: 'invalid.jpg', mimeType: 'image/jpeg', buffer: Buffer.from('not a photo') }));
  await testInfo.attach('travel-frames', { contentType: 'application/json', body: JSON.stringify(frames.map(frame => ({ ...frame, t: Math.round(frame.t) }))) });
  await expect(input).toBeFocused();
  expectSmoothTravel(travel(frames));
});

async function openPhotosAndRest(page: Page, context: BrowserContext) {
  await context.setGeolocation({ latitude: 52.1, longitude: 21.1, accuracy: 8 });
  await page.goto('/');
  await page.getByRole('button', { name: 'Kłusownictwo', exact: true }).click();
  await finishFromWhen(page, false);
  await page.locator('details.disclosure > summary', { hasText: 'Zdjęcia' }).click();
  const input = page.locator('input[type=file]');
  await expect(input).toBeVisible();
  await settled(page);
  await page.waitForFunction(() => document.getAnimations().every(animation => animation.playState !== 'running'));
  await page.evaluate(() => { document.querySelector('.screen-body')!.scrollTop = 0; });
  return input;
}
const invalid = { name: 'invalid.jpg', mimeType: 'image/jpeg', buffer: Buffer.from('not a photo') };
const pane = (page: Page) => page.evaluate(() => document.querySelector('.screen-body')!.scrollTop);
const alertInPane = (page: Page) => page.evaluate(() => {
  const r = document.getElementById('gallery-import-feedback')!.getBoundingClientRect(), p = document.querySelector('.screen-body')!.getBoundingClientRect();
  return r.top >= p.top && r.bottom <= p.bottom;
});
const restedFor600ms = (page: Page) => page.waitForFunction(() => {
  const state = window as typeof window & { rest?: { top: number; at: number } };
  const top = document.querySelector('.screen-body')!.scrollTop, now = performance.now();
  if (!state.rest || Math.abs(state.rest.top - top) > 0.5) state.rest = { top, at: now };
  return now - state.rest.at > 600;
}, undefined, { polling: 'raf' });

// What the Reporter does mid-travel is theirs: the pane is not pulled back to the alert.
for (const action of ['wheel', 'key', 'pointer'] as const) {
  test(`a Reporter who uses the ${action} during the travel is not pulled back to the alert`, async ({ page, context }) => {
    const input = await openPhotosAndRest(page, context);
    const box = (await page.locator('.screen-body').boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await input.evaluate(element => (element as HTMLInputElement).focus({ preventScroll: true }));
    await input.setInputFiles(invalid);
    await page.waitForFunction(() => document.querySelector('.screen-body')!.scrollTop > 20, undefined, { polling: 'raf' });
    if (action === 'wheel') await page.mouse.wheel(0, -2000);
    if (action === 'key') await page.keyboard.press('Home');
    if (action === 'pointer') { await page.mouse.down(); await page.mouse.up(); }
    await restedFor600ms(page);
    // Wheel and Home go to the top; a click leaves the pane where it was. None goes on to the alert.
    expect(await alertInPane(page)).toBe(false);
  });
}

test.describe('touch', () => {
  test.use({ hasTouch: true });
  test('a Reporter who touches the pane during the travel is not pulled back to the alert', async ({ page, context }) => {
    const input = await openPhotosAndRest(page, context);
    const box = (await page.locator('.screen-body').boundingBox())!;
    await input.setInputFiles(invalid);
    await page.waitForFunction(() => document.querySelector('.screen-body')!.scrollTop > 20, undefined, { polling: 'raf' });
    // The pane's right padding holds no control, so the tap itself changes nothing.
    await page.touchscreen.tap(box.x + box.width - 6, box.y + box.height / 2);
    await restedFor600ms(page);
    expect(await alertInPane(page)).toBe(false);
  });
});

// A rejection followed at once by shutting Photos leaves nothing to reveal: the pane stays where it is.
test('shutting Photos during the wait does not move the pane', async ({ page, context }) => {
  await context.setGeolocation({ latitude: 52.1, longitude: 21.1, accuracy: 8 });
  await page.setViewportSize({ width: 390, height: 440 });
  await page.addInitScript(() => {
    const original = window.createImageBitmap.bind(window);
    Object.defineProperty(window, 'createImageBitmap', { configurable: true,
      value: (source: ImageBitmapSource, options?: ImageBitmapOptions) => {
        if (source instanceof File && source.name === 'slow.png') return new Promise<ImageBitmap>((_resolve, reject) => {
          (window as typeof window & { failSlowPhoto?: () => void }).failSlowPhoto = () => reject(new Error('Controlled decoder failure'));
        });
        return original(source, options);
      } });
  });
  await page.goto('/');
  await page.getByRole('button', { name: 'Kłusownictwo', exact: true }).click();
  await finishFromWhen(page, false);
  const summary = page.locator('details.disclosure > summary', { hasText: 'Zdjęcia' });
  await summary.click();
  const input = page.locator('input[type=file]');
  await expect(input).toBeVisible();
  await settled(page);
  const image = Buffer.from(await page.evaluate(async () => {
    const canvas = document.createElement('canvas'); canvas.width = 30; canvas.height = 20;
    canvas.getContext('2d')!.fillRect(0, 0, 30, 20);
    const blob = await new Promise<Blob>(resolve => canvas.toBlob(value => resolve(value!), 'image/png'));
    return Array.from(new Uint8Array(await blob.arrayBuffer()));
  }));
  await input.setInputFiles({ name: 'slow.png', mimeType: 'image/png', buffer: image });
  await page.waitForFunction(() => typeof (window as typeof window & { failSlowPhoto?: () => void }).failSlowPhoto === 'function');
  await summary.click();
  await page.waitForFunction(() => !document.querySelector('details.disclosure input[type=file]')?.checkVisibility());
  await page.waitForFunction(() => document.getAnimations().length === 0);
  const before = await page.evaluate(() => {
    const body = document.querySelector('.screen-body')!;
    body.scrollTop = 0;
    return body.scrollTop;
  });
  // The shut section sits below the visible pane, where a reveal of its hidden alert would pull the pane to.
  expect(await page.evaluate(() => document.querySelector('details.disclosure')!.getBoundingClientRect().top > document.querySelector('.screen-body')!.getBoundingClientRect().bottom)).toBe(true);
  // Fail the decode, and shut Photos again on the frame its opening starts.
  await page.evaluate(() => new Promise<void>(resolve => {
    const details = document.querySelector('details.disclosure') as HTMLDetailsElement;
    (window as typeof window & { failSlowPhoto: () => void }).failSlowPhoto();
    const wait = () => { if (details.open) { (details.querySelector(':scope > summary') as HTMLElement).click(); resolve(); } else requestAnimationFrame(wait); };
    wait();
  }));
  await page.waitForFunction(() => document.getAnimations().every(animation => animation.playState !== 'running'));
  await restedFor600ms(page);
  expect(await pane(page)).toBe(before);
});

// Layout that keeps growing above the alert while the pane travels cannot leave it off target.
test('the travel follows the alert while layout above it grows', async ({ page, context }) => {
  const input = await openPhotosAndRest(page, context);
  await input.setInputFiles(invalid);
  await page.waitForFunction(() => document.querySelector('.screen-body')!.scrollTop > 20, undefined, { polling: 'raf' });
  await page.evaluate(() => {
    const spacer = document.createElement('div');
    spacer.style.height = '240px';
    document.querySelector('details.disclosure')!.before(spacer);
  });
  await restedFor600ms(page);
  expect(await alertInPane(page)).toBe(true);
});

// Where the travel ends is where an instant scrollIntoView ends: same scroll padding, same margin, and the
// top of an alert taller than the pane.
for (const [name, viewport, text] of [['phone', { width: 390, height: 844 }, false], ['alert taller than the pane', { width: 320, height: 360 }, true]] as const) {
  test(`the travel ends where the instant scroll does: ${name}`, async ({ page, context }) => {
    await page.setViewportSize(viewport);
    const input = await openPhotosAndRest(page, context);
    if (text) await page.evaluate(() => { document.documentElement.style.fontSize = '250%'; });
    const ends: number[] = [];
    for (const reducedMotion of ['reduce', 'no-preference'] as const) {
      await page.emulateMedia({ reducedMotion });
      await page.evaluate(() => { document.querySelector('.screen-body')!.scrollTop = 0; });
      await input.setInputFiles(invalid);
      await expect(page.locator('#gallery-import-feedback')).toBeVisible();
      await restedFor600ms(page);
      await page.waitForFunction(() => document.getAnimations().every(animation => animation.playState !== 'running'));
      ends.push(await pane(page));
    }
    if (text) expect(await page.evaluate(() => document.getElementById('gallery-import-feedback')!.getBoundingClientRect().height > document.querySelector('.screen-body')!.clientHeight)).toBe(true);
    expect(ends[0]).toBeGreaterThan(40);
    expect(Math.abs(ends[1] - ends[0])).toBeLessThanOrEqual(1);
  });
}


test.describe('reduced motion', () => {
  test.use({ reducedMotion: 'reduce' });
  test('gallery rejection scrolls the alert into view at once', async ({ page, context }) => {
    await context.setGeolocation({ latitude: 52.1, longitude: 21.1, accuracy: 8 });
    await page.goto('/');
    await page.getByRole('button', { name: 'Kłusownictwo', exact: true }).click();
    await finishFromWhen(page, false);
    await page.locator('details.disclosure > summary', { hasText: 'Zdjęcia' }).click();
    const input = page.locator('input[type=file]');
    await expect(input).toBeVisible();
    await settled(page);
    const frames = await recordReveal(page, () => input.setInputFiles({ name: 'invalid.jpg', mimeType: 'image/jpeg', buffer: Buffer.from('not a photo') }));
    const move = travel(frames);
    expect(move.total).toBeGreaterThan(40);
    expect(move.frames).toBeLessThanOrEqual(2);
  });
});
