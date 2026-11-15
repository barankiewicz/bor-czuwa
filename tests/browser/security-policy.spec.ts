import { expect, test } from '@playwright/test';

test('proxy sends security headers on documents, assets and errors', async ({ request }) => {
  for (const path of ['/', '/legal/privacy/v1/', '/service-worker.js',
    '/_app/immutable/missing.js', '/missing', '/api/health',
    '/api/geodata/example/ambony']) {
    const response = await request.get(path);
    const headers = response.headers();
    expect(headers['content-security-policy'], path).toContain("frame-ancestors 'none'");
    expect(headers['content-security-policy'], path).toContain("object-src 'none'");
    expect(headers['content-security-policy'], path).not.toContain("script-src 'unsafe-inline'");
    expect(headers['x-frame-options'], path).toBe('DENY');
    expect(headers['x-content-type-options'], path).toBe('nosniff');
    expect(headers['permissions-policy'], path).toBe('camera=(self), geolocation=(self)');
    expect(headers.server, path).toBe('nginx');
    expect(headers['referrer-policy'], path).toBe('no-referrer');
    expect(headers['strict-transport-security'], path).toBeUndefined();
    if (path === '/') {
      expect(await response.text()).toContain('<meta http-equiv="Content-Security-Policy"');
    }
  }
});

test('bootstrap runs under CSP and hostile framing fails', async ({ page }) => {
  const messages: string[] = [];
  page.on('console', message => messages.push(message.text()));
  await page.goto('/');
  await expect(page.locator('h1')).toBeVisible();
  expect(messages.filter(message => message.includes('Content Security Policy'))).toEqual([]);
  const framedUrl = new URL('/legal/privacy/v1/', page.url()).href;
  await page.goto('data:text/html,<html><body></body></html>');
  await page.evaluate(url => {
    const frame = document.createElement('iframe');
    frame.src = url;
    document.body.append(frame);
  }, framedUrl);
  await expect.poll(() => page.frames().at(-1)?.url()).toBe('chrome-error://chromewebdata/');
});


test('WebView update page works before app JavaScript and keeps CSP', async ({ browser, baseURL }) => {
  const context = await browser.newContext({ javaScriptEnabled: false });
  const page = await context.newPage();
  const response = await page.goto(`${baseURL}/webview-update.html`);
  expect(response!.status()).toBe(200);
  await expect(page.getByRole('heading', { name: 'Zaktualizuj WebView' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Android System WebView w Sklepie Play' })).toHaveAttribute('href',
    'https://play.google.com/store/apps/details?id=com.google.android.webview');
  await expect(page.getByText(/Vanadium zaktualizujesz w sklepie GrapheneOS/)).toBeVisible();
  await expect(page.getByText(/wybierz innego dostępnego dostawcę WebView w ustawieniach telefonu/)).toBeVisible();
  const policy = await page.locator('meta[http-equiv="Content-Security-Policy"]').getAttribute('content');
  expect(policy).toContain("default-src 'none'");
  expect(policy).toContain("object-src 'none'");
  expect(policy).not.toContain("script-src 'unsafe-inline'");
  await context.close();
});

test('WebView recovery stays readable at 320px with doubled text and keyboard focus', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 640 });
  await page.goto('/webview-update.html');
  await page.evaluate(() => { document.documentElement.style.fontSize = '200%'; });
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(320);
  await page.keyboard.press('Tab');
  const store = page.getByRole('link', { name: 'Android System WebView w Sklepie Play' });
  await expect(store).toBeFocused();
  expect((await store.boundingBox())!.height).toBeGreaterThanOrEqual(56);
});
