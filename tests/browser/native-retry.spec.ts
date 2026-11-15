import { test, expect } from '@playwright/test';

// The synthetic native page has no network address. Disable local-network checks, leaving CORS enabled.
test.use({ launchOptions: { args: [
  '--disable-features=LocalNetworkAccessChecks'
] } });

test('native origin can read proxy Retry-After without exposing other origins', async ({ page }) => {
  const web = process.env.TEST_WEB_URL;
  test.skip(!web, 'requires the nginx test stack');
  await page.route('https://localhost/', route => route.fulfill({
    contentType: 'text/html', body: '<!doctype html><title>Native origin</title>'
  }));
  await page.route('https://other.example/', route => route.fulfill({
    contentType: 'text/html', body: '<!doctype html><title>Other origin</title>'
  }));
  await page.goto('https://localhost/');
  const result = await page.evaluate(async url => {
    const responses = await Promise.all(Array.from({ length: 8 }, () => fetch(`${url}/api/challenge`)));
    const limited = responses.find(response => response.status === 429);
    return { statuses: responses.map(response => response.status), retry: limited?.headers.get('Retry-After'),
      cache: limited?.headers.get('Cache-Control') };
  }, web!);
  expect(result.statuses).toContain(429);
  expect(result.retry).toBe('1');
  expect(result.cache).toBe('no-store');

  await page.goto('https://other.example/');
  const blocked = await page.evaluate(async url => {
    try { await fetch(`${url}/api/challenge`); return false; }
    catch { return true; }
  }, web!);
  expect(blocked).toBe(true);
});
