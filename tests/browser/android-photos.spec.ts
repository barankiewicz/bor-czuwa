import { test, expect } from '@playwright/test';
import { finishFromWhen, blankTiles } from './stages.ts';
import { android } from './native-notifications.ts';

test('Android gallery uses sampled native JPEG; an unreadable file keeps the Draft usable', async ({ page, context }) => {
  await context.setGeolocation({ latitude: 52.1, longitude: 21.1, accuracy: 8 });
  await android(context);
  await context.addInitScript(() => {
    const native = window as any;
    const original = native.Capacitor.nativePromise;
    native.photoDecode = { calls: 0, fails: true, jpeg: '' };
    native.Capacitor.PluginHeaders.push({ name: 'Photos', methods: [{ name: 'decode', rtype: 'promise' }] });
    native.Capacitor.nativePromise = async (plugin: string, method: string, options: { base64: string }) => {
      if (plugin !== 'Photos') return original(plugin, method, options);
      native.photoDecode.calls++;
      if (native.photoDecode.fails) throw new Error('image_decode_failed');
      return { base64: native.photoDecode.jpeg, width: 600, height: 1200 };
    };
    const create = window.createImageBitmap;
    window.createImageBitmap = ((source: ImageBitmapSource, ...args: any[]) => {
      if (source instanceof File) throw new Error('unbounded_file_decode');
      return (create as any)(source, ...args);
    }) as typeof create;
  });
  await page.route('**/api/challenge', route => route.fulfill({ status: 503, body: '{}' }));
  await blankTiles(page);
  await page.goto('/');
  await page.getByRole('button', { name: 'Szczątki w lesie', exact: true }).click();
  await finishFromWhen(page, false);
  await page.locator('input[type=file]').setInputFiles({ name: 'invalid.jpg', mimeType: 'image/jpeg', buffer: Buffer.from('invalid') });
  await expect(page.getByText('Nie udało się odczytać zdjęcia. Wybierz inny plik.')).toBeVisible();
  await expect(page.locator('.photo-tile')).toHaveCount(0);
  await page.evaluate(() => {
    const native = window as any;
    const canvas = document.createElement('canvas');
    canvas.width = 600; canvas.height = 1200;
    canvas.getContext('2d')!.fillRect(0, 0, 600, 1200);
    native.photoDecode.jpeg = canvas.toDataURL('image/jpeg', 0.8).split(',')[1];
    native.photoDecode.fails = false;
  });
  await page.evaluate(async () => {
    const canvas = document.createElement('canvas');
    canvas.width = 1500; canvas.height = 3000;
    canvas.getContext('2d')!.fillRect(0, 0, 1500, 3000);
    const jpeg = await new Promise<Blob>(resolve => canvas.toBlob(value => resolve(value!), 'image/jpeg', 0.8));
    const input = document.querySelector<HTMLInputElement>('input[type=file]')!;
    const files = new DataTransfer();
    files.items.add(new File([jpeg], 'large.jpg', { type: 'image/jpeg' }));
    input.files = files.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await expect(page.locator('.photo-tile')).toHaveCount(1);
  expect(await page.evaluate(() => (window as any).photoDecode.calls)).toBe(2);
  const size = await page.locator('.photo-tile img').evaluate(async (image: HTMLImageElement) => {
    await image.decode(); return [image.naturalWidth, image.naturalHeight];
  });
  expect(size).toEqual([600, 1200]);
  await page.reload();
  await expect(page.locator('.photo-tile')).toHaveCount(1);
  await expect(page.getByRole('heading', { name: 'Sprawdź i zapisz' })).toBeVisible();
});
