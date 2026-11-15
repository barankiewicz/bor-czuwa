import assert from 'node:assert/strict';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { chromium, type Browser, type BrowserContext, type Route } from '@playwright/test';
import { site } from '../src/lib/site.ts';
import { serve } from './serve.ts';

// The page-opening count, driven in a real browser. The production origin and the app host are
// both intercepted, so nothing here can reach a live collector: the landing build is served to
// the production origin from disk, and every request to the app host is answered by the test.
let browser: Browser;
let local: Awaited<ReturnType<typeof serve>>;
before(async () => {
  browser = await chromium.launch();
  local = await serve(path.resolve(import.meta.dirname, '../build'));
});
after(async () => { await browser.close(); local.server.close(); });

type Seen = { url: string; method: string; body: string | null; headers: Record<string, string> };

async function context(options: { answer?: (route: Route) => Promise<void>; onLine?: boolean } = {}): Promise<{ context: BrowserContext; seen: Seen[]; other: string[] }> {
  const context = await browser.newContext();
  const seen: Seen[] = [];
  const other: string[] = [];
  // Whatever leaves for the app host is recorded and answered; the production origin is the build.
  await context.route(`${new URL(site.appUrl).origin}/**`, async route => {
    const request = route.request();
    if (request.url().startsWith(site.statsUrl)) seen.push({ url: request.url(), method: request.method(), body: request.postData(), headers: await request.allHeaders() });
    else other.push(request.url());
    if (options.answer) return options.answer(route);
    await route.fulfill({ status: 204, headers: { 'Access-Control-Allow-Origin': site.url } });
  });
  await context.route(`${site.url}/**`, async route => {
    const url = new URL(route.request().url());
    await route.fulfill({ response: await route.fetch({ url: `${local.origin}${url.pathname}${url.search}` }) });
  });
  if (options.onLine === false) await context.addInitScript("Object.defineProperty(navigator, 'onLine', { get: () => false })");
  return { context, seen, other };
}
const settle = (ms = 400) => new Promise(resolve => setTimeout(resolve, ms));

test('a document opening sends one empty POST, without cookies, credentials or referrer', async () => {
  const { context: browserContext, seen } = await context();
  try {
    // A cookie on the app host must not ride along: the request is sent with credentials omitted.
    await browserContext.addCookies([{ name: 'probe', value: '1', url: site.appUrl }]);
    const page = await browserContext.newPage();
    const errors: string[] = [];
    page.on('console', message => { if (/Content Security Policy|Refused/.test(message.text())) errors.push(message.text()); });
    await page.goto(`${site.url}/en/`);
    await settle();
    assert.equal(seen.length, 1);
    assert.equal(seen[0].url, `${site.statsUrl}?p=/en/`);
    assert.equal(seen[0].method, 'POST');
    assert.equal(seen[0].body, null);
    assert.equal(seen[0].headers.cookie, undefined);
    assert.equal(seen[0].headers.referer, undefined);
    assert.equal(seen[0].headers.authorization, undefined);
    assert.deepEqual(errors, [], 'the page policy allows the request');
    await page.reload();
    await settle();
    assert.equal(seen.length, 2, 'a reload is a new document opening');
  } finally { await browserContext.close(); }
});

test('a hash link inside the page is not an opening; another page is one, counted for its own path', async () => {
  const { context: browserContext, seen } = await context();
  try {
    const page = await browserContext.newPage();
    await page.goto(`${site.url}/prywatnosc/`);
    await settle();
    assert.equal(seen.length, 1);
    await page.evaluate(() => { location.hash = '#main'; });
    await settle();
    assert.equal(seen.length, 1, 'moving within the page does not count');
    await page.locator('a.lang').click();
    await page.waitForURL(`${site.url}/en/privacy/`);
    await settle();
    assert.deepEqual(seen.map(item => new URL(item.url).searchParams.get('p')), ['/prywatnosc/', '/en/privacy/']);
  } finally { await browserContext.close(); }
});

test('nothing is sent offline', async () => {
  const { context: browserContext, seen } = await context({ onLine: false });
  try {
    const page = await browserContext.newPage();
    await page.goto(`${site.url}/`);
    await settle();
    assert.equal(seen.length, 0);
  } finally { await browserContext.close(); }
});

test('nothing is sent from a development or preview origin', async () => {
  const { context: browserContext, seen } = await context();
  try {
    const page = await browserContext.newPage();
    await page.goto(`${local.origin}/en/`);
    await settle();
    assert.equal(seen.length, 0);
  } finally { await browserContext.close(); }
});

test('a failed count is not retried or queued', async () => {
  for (const answer of [(route: Route) => route.abort('failed'), (route: Route) => route.fulfill({ status: 500 })]) {
    const { context: browserContext, seen } = await context({ answer });
    try {
      const page = await browserContext.newPage();
      await page.goto(`${site.url}/en/`);
      await settle(1500);
      assert.equal(seen.length, 1, 'one attempt, no retry');
      await browserContext.setOffline(true);
      await settle(500);
      await browserContext.setOffline(false);
      await settle(500);
      assert.equal(seen.length, 1, 'nothing is queued and replayed on reconnect');
    } finally { await browserContext.close(); }
  }
});

test('the policy allows the counting endpoint and no other request to the app host', async () => {
  const { context: browserContext, seen, other } = await context();
  try {
    const page = await browserContext.newPage();
    await page.goto(`${site.url}/en/about/`);
    await settle();
    const result = await page.evaluate(`(async (app) => {
      const attempt = (url) => fetch(url, { method: 'POST', mode: 'no-cors' }).then(() => 'sent', () => 'blocked');
      return [await attempt(app + '_stats/other'), await attempt(app + 'api/reports'), await attempt('https://example.com/')];
    })(${JSON.stringify(site.appUrl)})`);
    assert.deepEqual(result, ['blocked', 'blocked', 'blocked']);
    assert.deepEqual(other, [], 'the page policy stopped them before the network');
    assert.equal(seen.length, 1, 'only the page-opening count');
  } finally { await browserContext.close(); }
});

test('a page opened by its index.html name is counted under its own path', async () => {
  const { context: browserContext, seen } = await context();
  try {
    const page = await browserContext.newPage();
    for (const [opened, counted] of [['/index.html', '/'], ['/en/index.html', '/en/']]) {
      seen.length = 0;
      await page.goto(`${site.url}${opened}`);
      await settle();
      assert.deepEqual(seen.map(item => item.url), [`${site.statsUrl}?p=${counted}`], opened);
    }
  } finally { await browserContext.close(); }
});
