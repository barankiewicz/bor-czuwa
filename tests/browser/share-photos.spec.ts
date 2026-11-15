import { openNoticeRow, otherWays } from './stages.ts';
import { test, expect, type Page } from '@playwright/test';
import { finishFromWhen, stubReportServer } from './stages.ts';
import { readFile } from 'node:fs/promises';
import { demoRecipient, expectedRecipient, expectedSubject, expectDemoDestination } from './demo.ts';
import { android } from './native-notifications.ts';
import { z } from 'zod';

type NativeMailHarness = Window & {
  mailHandoff?: unknown;
  Capacitor: {
    PluginHeaders: { name: string; methods: { name: string; rtype: string }[] }[];
    nativePromise: (plugin: string, method: string, options: unknown) => Promise<unknown>;
  };
};

// No journey here reads server state, so uploads are answered in the page and spend no daily Reports.
test.beforeEach(async ({ page }) => { await stubReportServer(page); });

async function noticeWithPhoto(page: Page, photoCount = 1) {
  await page.goto('/');
  await page.getByRole('button', { name: 'Ranne zwierzę', exact: true }).click();
  await finishFromWhen(page, false);
  for (let index = 0; index < photoCount; index++) {
    await page.evaluate(async index => {
      const canvas = document.createElement('canvas');
      canvas.width = 20; canvas.height = 20;
      const context = canvas.getContext('2d')!;
      context.fillStyle = index ? 'red' : 'black';
      context.fillRect(0, 0, 20, 20);
      const blob = await new Promise<Blob>(resolve => canvas.toBlob(value => resolve(value!), 'image/png'));
      const input = document.querySelector<HTMLInputElement>('input[type=file]')!;
      const transfer = new DataTransfer();
      transfer.items.add(new File([blob], `original-${index}.png`, { type: 'image/png' }));
      input.files = transfer.files;
      input.dispatchEvent(new Event('change', { bubbles: true }));
    }, index);
    await expect(page.locator('.photo-tile')).toHaveCount(index + 1);
  }
  await page.getByRole('button', { name: 'Zapisz zgłoszenie' }).click();
  await page.getByRole('button', { name: 'Przygotuj powiadomienie' }).click();
  // This place falls outside the fixture's jurisdiction coverage.
  await expect(page.getByText('Nie znaleziono właściwych urzędów dla tego miejsca. Możesz wybrać je po nazwie.')).toBeVisible();
  await page.getByRole('button', { name: 'Wybierz jednostkę po nazwie', exact: true }).click();
  await page.getByLabel('Nazwa lub miejscowość').fill('Monkach');
  await page.getByRole('button', { name: /Komenda Powiatowa Policji w Mońkach/ }).click();
  await page.getByRole('button', { name: 'Dalej: podpis' }).click();
  await page.getByRole('radio', { name: 'Bez podpisu' }).check();
  await page.getByRole('button', { name: 'Przygotuj powiadomienia' }).click();
  await openNoticeRow(page);
  await otherWays(page);
}

