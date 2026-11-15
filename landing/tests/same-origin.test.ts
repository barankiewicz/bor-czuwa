import assert from 'node:assert/strict';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { chromium, type Browser } from '@playwright/test';
import { site as config } from '../src/lib/site.ts';
import { serve } from './serve.ts';

const routes = ['/', '/prywatnosc/', '/regulamin/', '/o-projekcie/', '/wesprzyj/', '/en/', '/en/privacy/', '/en/terms/', '/en/about/', '/en/support/'];
let browser: Browser;
let site: Awaited<ReturnType<typeof serve>>;

before(async () => {
  browser = await chromium.launch();
  site = await serve(path.resolve(import.meta.dirname, '../build'));
});
after(async () => { await browser.close(); site.server.close(); });

// The pages are opened under their production origin (served from disk), because that is the only
// origin where the page-opening count fires. The count's own address is the one allowed exception
// and must be asked for exactly once, with the page's path; anything else is a failure.
for (const route of routes) test(`${route} requests nothing from another origin but the count`, async () => {
  const context = await browser.newContext();
  const page = await context.newPage();
  const foreign: string[] = [];
  await context.route(`${config.url}/**`, async handler => {
    const url = new URL(handler.request().url());
    await handler.fulfill({ response: await handler.fetch({ url: `${site.origin}${url.pathname}${url.search}` }) });
  });
  // Abort whatever leaves the origin so a failure never depends on the network being up.
  await page.route(url => url.origin !== config.url && !url.href.startsWith('data:'), async handler => {
    foreign.push(handler.request().url());
    await handler.abort();
  });
  // A font or script that fails to load from this origin is a broken page, not a quiet one.
  const failed: string[] = [];
  page.on('response', response => { if (response.status() >= 400) failed.push(response.url()); });
  // The page's own CSP blocks things without failing a request, so read the console too.
  const blocked: string[] = [];
  page.on('console', message => { if (/Content Security Policy/.test(message.text())) blocked.push(message.text()); });
  try {
    await page.goto(config.url + route, { waitUntil: 'networkidle' });
    assert.deepEqual(foreign, [`${config.statsUrl}?p=${route}`]);
    assert.deepEqual(failed, []);
    assert.deepEqual(blocked, [], 'nothing on the page is blocked by its own policy');
    // Connection hints never reach the request interceptor, so read them from the document.
    const hints = await page.locator('link[rel~="preconnect"], link[rel~="dns-prefetch"]').count();
    assert.equal(hints, 0, 'no connection hints to other hosts');
    assert.ok(await page.locator('h1, article h1').count(), 'the page rendered');
  } finally { await context.close(); }
});
