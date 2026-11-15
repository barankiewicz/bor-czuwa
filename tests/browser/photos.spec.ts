import { test, expect } from '@playwright/test';
import { answerNow, finishFromWhen, heading, leaveCompass, reportPost, settled } from './stages.ts';
import { writeFile } from 'node:fs/promises';

test.use({ serviceWorkers: 'block' });

test('local photo and note survive reload; sync sends only hash and note flag', async ({ page, context }, testInfo) => {
  await context.setGeolocation({ latitude: 52.1, longitude: 21.1, accuracy: 8 });
  await page.addInitScript(() => {
    const original = window.createImageBitmap;
    const state = window as typeof window & { galleryDecodes?: { options: ImageBitmapOptions; size: number[] }[] };
    state.galleryDecodes = [];
    Object.defineProperty(window, 'createImageBitmap', { configurable: true,
      value: async (source: ImageBitmapSource, options: ImageBitmapOptions) => {
        const bitmap = await original(source, options);
        if (source instanceof File) state.galleryDecodes!.push({ options, size: [bitmap.width, bitmap.height] });
        return bitmap;
      } });
  });
  const posts: Record<string, unknown>[] = [];
  page.on('request', request => {
    if (request.method() === 'POST' && request.url().endsWith('/api/reports')) posts.push(request.postDataJSON());
  });
  await page.goto('/');
  await page.getByRole('button', { name: 'Szczątki w lesie', exact: true }).click();
  await expect(heading(page, 'Kiedy to się stało?')).toBeVisible();
  await page.getByRole('button', { name: 'Dokończę później' }).click();
  await page.getByRole('button', { name: /^Dokończ zgłoszenie/ }).click();
  await finishFromWhen(page, false);
  await page.locator('summary', { hasText: 'Notatka' }).click();
  await page.getByLabel('Co jeszcze chcesz przekazać?').fill('Ślady przy drodze.');
  await page.evaluate(() => {
    const state = window as typeof window & { photoFrames?: { scale: number; opacity: number }[] };
    state.photoFrames = [];
    const observer = new MutationObserver(() => {
      const tile = document.querySelector('.photo-tile');
      if (!tile) return;
      observer.disconnect();
      const sample = () => {
        const style = getComputedStyle(tile);
        state.photoFrames!.push({ scale: Number(style.transform.match(/matrix\(([^,]+)/)?.[1] ?? 1), opacity: Number(style.opacity) });
        if (state.photoFrames!.length < 18) requestAnimationFrame(sample);
      };
      requestAnimationFrame(sample);
    });
    observer.observe(document.body, { childList: true, subtree: true });
  });
  await page.evaluate(async () => {
    const canvas = document.createElement('canvas');
    canvas.width = 3000; canvas.height = 1500;
    const ctx = canvas.getContext('2d')!;
    ctx.fillStyle = 'red'; ctx.fillRect(0, 0, 3000, 1500);
    const blob = await new Promise<Blob>(resolve => canvas.toBlob(value => resolve(value!), 'image/jpeg')!);
    const raw = new Uint8Array(await blob.arrayBuffer());
    const exif = new Uint8Array([69, 120, 105, 102, 0, 0, 73, 73, 42, 0, 8, 0, 0, 0,
      1, 0, 18, 1, 3, 0, 1, 0, 0, 0, 6, 0, 0, 0, 0, 0, 0, 0]);
    const secret = new TextEncoder().encode('camera-model-secret');
    const segment = new Uint8Array([255, 225, 0, exif.length + 2, ...exif,
      255, 226, 0, secret.length + 2, ...secret]);
    const tagged = new Uint8Array(raw.length + segment.length);
    tagged.set(raw.subarray(0, 2)); tagged.set(segment, 2); tagged.set(raw.subarray(2), 2 + segment.length);
    const input = document.querySelector<HTMLInputElement>('input[type=file]')!;
    const transfer = new DataTransfer();
    transfer.items.add(new File([tagged], 'tagged.jpg', { type: 'image/jpeg' }));
    input.files = transfer.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await expect(page.locator('.photo-tile')).toHaveCount(1);
  const decodes = await page.evaluate(() => (window as typeof window & {
    galleryDecodes: { options: ImageBitmapOptions; size: number[] }[] }).galleryDecodes);
  expect(decodes).toHaveLength(1);
  expect(Math.max(...decodes[0].size)).toBeLessThanOrEqual(2048);
  expect(decodes[0].size[1] / decodes[0].size[0]).toBe(2);
  expect(decodes[0].options.imageOrientation).toBe('from-image');
  await expect(page.locator('.photo-tile')).toHaveCSS('animation-name', 'photo-arrive');
  await expect.poll(() => page.evaluate(() => (window as typeof window & { photoFrames?: unknown[] }).photoFrames?.length)).toBe(18);
  const frames = await page.evaluate(() => (window as typeof window & { photoFrames: { scale: number; opacity: number }[] }).photoFrames);
  expect(frames[0].scale).toBeLessThan(1);
  expect(frames[0].opacity).toBeLessThan(1);
  expect(frames.at(-1)!.scale).toBe(1);
  await page.reload();
  await expect(heading(page, 'Sprawdź i zapisz')).toBeVisible();
  await expect(page.locator('.photo-tile')).toHaveCount(1);
  await expect(page.getByLabel('Co jeszcze chcesz przekazać?')).toHaveValue('Ślady przy drodze.');
  const stored = await page.evaluate(async () => {
    const request = indexedDB.open('bor-czuwa');
    const db = await new Promise<IDBDatabase>(resolve => { request.onsuccess = () => resolve(request.result); });
    const transaction = db.transaction('drafts');
    const record = await new Promise<{ photos: { jpeg: Blob; sha256: string }[] }>(resolve => {
      const query = transaction.objectStore('drafts').getAll();
      query.onsuccess = () => resolve(query.result[0]);
    });
    const photo = record.photos[0];
    const bytes = new Uint8Array(await photo.jpeg.arrayBuffer());
    db.close();
    return { bytes: Array.from(bytes), hash: photo.sha256 };
  });
  await writeFile(testInfo.outputPath('photo.jpg'), Buffer.from(stored.bytes));
  const image = await page.evaluate(async bytes => {
    const bitmap = await createImageBitmap(new Blob([new Uint8Array(bytes)], { type: 'image/jpeg' }));
    const size = [bitmap.width, bitmap.height]; bitmap.close(); return size;
  }, stored.bytes);
  expect(image).toEqual([1024, 2048]);
  expect(Buffer.from(stored.bytes).includes(Buffer.from('camera-model-secret'))).toBe(false);
  const upload = await reportPost(page);
  await page.getByRole('button', { name: 'Zapisz zgłoszenie' }).click();
  await upload.request;
  await expect(page.getByRole('heading', { name: 'Zgłoszenie', exact: true })).toBeVisible();
  await expect.poll(() => posts.length).toBe(1);
  expect(posts[0].photo_sha256).toEqual([stored.hash]);
  expect(posts[0].has_note).toBe(true);
  expect(JSON.stringify(posts[0])).not.toContain('Ślady przy drodze');
  expect(JSON.stringify(posts[0])).not.toContain('camera-model-secret');
});

test('camera requests silent video only and adds photo without native shutter', async ({ page, context }) => {
  await context.setGeolocation({ latitude: 52.1, longitude: 21.1, accuracy: 8 });
  await page.addInitScript(() => {
    const state = window as typeof window & { cameraCalls?: MediaStreamConstraints[]; vibrations?: number };
    state.cameraCalls = []; state.vibrations = 0;
    Object.defineProperty(navigator, 'vibrate', { configurable: true, value: () => { state.vibrations!++; return true; } });
    Object.defineProperty(navigator.mediaDevices, 'getUserMedia', { configurable: true, value: async (constraints: MediaStreamConstraints) => {
      state.cameraCalls!.push(constraints);
      const canvas = document.createElement('canvas');
      canvas.width = 320; canvas.height = 240;
      const stream = canvas.captureStream(30);
      const context = canvas.getContext('2d')!;
      setInterval(() => context.fillRect(0, 0, 320, 240), 33);
      return stream;
    } });
  });
  await page.goto('/');
  expect(await page.evaluate(() => typeof navigator.mediaDevices.getUserMedia)).toBe('function');
  await page.getByRole('button', { name: 'Ranne zwierzę', exact: true }).click();
  await finishFromWhen(page, false);
  await page.locator('summary', { hasText: 'Zdjęcia' }).click();
  await page.getByRole('button', { name: 'Zrób zdjęcie' }).click();
  await expect(page.locator('video')).toBeVisible();
  await expect(page.locator('.camera-active')).toHaveCSS('background-color', 'rgb(9, 11, 9)');
  await expect(page.locator('video')).toHaveJSProperty('videoWidth', 320);
  await page.getByRole('button', { name: 'Zrób zdjęcie' }).click();
  await expect(page.locator('.photo-tile')).toHaveCount(1);
  const state = await page.evaluate(() => ({
    calls: (window as typeof window & { cameraCalls: MediaStreamConstraints[] }).cameraCalls,
    vibrations: (window as typeof window & { vibrations: number }).vibrations
  }));
  expect(state.calls).toHaveLength(1);
  expect(state.calls[0].audio).toBe(false);
  const requested = state.calls[0].video as MediaTrackConstraints;
  expect(requested.facingMode).toBe('environment');
  expect((requested.width as ConstrainULongRange).ideal).toBeGreaterThanOrEqual(1920);
  expect((requested.height as ConstrainULongRange).ideal).toBeGreaterThanOrEqual(1080);
  expect(await page.locator('.photo-tile img').evaluate(async (image: HTMLImageElement) => {
    await image.decode(); return [image.naturalWidth, image.naturalHeight];
  })).toEqual([320, 240]);
  expect(state.vibrations).toBe(0);
});

test('denied camera leaves remains as a recoverable Draft; shot has no photo field', async ({ page, context }) => {
  await context.setGeolocation({ latitude: 52.1, longitude: 21.1, accuracy: 8 });
  await page.addInitScript(() => {
    Object.defineProperty(navigator.mediaDevices, 'getUserMedia', { configurable: true,
      value: async () => { throw new DOMException('Permission denied', 'NotAllowedError'); } });
  });
  await page.goto('/');
  await page.getByRole('button', { name: 'Strzał', exact: true }).click();
  await answerNow(page);
  await leaveCompass(page);
  await expect(page.getByText('Zdjęcia', { exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Bór czuwa' }).click();
  await page.getByRole('button', { name: 'Szczątki w lesie', exact: true }).click();
  await answerNow(page);
  await page.getByRole('button', { name: 'Zrób zdjęcie' }).click();
  await expect(page.getByRole('alert')).toContainText('Brak dostępu do aparatu');
  await expect(page.getByRole('button', { name: /^Dokończ zgłoszenie/ })).toHaveCount(1);
  await page.getByRole('button', { name: 'Moje zapisy', exact: true }).click();
  await expect(page.getByRole('button', { name: /^Dokończ zgłoszenie/ })).toHaveCount(2);
  await page.reload();
  await expect(page.getByRole('button', { name: /^Dokończ zgłoszenie/ })).toHaveCount(2);
});

test('slow photo decoding cannot attach to another Draft', async ({ page, context }) => {
  await context.setGeolocation({ latitude: 52.1, longitude: 21.1, accuracy: 8 });
  await page.addInitScript(() => {
    const original = createImageBitmap;
    const state = window as typeof window & { decoding?: boolean };
    Object.defineProperty(window, 'createImageBitmap', { configurable: true, value: async (...args: Parameters<typeof createImageBitmap>) => {
      state.decoding = true;
      await new Promise<void>(resolve => window.addEventListener('release-photo', () => resolve(), { once: true }));
      return original(...args);
    } });
  });
  await page.goto('/');
  await page.getByRole('button', { name: 'Ranne zwierzę', exact: true }).click();
  await finishFromWhen(page, false);
  await expect(page.locator('input[type=file]')).toBeAttached();
  await page.evaluate(async () => {
    const canvas = document.createElement('canvas');
    canvas.width = 10; canvas.height = 10;
    const blob = await new Promise<Blob>(resolve => canvas.toBlob(value => resolve(value!), 'image/png'));
    const input = document.querySelector<HTMLInputElement>('input[type=file]')!;
    const transfer = new DataTransfer();
    transfer.items.add(new File([blob], 'photo.png', { type: 'image/png' }));
    input.files = transfer.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await expect.poll(() => page.evaluate(() => (window as typeof window & { decoding?: boolean }).decoding)).toBe(true);
  await page.getByRole('button', { name: 'Bór czuwa' }).click();
  await page.getByRole('button', { name: 'Kłusownictwo', exact: true }).click();
  await finishFromWhen(page, false);
  await page.evaluate(() => window.dispatchEvent(new Event('release-photo')));
  await expect(page.locator('.photo-tile')).toHaveCount(0);
  await page.getByRole('button', { name: 'Bór czuwa' }).click();
  await page.getByRole('button', { name: /^Dokończ zgłoszenie/ }).first().click();
  await expect(page.locator('.photo-tile')).toHaveCount(0);
});

test('old photo encoding cannot stop a newly opened camera', async ({ page, context }) => {
  await context.setGeolocation({ latitude: 52.1, longitude: 21.1, accuracy: 8 });
  await page.addInitScript(() => {
    const state = window as typeof window & { encoding?: boolean; releaseEncode?: () => void };
    Object.defineProperty(navigator.mediaDevices, 'getUserMedia', { configurable: true, value: async () => {
      const canvas = document.createElement('canvas');
      canvas.width = 320; canvas.height = 240;
      const stream = canvas.captureStream(30);
      setInterval(() => canvas.getContext('2d')!.fillRect(0, 0, 320, 240), 33);
      return stream;
    } });
    const original = HTMLCanvasElement.prototype.toBlob;
    let first = true;
    HTMLCanvasElement.prototype.toBlob = function (callback, type, quality) {
      if (first) {
        first = false;
        state.encoding = true;
        state.releaseEncode = () => original.call(this, callback, type, quality);
      } else original.call(this, callback, type, quality);
    };
  });
  await page.goto('/');
  await page.getByRole('button', { name: 'Ranne zwierzę', exact: true }).click();
  await finishFromWhen(page, false);
  await page.locator('summary', { hasText: 'Zdjęcia' }).click();
  await page.getByRole('button', { name: 'Zrób zdjęcie' }).click();
  await expect(page.locator('video')).toHaveJSProperty('videoWidth', 320);
  await page.getByRole('button', { name: 'Zrób zdjęcie' }).click();
  await expect.poll(() => page.evaluate(() => (window as typeof window & { encoding?: boolean }).encoding)).toBe(true);
  await page.getByRole('button', { name: 'Bór czuwa' }).click();
  await page.getByRole('button', { name: 'Kłusownictwo', exact: true }).click();
  await finishFromWhen(page, false);
  await page.locator('summary', { hasText: 'Zdjęcia' }).click();
  await page.getByRole('button', { name: 'Zrób zdjęcie' }).click();
  await expect(page.locator('video')).toHaveJSProperty('videoWidth', 320);
  await page.evaluate(() => (window as typeof window & { releaseEncode: () => void }).releaseEncode());
  await expect(page.locator('video')).toBeVisible();
  expect(await page.locator('video').evaluate(video => {
    const stream = (video as HTMLVideoElement).srcObject;
    return stream instanceof MediaStream && stream.getVideoTracks()[0].readyState === 'live';
  })).toBe(true);
});

test('web rejection happens before decode and preserves prior photo, Draft and next import', async ({ page, context }, testInfo) => {
  await context.setGeolocation({ latitude: 52.1, longitude: 21.1, accuracy: 8 });
  await page.addInitScript(() => {
    const original = window.createImageBitmap;
    const state = window as typeof window & { fileDecodes: number; imageConstructs: number };
    state.fileDecodes = 0;
    state.imageConstructs = 0;
    const OriginalImage = window.Image;
    window.Image = class extends OriginalImage {
      constructor(width?: number, height?: number) {
        super(width, height);
        state.imageConstructs++;
      }
    };
    Object.defineProperty(window, 'createImageBitmap', { configurable: true,
      value: async (source: ImageBitmapSource, options?: ImageBitmapOptions) => {
        if (source instanceof File) state.fileDecodes++;
        return original(source, options);
      } });
  });
  await page.goto('/');
  await page.getByRole('button', { name: 'Szczątki w lesie', exact: true }).click();
  await finishFromWhen(page, false);
  const validPng = Buffer.from(await page.evaluate(async () => {
    const canvas = document.createElement('canvas');
    canvas.width = 300; canvas.height = 200;
    canvas.getContext('2d')!.fillRect(0, 0, 300, 200);
    const blob = await new Promise<Blob>(resolve => canvas.toBlob(value => resolve(value!), 'image/png'));
    return Array.from(new Uint8Array(await blob.arrayBuffer()));
  }));
  const input = page.locator('input[type=file]');
  await input.setInputFiles({ name: 'valid.png', mimeType: 'image/png', buffer: validPng });
  await expect(page.locator('.photo-tile')).toHaveCount(1);
  expect(await page.evaluate(() => {
    const state = window as typeof window & { fileDecodes: number; imageConstructs: number };
    return { fileDecodes: state.fileDecodes, imageConstructs: state.imageConstructs };
  })).toEqual({ fileDecodes: 1, imageConstructs: 0 });
  await page.reload();
  await expect(page.locator('.photo-tile')).toHaveCount(1);
  const before = await page.evaluate(async () => {
    const request = indexedDB.open('bor-czuwa');
    const db = await new Promise<IDBDatabase>(resolve => { request.onsuccess = () => resolve(request.result); });
    const query = db.transaction('drafts').objectStore('drafts').getAll();
    const drafts = await new Promise<{ id: string; photos?: { sha256: string }[] }[]>(resolve => {
      query.onsuccess = () => resolve(query.result);
    });
    db.close();
    return drafts.map(draft => ({ id: draft.id, hashes: draft.photos?.map(photo => photo.sha256) }));
  });
  const oversized = Buffer.from(validPng);
  oversized.writeUInt32BE(20000, 16);
  const rejectedFiles = [
    { name: 'oversized.png', mimeType: 'image/png', buffer: oversized },
    { name: 'invalid.jpg', mimeType: 'image/jpeg', buffer: Buffer.from('not a photo') },
    { name: 'vector.svg', mimeType: 'image/svg+xml', buffer: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>') }
  ];
  for (const [index, file] of rejectedFiles.entries()) {
    await settled(page);
    await input.focus();
    const outerScroll = await page.evaluate(() => ({ x: scrollX, y: scrollY }));
    await input.setInputFiles(file);
    const feedback = page.locator('.photo-controls').getByRole('alert');
    await expect(feedback).toHaveText('Nie udało się odczytać zdjęcia. Wybierz inny plik.');
    await settled(page);
    // The alert travels into the pane; wait until it is inside and has not moved for 600 ms.
    await page.waitForFunction(() => {
      const state = window as typeof window & { rest?: { top: number; at: number } };
      const r = document.getElementById('gallery-import-feedback')!.getBoundingClientRect(), p = document.querySelector('.screen-body')!.getBoundingClientRect();
      const now = performance.now();
      if (!state.rest || Math.abs(state.rest.top - r.top) > 0.5) state.rest = { top: r.top, at: now };
      return now - state.rest.at > 600 && r.top >= p.top && r.bottom <= p.bottom;
    }, undefined, { polling: 'raf' });
    await expect(input).toBeFocused();
    await expect(input).toHaveAttribute('aria-describedby', 'gallery-import-feedback');
    const framing = await feedback.evaluate(element => {
      const r = element.getBoundingClientRect(), pane = document.querySelector('.screen-body')!, p = pane.getBoundingClientRect();
      return { errorTop: r.top, errorBottom: r.bottom, paneTop: p.top, paneBottom: p.bottom,
        scrollTop: pane.scrollTop, transitionActive: document.documentElement.matches(':active-view-transition'),
        fullyWithinPane: r.top >= p.top && r.bottom <= p.bottom };
    });
    await testInfo.attach(`gallery-rejection-${index}-framing`, { contentType: 'application/json', body: JSON.stringify(framing) });
    expect(framing.fullyWithinPane).toBe(true);
    expect(await page.evaluate(() => ({ x: scrollX, y: scrollY }))).toEqual(outerScroll);
    await expect(page.locator('.photo-tile')).toHaveCount(1);
    expect(await page.evaluate(() => {
      const state = window as typeof window & { fileDecodes: number; imageConstructs: number };
      return { fileDecodes: state.fileDecodes, imageConstructs: state.imageConstructs };
    })).toEqual({ fileDecodes: 0, imageConstructs: 0 });
    if (index < rejectedFiles.length - 1) {
      await page.reload();
      await expect(page.locator('.photo-tile')).toHaveCount(1);
      await expect(page.locator('#gallery-import-feedback')).toHaveCount(0);
    }
  }
  expect(await page.evaluate(async () => {
    const request = indexedDB.open('bor-czuwa');
    const db = await new Promise<IDBDatabase>(resolve => { request.onsuccess = () => resolve(request.result); });
    const query = db.transaction('drafts').objectStore('drafts').getAll();
    const drafts = await new Promise<{ id: string; photos?: { sha256: string }[] }[]>(resolve => {
      query.onsuccess = () => resolve(query.result);
    });
    db.close();
    return drafts.map(draft => ({ id: draft.id, hashes: draft.photos?.map(photo => photo.sha256) }));
  })).toEqual(before);
  await page.locator('input[type=file]').setInputFiles({ name: 'valid.png', mimeType: 'image/png', buffer: validPng });
  await expect(page.locator('#gallery-import-feedback')).toHaveCount(0);
  await expect(page.locator('.photo-tile')).toHaveCount(2);
  await page.reload();
  await expect(page.locator('.photo-tile')).toHaveCount(2);
});


test('camera-denial feedback stays with the same Draft and clears after gallery recovery', async ({ page, context }, testInfo) => {
  await context.setGeolocation({ latitude: 52.1, longitude: 21.1, accuracy: 8 });
  await page.addInitScript(() => {
    Object.defineProperty(navigator.mediaDevices, 'getUserMedia', { configurable: true,
      value: async () => { throw new DOMException('Permission denied', 'NotAllowedError'); } });
  });
  await page.goto('/');
  await page.getByRole('button', { name: 'Szczątki w lesie', exact: true }).click();
  await finishFromWhen(page, false);
  await page.locator('summary', { hasText: 'Notatka' }).click();
  await page.getByLabel('Co jeszcze chcesz przekazać?').fill('Fikcyjna notatka pozostaje na urządzeniu.');
  const image = Buffer.from(await page.evaluate(async () => {
    const canvas = document.createElement('canvas'); canvas.width = 30; canvas.height = 20;
    canvas.getContext('2d')!.fillRect(0, 0, 30, 20);
    const blob = await new Promise<Blob>(resolve => canvas.toBlob(value => resolve(value!), 'image/png'));
    return Array.from(new Uint8Array(await blob.arrayBuffer()));
  }));
  await page.locator('input[type=file]').setInputFiles({ name: 'prior.png', mimeType: 'image/png', buffer: image });
  await expect(page.locator('.photo-tile')).toHaveCount(1);
  const snapshot = () => page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>(resolve => {
      const request = indexedDB.open('bor-czuwa'); request.onsuccess = () => resolve(request.result);
    });
    const query = db.transaction('drafts').objectStore('drafts').getAll();
    const records = await new Promise<Record<string, unknown>[]>(resolve => { query.onsuccess = () => resolve(query.result); });
    db.close();
    return records.map(record => ({ id: record.id, capturedAt: record.capturedAt, fix: record.fix,
      eventType: record.eventType, occurredMode: record.occurredMode, fromHome: record.fromHome,
      note: record.note, photos: (record.photos as { id: string; sha256: string }[]).map(photo => ({ id: photo.id, sha256: photo.sha256 })) }));
  });
  const before = await snapshot();
  const draftId = new URL(page.url()).searchParams.get('draft');
  await page.getByRole('button', { name: 'Zrób zdjęcie', exact: true }).click();
  await expect(heading(page, 'Co się stało?')).toBeVisible();
  await settled(page);
  await page.screenshot({ path: testInfo.outputPath('settled-camera-denial.png') });
  const feedback = 'Brak dostępu do aparatu. Szkic jest zapisany. Możesz wybrać zdjęcie z urządzenia albo dokończyć później.';
  await expect(page.locator('.continuation').getByRole('alert')).toHaveText(feedback);
  await expect(page.locator('.continuation').getByRole('button')).toBeFocused();
  expect(await snapshot()).toEqual(before);
  await page.getByRole('button', { name: /^Dokończ zgłoszenie szczątków w lesie/ }).click();
  await expect(heading(page, 'Sprawdź i zapisz')).toBeVisible();
  expect(new URL(page.url()).searchParams.get('draft')).toBe(draftId);
  await expect(page.locator('.photo-controls').getByRole('alert')).toHaveText(feedback);
  await expect(page.getByLabel('Co jeszcze chcesz przekazać?')).toHaveValue('Fikcyjna notatka pozostaje na urządzeniu.');
  const gallery = page.locator('input[type=file]');
  await gallery.focus();
  await gallery.setInputFiles({ name: 'rejected.jpg', mimeType: 'image/jpeg', buffer: Buffer.from('not a photo') });
  await expect(page.locator('.photo-controls').getByRole('alert')).toHaveText('Nie udało się odczytać zdjęcia. Wybierz inny plik.');
  await expect(page.locator('#camera-denial-feedback')).toHaveCount(0);
  await expect(gallery).toBeFocused();
  expect(await snapshot()).toEqual(before);
  await page.locator('input[type=file]').setInputFiles({ name: 'retry.png', mimeType: 'image/png', buffer: image });
  await expect(page.locator('.photo-tile')).toHaveCount(2);
  await expect(page.getByRole('alert').filter({ hasText: feedback })).toHaveCount(0);
  await expect(page.locator('#gallery-import-feedback')).toHaveCount(0);
  const recovered = await snapshot();
  expect(recovered[0]).toEqual({ ...before[0], photos: expect.arrayContaining(before[0].photos) });
  expect(recovered[0].photos).toHaveLength(2);
  await page.getByRole('button', { name: 'Bór czuwa' }).click();
  await expect(heading(page, 'Co się stało?')).toBeVisible();
  await expect(page.getByRole('alert').filter({ hasText: feedback })).toHaveCount(0);
  await page.getByRole('button', { name: 'Strzał', exact: true }).click();
  await expect(heading(page, 'Kiedy to się stało?')).toBeVisible();
  await expect(page.getByRole('alert').filter({ hasText: feedback })).toHaveCount(0);
});

test('camera-denial continuation names its older Draft and restores latest work after leaving', async ({ page, context }) => {
  await context.setGeolocation({ latitude: 52.1, longitude: 21.1, accuracy: 8 });
  await page.addInitScript(() => {
    Object.defineProperty(navigator.mediaDevices, 'getUserMedia', { configurable: true,
      value: async () => { throw new DOMException('Permission denied', 'NotAllowedError'); } });
  });
  await page.goto('/');
  await page.getByRole('button', { name: 'Szczątki w lesie', exact: true }).click();
  await finishFromWhen(page, false);
  const deniedId = new URL(page.url()).searchParams.get('draft');
  await page.getByRole('button', { name: 'Bór czuwa' }).click();
  await page.getByRole('button', { name: 'Strzał', exact: true }).click();
  await expect(heading(page, 'Kiedy to się stało?')).toBeVisible();
  await page.getByRole('button', { name: 'Moje zapisy', exact: true }).click();
  await page.getByRole('button', { name: /^Dokończ zgłoszenie szczątków w lesie/ }).click();
  await expect(heading(page, 'Sprawdź i zapisz')).toBeVisible();
  await page.getByRole('button', { name: 'Zrób zdjęcie', exact: true }).click();
  await expect(heading(page, 'Co się stało?')).toBeVisible();
  await settled(page);
  await expect(page.locator('.continuation').getByRole('button')).toHaveAccessibleName(/^Dokończ zgłoszenie szczątków w lesie/);
  await expect(page.locator('.continuation').getByRole('alert')).toContainText('Brak dostępu do aparatu');
  await page.locator('.continuation').getByRole('button').click();
  expect(new URL(page.url()).searchParams.get('draft')).toBe(deniedId);
  await expect(page.locator('.photo-controls').getByRole('alert')).toContainText('Brak dostępu do aparatu');
  await page.getByRole('button', { name: 'Menu', exact: true }).click();
  await expect(heading(page, 'Menu')).toBeVisible();
  await expect(page.getByRole('alert').filter({ hasText: 'Brak dostępu do aparatu' })).toHaveCount(0);
  await page.getByRole('button', { name: 'Bór czuwa' }).click();
  await expect(heading(page, 'Co się stało?')).toBeVisible();
  await expect(page.locator('.continuation').getByRole('button')).toHaveAccessibleName(/^Dokończ zgłoszenie strzału/);
  await expect(heading(page, 'Co się stało?')).toBeFocused();
  await expect(page.getByRole('alert').filter({ hasText: 'Brak dostępu do aparatu' })).toHaveCount(0);
});

test('gallery feedback clears on another Draft and ignores a late rejected import after success', async ({ page, context }) => {
  await context.setGeolocation({ latitude: 52.1, longitude: 21.1, accuracy: 8 });
  await page.addInitScript(() => {
    const original = window.createImageBitmap.bind(window);
    Object.defineProperty(window, 'createImageBitmap', { configurable: true,
      value: (source: ImageBitmapSource, options?: ImageBitmapOptions) => {
        if (source instanceof File && source.name === 'late.png') return new Promise<ImageBitmap>((_resolve, reject) => {
          (window as typeof window & { rejectLatePhoto?: () => void }).rejectLatePhoto = () => reject(new Error('Controlled late decoder failure'));
        });
        return original(source, options);
      } });
  });
  await page.goto('/');
  await page.getByRole('button', { name: 'Szczątki w lesie', exact: true }).click();
  await finishFromWhen(page, false);
  const firstId = new URL(page.url()).searchParams.get('draft');
  const gallery = page.locator('input[type=file]');
  await gallery.focus();
  await gallery.setInputFiles({ name: 'invalid.jpg', mimeType: 'image/jpeg', buffer: Buffer.from('not a photo') });
  const message = 'Nie udało się odczytać zdjęcia. Wybierz inny plik.';
  await expect(page.locator('.photo-controls').getByRole('alert')).toHaveText(message);
  await expect(gallery).toBeFocused();
  await page.getByRole('button', { name: 'Bór czuwa', exact: true }).click();
  await expect(heading(page, 'Co się stało?')).toBeVisible();
  await expect(page.getByRole('alert').filter({ hasText: message })).toHaveCount(0);
  await page.getByRole('button', { name: 'Szczątki w lesie', exact: true }).click();
  await finishFromWhen(page, false);
  const secondId = new URL(page.url()).searchParams.get('draft');
  expect(secondId).not.toBe(firstId);
  await expect(page.getByRole('alert').filter({ hasText: message })).toHaveCount(0);
  const image = Buffer.from(await page.evaluate(async () => {
    const canvas = document.createElement('canvas'); canvas.width = 30; canvas.height = 20;
    canvas.getContext('2d')!.fillRect(0, 0, 30, 20);
    const blob = await new Promise<Blob>(resolve => canvas.toBlob(value => resolve(value!), 'image/png'));
    return Array.from(new Uint8Array(await blob.arrayBuffer()));
  }));
  await gallery.setInputFiles({ name: 'late.png', mimeType: 'image/png', buffer: image });
  await page.waitForFunction(() => typeof (window as typeof window & { rejectLatePhoto?: () => void }).rejectLatePhoto === 'function');
  await gallery.setInputFiles({ name: 'valid.png', mimeType: 'image/png', buffer: image });
  await expect(page.locator('.photo-tile')).toHaveCount(1);
  await page.evaluate(async () => {
    (window as typeof window & { rejectLatePhoto: () => void }).rejectLatePhoto();
    await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
  });
  await expect(page.getByRole('alert').filter({ hasText: message })).toHaveCount(0);
  const retained = await page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>(resolve => {
      const request = indexedDB.open('bor-czuwa'); request.onsuccess = () => resolve(request.result);
    });
    const tx = db.transaction(['drafts', 'reports']);
    const drafts = tx.objectStore('drafts').getAll(), reports = tx.objectStore('reports').getAll();
    await new Promise<void>(resolve => { tx.oncomplete = () => resolve(); });
    db.close();
    return { drafts: (drafts.result as { id: string; photos?: unknown[] }[]).map(draft => ({ id: draft.id, photos: draft.photos?.length ?? 0 })), reports: reports.result.length };
  });
  expect(retained.reports).toBe(0);
  expect(retained.drafts).toEqual(expect.arrayContaining([{ id: firstId, photos: 0 }, { id: secondId, photos: 1 }]));
  expect(retained.drafts).toHaveLength(2);
});