test('supported browser shares re-encoded local JPEG with Notice text and keeps mail fallback', async ({ page, context }) => {
  await context.setGeolocation({ latitude: 52.1, longitude: 21.1, accuracy: 8 });
  await context.grantPermissions(['geolocation', 'clipboard-read', 'clipboard-write']);
  await page.addInitScript(() => {
    const state = window as typeof window & { shared?: { names: string[]; types: string[]; bytes: number[][]; title?: string; text?: string } };
    Object.defineProperty(navigator, 'canShare', { configurable: true, value: (data: ShareData) => !!data.files?.length });
    Object.defineProperty(navigator, 'share', { configurable: true, value: async (data: ShareData) => {
      state.shared = { names: data.files!.map(file => file.name), types: data.files!.map(file => file.type),
        bytes: await Promise.all(data.files!.map(async file => Array.from(new Uint8Array(await file.arrayBuffer())))),
        title: data.title, text: data.text };
    } });
  });
  await noticeWithPhoto(page, 2);
  await expect(page.getByRole('button', { name: 'Udostępnij zdjęcia' })).toBeVisible();
  await page.getByRole('button', { name: 'Udostępnij zdjęcia' }).click();
  await expect.poll(() => page.evaluate(() => !!(window as typeof window & { shared?: unknown }).shared)).toBe(true);
  const shared = await page.evaluate(() => (window as typeof window & { shared: { names: string[]; types: string[]; bytes: number[][]; title: string; text: string } }).shared);
  expect(shared.names).toEqual(demoRecipient ? ['test-zgloszenie-1.jpg', 'test-zgloszenie-2.jpg'] : ['zgloszenie-1.jpg', 'zgloszenie-2.jpg']);
  expect(shared.types).toEqual(['image/jpeg', 'image/jpeg']);
  for (const bytes of shared.bytes) expect(bytes.slice(0, 2)).toEqual([255, 216]);
  expect(shared.bytes[0]).not.toEqual(shared.bytes[1]);
  expect(shared.title).toBe(expectedSubject('Informacja o zdarzeniu łowieckim'));
  expect(shared.text).toContain('W załączeniu 2 zdjęcia.');
  expectDemoDestination(shared.text, ['komendant.kpp@monki.bk.policja.gov.pl']);
  await expect(page.getByRole('link', { name: 'Otwórz w poczcie' })).toHaveAttribute('href', /^mailto:/);
  const mail = new URL((await page.getByRole('link', { name: 'Otwórz w poczcie' }).getAttribute('href'))!);
  expect(decodeURIComponent(mail.pathname)).toBe(expectedRecipient('komendant.kpp@monki.bk.policja.gov.pl'));
  await expect(page.getByRole('button', { name: 'Kopiuj adres' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Kopiuj temat' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Pobierz zdjęcie 1' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Pobierz zdjęcie 2' })).toBeVisible();
  await expect(page.locator('main .badge')).toHaveCount(0);
});

test('cancelled and failed shares retain Notice, fallback and no handoff event', async ({ page, context }) => {
  await context.setGeolocation({ latitude: 52.1, longitude: 21.1, accuracy: 8 });
  await page.addInitScript(() => {
    const state = window as typeof window & { shareError?: string };
    Object.defineProperty(navigator, 'canShare', { configurable: true, value: () => true });
    Object.defineProperty(navigator, 'share', { configurable: true, value: async () => {
      throw new DOMException('Share failed', state.shareError ?? 'AbortError');
    } });
  });
  await noticeWithPhoto(page);
  const share = page.getByRole('button', { name: 'Udostępnij zdjęcia' });
  await share.click();
  await expect(page.locator('main .badge')).toHaveCount(0);
  await expect(page.getByRole('link', { name: 'Otwórz w poczcie' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Pobierz zdjęcie 1' })).toBeVisible();
  await page.evaluate(() => (window as typeof window & { shareError?: string }).shareError = 'NotAllowedError');
  await share.click();
  await expect(page.getByRole('alert')).toContainText('Nie udało się udostępnić zdjęć');
  await expect(share).toBeEnabled();
  await expect(page.locator('main .badge')).toHaveCount(0);
  await page.reload();
  await page.getByRole('button', { name: 'Moje zapisy' }).click();
  await page.getByRole('button', { name: /^Ranne zwierzę, / }).click();
  await page.getByRole('button', { name: /Powiadomienia do urzędów/ }).click();
  await openNoticeRow(page);
  await otherWays(page);
  await expect(page.getByRole('button', { name: 'Udostępnij zdjęcia' })).toBeVisible();
  await expect(page.locator('main .badge')).toHaveCount(0);
});

test('unsupported browser offers photo download, copy and mailto', async ({ page, context }) => {
  await context.setGeolocation({ latitude: 52.1, longitude: 21.1, accuracy: 8 });
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'userAgent', { configurable: true, get: () => 'Android' });
    Object.defineProperty(navigator, 'canShare', { configurable: true, value: () => false });
  });
  await noticeWithPhoto(page);
  await expect(page.getByRole('button', { name: 'Udostępnij zdjęcia' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Pobierz zdjęcie 1' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Kopiuj adres' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Kopiuj temat' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Otwórz w poczcie' })).toHaveAttribute('href', /^mailto:/);
  await expect(page.locator('.notice-body')).toContainText('Mam 1 zdjęcie i mogę je przekazać na prośbę.');
  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Pobierz zdjęcie 1' }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe(demoRecipient ? 'test-zgloszenie-1.jpg' : 'zgloszenie-1.jpg');
  expect((await readFile(await download.path())).subarray(0, 2)).toEqual(Buffer.from([255, 216]));
});

test('native mail handoff keeps the selected authority but enforces the configured destination', async ({ page, context }) => {
  await context.setGeolocation({ latitude: 52.1, longitude: 21.1, accuracy: 8 });
  await android(context);
  await context.addInitScript(() => {
    // The preceding Android harness installs this bridge before application modules load.
    const native = window as unknown as NativeMailHarness;
    const original = native.Capacitor.nativePromise;
    native.Capacitor.PluginHeaders.push({ name: 'NoticeMail', methods: [
      { name: 'open', rtype: 'promise' }, { name: 'clear', rtype: 'promise' }
    ] });
    native.Capacitor.nativePromise = async (plugin: string, method: string, options: unknown) => {
      if (plugin !== 'NoticeMail') return original(plugin, method, options);
      if (method === 'open') native.mailHandoff = options;
      return {};
    };
  });
  await page.goto('/');
  await page.getByRole('button', { name: 'Człowiek z bronią', exact: true }).click();
  await finishFromWhen(page, false);
  await page.locator('summary', { hasText: 'Notatka' }).click();
  await page.getByLabel('Co jeszcze chcesz przekazać?').fill('Fikcyjny kontakt: komendant.kpp@monki.bk.policja.gov.pl');
  await page.getByRole('button', { name: 'Zapisz zgłoszenie' }).click();
  await page.getByRole('button', { name: 'Przygotuj powiadomienie' }).click();
  await page.getByRole('button', { name: 'Wybierz jednostkę po nazwie', exact: true }).click();
  await page.getByLabel('Nazwa lub miejscowość').fill('Monkach');
  await page.getByRole('button', { name: /Komenda Powiatowa Policji w Mońkach/ }).click();
  await page.getByRole('button', { name: 'Dalej: podpis' }).click();
  await page.getByRole('radio', { name: 'Bez podpisu' }).check();
  await page.getByRole('button', { name: 'Przygotuj powiadomienia' }).click();
  await openNoticeRow(page);
  await page.getByRole('button', { name: 'Otwórz w poczcie' }).click();
  await expect.poll(() => page.evaluate(() => !!(window as unknown as NativeMailHarness).mailHandoff)).toBe(true);
  const mail = z.object({ address: z.string(), subject: z.string(), body: z.string(), photos: z.array(z.string()) })
    .parse(await page.evaluate(() => (window as unknown as NativeMailHarness).mailHandoff));
  expect(mail.address).toBe(expectedRecipient('komendant.kpp@monki.bk.policja.gov.pl'));
  expect(mail.subject).toBe(expectedSubject('Informacja o zdarzeniu łowieckim'));
  expect(mail.photos).toEqual([]);
  expectDemoDestination(mail.body, ['komendant.kpp@monki.bk.policja.gov.pl']);
  if (!demoRecipient) expect(mail.body).toContain('komendant.kpp@monki.bk.policja.gov.pl');
  await expect(page.getByRole('heading', { name: 'Komenda Powiatowa Policji w Mońkach' })).toBeVisible();
});
