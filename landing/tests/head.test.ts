import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

// What a link-preview parser, a crawler and a search console read from the built site, checked
// from the files: every share tag on every page, the files a crawler asks for by name, and the
// structured data. LANDING_BUILD points at another directory for the fixtures that prove the test
// fails; by default it reads the real build.
const root = process.env.LANDING_BUILD ?? path.resolve(import.meta.dirname, '../build');
if (!existsSync(root)) throw new Error(`${root} is missing; run npm run build:landing first`);
const site = 'https://bor-czuwa.pl';
const pages = ['/', '/prywatnosc/', '/regulamin/', '/o-projekcie/', '/wesprzyj/', '/en/', '/en/privacy/', '/en/terms/', '/en/about/', '/en/support/'];
const read = (name: string) => readFileSync(path.join(root, name), 'utf8');
const htmlOf = (route: string) => read(path.join(route, 'index.html'));
const attr = (tag: string, name: string) => new RegExp(`\\b${name}\\s*=\\s*"([^"]*)"`, 'i').exec(tag)?.[1];
const tags = (html: string, name: string) => (html.match(/<(?:meta|link)\b[^>]*>/gi) ?? []).filter(tag => attr(tag, 'property') === name || attr(tag, 'name') === name || attr(tag, 'rel') === name);
const one = (html: string, name: string) => { const found = tags(html, name); assert.equal(found.length, 1, `${name}: ${found.length} tags`); return attr(found[0], 'content') ?? attr(found[0], 'href') ?? ''; };
const png = (file: string) => { const bytes = readFileSync(path.join(root, file)); assert.equal(bytes.subarray(1, 4).toString(), 'PNG', `${file} is a PNG`); return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) }; };

for (const route of pages) {
  const lang = route.startsWith('/en/') || route === '/en/' ? 'en' : 'pl';
  test(`${route} carries complete share tags`, () => {
    const html = htmlOf(route);
    const image = one(html, 'og:image');
    assert.ok(image.startsWith(`${site}/share/`), `og:image is an absolute URL on the site: ${image}`);
    assert.deepEqual(png(image.slice(site.length)), { width: 1200, height: 630 });
    assert.equal(one(html, 'og:image:type'), 'image/png');
    assert.equal(one(html, 'og:image:width'), '1200');
    assert.equal(one(html, 'og:image:height'), '630');
    assert.ok(one(html, 'og:image:alt').length > 5, 'og:image:alt says something');
    assert.equal(one(html, 'og:locale'), lang === 'pl' ? 'pl_PL' : 'en_GB');
    assert.equal(one(html, 'og:locale:alternate'), lang === 'pl' ? 'en_GB' : 'pl_PL');
    assert.equal(one(html, 'og:url'), one(html, 'canonical'));
    assert.equal(one(html, 'twitter:card'), 'summary_large_image');
    assert.ok(one(html, 'og:title') && one(html, 'og:description') && one(html, 'description'));
    assert.equal(tags(html, 'theme-color').length, 2, 'a light and a dark theme-color');
    assert.equal(one(html, 'manifest'), '/manifest.webmanifest');
    assert.ok(existsSync(path.join(root, one(html, 'apple-touch-icon'))), 'the touch icon exists');
    // The ownership-check slots render nothing until the owner fills them in site.ts.
    assert.equal(tags(html, 'google-site-verification').length + tags(html, 'msvalidate.01').length, 0);
    assert.ok(!/noindex/i.test(html), 'the page is not excluded from search');
  });

  test(`${route} structured data is valid and names this page`, () => {
    const html = htmlOf(route);
    const blocks = [...html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)];
    assert.equal(blocks.length, 1);
    const graph = JSON.parse(blocks[0][1].replaceAll('<\\/', '</'))['@graph'] as Record<string, any>[];
    const byType = Object.fromEntries(graph.map(node => [node['@type'], node]));
    assert.deepEqual(Object.keys(byType).filter(type => type !== 'BreadcrumbList').sort(), ['Organization', 'WebApplication', 'WebSite']);
    assert.equal(byType.WebSite.inLanguage, lang);
    assert.equal(byType.WebApplication.offers.price, '0');
    // Everything it links to is on the site or the app host, and the ids resolve.
    const ids = new Set(graph.map(node => node['@id']).filter(Boolean));
    assert.ok(ids.has(byType.WebApplication.publisher['@id']) && ids.has(byType.WebSite.publisher['@id']));
    if (route === '/' || route === '/en/') assert.equal(byType.BreadcrumbList, undefined, 'the home page is the root of the trail');
    else {
      const items = byType.BreadcrumbList.itemListElement;
      assert.deepEqual(items.map((item: any) => item.position), [1, 2]);
      assert.equal(items[1].item, one(html, 'canonical'));
      assert.ok(items.every((item: any) => item.name && item.item.startsWith(site)));
    }
  });
}

