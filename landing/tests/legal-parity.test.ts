import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { chromium, type Browser } from '@playwright/test';
import { marked } from 'marked';
import { serve } from './serve.ts';

// The app's legal pages render the markdown in the browser, so both renderings are read from a
// real page: the app's build at its versioned route, the landing's at its own routes.
const root = path.resolve(import.meta.dirname, '../..');
const pairs = [
  { name: 'privacy', app: '/legal/privacy/v1/', polish: '/prywatnosc/', english: '/en/privacy/' },
  { name: 'terms', app: '/legal/terms/v1/', polish: '/regulamin/', english: '/en/terms/' }
];
const source = (name: string) => readFileSync(path.join(root, 'src/lib/legal/v1', name), 'utf8');
// Line breaks depend on each page's stylesheet; the words and their order do not.
const flat = (text: string) => text.replace(/\s+/g, ' ').trim();
let browser: Browser;
const servers: Awaited<ReturnType<typeof serve>>[] = [];

before(async () => { browser = await chromium.launch(); });
after(async () => { await browser.close(); servers.forEach(entry => entry.server.close()); });

async function articleText(origin: string, route: string) {
  const page = await browser.newPage();
  try {
    await page.goto(origin + route);
    const article = page.locator('article');
    await article.waitFor();
    return await article.innerText();
  } finally { await page.close(); }
}

for (const pair of pairs) test(`landing renders the same ${pair.name} text as the app`, async () => {
  const app = await serve(path.join(root, 'build')); servers.push(app);
  const landing = await serve(path.join(root, 'landing/build')); servers.push(landing);
  const expected = await articleText(app.origin, pair.app);
  assert.ok(expected.length > 500, 'the app rendering should hold the whole document');
  assert.equal(await articleText(landing.origin, pair.polish), expected, pair.polish);
});

// The app has no English legal route, so the English pages are held to the English files
// themselves, parsed by the same parser and read from a page the same way.
for (const pair of pairs) test(`landing renders the English ${pair.name} file on its English route`, async () => {
  const landing = await serve(path.join(root, 'landing/build')); servers.push(landing);
  const page = await browser.newPage();
  try {
    await page.setContent(`<article>${marked.parse(source(`${pair.name}.en.md`))}</article>`);
    const expected = flat(await page.locator('article').innerText());
    assert.ok(expected.length > 500, 'the English file should hold the whole document');

    await page.goto(landing.origin + pair.english);
    const article = page.locator('article');
    assert.equal(await article.getAttribute('lang'), 'en');
    const shown = flat(await article.innerText());
    assert.equal(shown, expected);
    const polishHeadings = [...source(`${pair.name}.md`).matchAll(/^(?:#{1,6} (.+)|<h[1-6][^>]*>(.+)<\/h[1-6]>)$/gm)].map(match => match[1] ?? match[2]);
    assert.ok(polishHeadings.length > 5, 'the Polish file has headings to look for');
    assert.deepEqual(polishHeadings.filter(heading => shown.includes(heading)), [], 'Polish headings on the English page');
    // The sentence that names the binding version stands before the first section and links to it.
    assert.equal(await article.locator('h1 ~ blockquote a').first().getAttribute('href'), pair.polish);

    await page.goto(landing.origin + pair.polish);
    assert.equal(await page.locator('article').getAttribute('lang'), 'pl');
  } finally { await page.close(); }
});

