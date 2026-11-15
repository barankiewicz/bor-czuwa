import { test, expect } from '@playwright/test';

// The tags a link preview reads from the app's address (ticket 14). The image is named by its
// production address, so the test checks the file at that path on whatever host it is running on.
test('the app page carries share tags and a real 1200 x 630 image', async ({ page, request }) => {
  await page.goto('/');
  const content = (selector: string) => page.locator(selector).first().getAttribute('content');
  expect(await content('meta[property="og:site_name"]')).toBe('Bór czuwa');
  expect(await content('meta[property="og:title"]')).toContain('Bór czuwa');
  expect(await content('meta[property="og:description"]')).toBeTruthy();
  expect(await content('meta[name="description"]')).toBeTruthy();
  expect(await content('meta[name="twitter:card"]')).toBe('summary_large_image');
  expect(await content('meta[property="og:image:alt"]')).toBeTruthy();
  expect(await page.locator('meta[name="theme-color"]').count()).toBe(2);
  const image = new URL((await content('meta[property="og:image"]'))!);
  expect(image.protocol).toBe('https:');
  const response = await request.get(image.pathname);
  expect(response.ok()).toBe(true);
  const bytes = await response.body();
  expect([bytes.readUInt32BE(16), bytes.readUInt32BE(20)]).toEqual([1200, 630]);
  // Nothing a Reporter sees changes: the title is still the layout's.
  await expect(page).toHaveTitle(/^Bór czuwa/);
});