test('every page names its own share image, and the file exists', () => {
  const images = pages.map(route => one(htmlOf(route), 'og:image'));
  for (const image of images) assert.ok(existsSync(path.join(root, image.slice(site.length))), image);
  const english = images.filter((_, index) => index >= 5);
  assert.equal(new Set(english).size, english.length, 'each English page has its own image');
});

test('robots.txt welcomes crawlers and names the sitemap', () => {
  const text = read('robots.txt');
  assert.match(text, /^User-agent: \*\nAllow: \//m);
  assert.doesNotMatch(text, /Disallow:\s*\//, 'nothing is disallowed');
  assert.match(text, new RegExp(`^Sitemap: ${site}/sitemap\\.xml$`, 'm'));
});

test('sitemap.xml lists the ten pages with hreflang alternates', () => {
  const xml = read('sitemap.xml');
  const locs = [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map(match => match[1]).sort();
  assert.deepEqual(locs, pages.map(route => site + route).sort());
  for (const block of xml.split('<url>').slice(1)) {
    assert.equal((block.match(/hreflang="/g) ?? []).length, 3, 'pl, en and x-default');
    assert.match(block, /hreflang="x-default" href="[^"]+"/);
  }
  assert.ok(!xml.includes('app.bor-czuwa'), 'the app host is left out');
});

test('llms.txt is plain sentences from the copy, with links to the pages', () => {
  const text = read('llms.txt');
  assert.match(text, /^# Bór czuwa$/m);
  for (const phrase of ['No account', 'is not an official service', 'do not rule on guilt', 'GPLv3', 'Polish and English']) assert.ok(text.includes(phrase), phrase);
  for (const route of pages) assert.ok(text.includes(`(${site}${route})`), `links ${route}`);
  assert.doesNotMatch(text, /undefined|\[object/);
  // Words the signed-off copy and the spec do not use: "hear" is the owner's to add, not ours.
  assert.doesNotMatch(text, /\bhear\b/i);
  assert.match(text, /^An app for reporting hunting incidents in Poland/m);
  assert.doesNotMatch(text, /analytics/i, 'no claim about tracking that the privacy text does not make');
});

test('security.txt has a contact and an expiry in the future', () => {
  const text = read('.well-known/security.txt');
  assert.match(text, /^Contact: (https:|mailto:)\S+$/m);
  const expires = /^Expires: (\S+)$/m.exec(text)?.[1] ?? '';
  assert.ok(Date.parse(expires) > Date.now() + 300 * 24 * 3600 * 1000, 'expires about a year out');
});

test('the manifest names icons that exist', () => {
  const manifest = JSON.parse(read('manifest.webmanifest'));
  assert.ok(manifest.name && manifest.start_url === '/');
  for (const icon of manifest.icons) assert.deepEqual(png(icon.src.slice(1)), { width: Number(icon.sizes.split('x')[0]), height: Number(icon.sizes.split('x')[1]) });
  assert.ok(manifest.icons.some((icon: any) => icon.purpose === 'maskable'));
});

test('the build holds no stray file for the crawler to find', () => {
  const names = readdirSync(root);
  for (const name of ['robots.txt', 'sitemap.xml', 'llms.txt', 'manifest.webmanifest', 'count.js']) assert.ok(names.includes(name), name);
});
