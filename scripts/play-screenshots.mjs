// Retakes the Play listing phone screenshots from a built web app (`npx vite build`).
// Usage: node scripts/play-screenshots.mjs [buildDir] [outDir]
// Fictional Draft and Report, fixed clock, no network: the API and map tiles are answered here.
// Output: <outDir>/{pl-PL,en-US}/images/phoneScreenshots/{01-start,02-place,03-saved}.png at 1080 x 1920.
import { createServer } from 'node:http';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { chromium } from '@playwright/test';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const buildDir = resolve(process.argv[2] ?? join(root, 'build'));
const outDir = resolve(process.argv[3] ?? join(root, 'fastlane/metadata/android'));
const NOW = new Date('2026-10-03T12:00:00Z'); // 14:00 in Warsaw
const FIX = { latitude: 52.7, longitude: 23.85, accuracy: 8 }; // a forest road, fictional
const types = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2', '.webmanifest': 'application/manifest+json', '.txt': 'text/plain' };

const server = createServer(async (request, response) => {
  const url = new URL(request.url, 'http://x');
  let file = join(buildDir, decodeURIComponent(url.pathname));
  if (!file.startsWith(buildDir)) { response.writeHead(403).end(); return; }
  if (!extname(file)) file = existsSync(join(file, 'index.html')) ? join(file, 'index.html') : join(buildDir, 'index.html');
  try {
    response.writeHead(200, { 'content-type': types[extname(file)] ?? 'application/octet-stream', 'cache-control': 'no-store' });
    response.end(await readFile(file));
  } catch { response.writeHead(404).end(); }
});
await new Promise(done => server.listen(0, '127.0.0.1', done));
const origin = `http://127.0.0.1:${server.address().port}`;
const challenge = { algorithm: 'SHA-256', challenge: createHash('sha256').update('fixture0').digest('hex'), salt: 'fixture', signature: 'fixture-signature', maxnumber: 1 };
const tile = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/58BAwAI/AL+hc2rNAAAAABJRU5ErkJggg==', 'base64');

/** Waits by condition: fonts, finite animations, a layout that stays put for 600 ms, then two equal shots 500 ms apart. */
async function settle(page) {
  await page.evaluate(() => document.fonts.ready);
  await page.waitForFunction(() => document.getAnimations().every(a => a.effect?.getComputedTiming().iterations === Infinity || a.playState === 'finished'));
  const layout = () => page.evaluate(() => JSON.stringify([...document.querySelectorAll('main, header, footer, button, h1, h2, svg')].map(e => { const r = e.getBoundingClientRect(); return [r.x, r.y, r.width, r.height].map(Math.round); })));
  for (let stable = 0, last = await layout(); stable < 600;) {
    await page.waitForTimeout(100);
    const now = await layout();
    stable = now === last ? stable + 100 : 0;
    last = now;
  }
  for (let attempt = 0; attempt < 10; attempt++) {
    const first = await page.screenshot({ animations: 'disabled' });
    await page.waitForTimeout(500);
    const second = await page.screenshot({ animations: 'disabled' });
    if (first.equals(second)) return second;
  }
  throw new Error('screen never settled');
}

const browser = await chromium.launch();
try {
  for (const [folder, language] of [['pl-PL', 'pl'], ['en-US', 'en']]) {
    const context = await browser.newContext({
      viewport: { width: 432, height: 768 }, deviceScaleFactor: 2.5, isMobile: true, hasTouch: true,
      locale: folder, timezoneId: 'Europe/Warsaw', reducedMotion: 'reduce', serviceWorkers: 'block',
      permissions: ['geolocation', 'accelerometer', 'gyroscope', 'magnetometer'], geolocation: FIX
    });
    await context.addInitScript(([lang]) => {
      localStorage.setItem('first-launch-seen', '1');
      localStorage.setItem('interface-language', lang);
    }, [language]);
    // The clock is fixed, so the browser's real-time geolocation fixes would look stale: stamp them with the fixed time.
    await context.addInitScript(([fix]) => {
      const position = () => ({ coords: { ...fix, altitude: null, altitudeAccuracy: null, heading: null, speed: null }, timestamp: Date.now() });
      navigator.geolocation.getCurrentPosition = success => setTimeout(() => success(position()), 0);
      navigator.geolocation.watchPosition = success => { setTimeout(() => success(position()), 0); return 1; };
      navigator.geolocation.clearWatch = () => {};
      // Record numbers come from the Report id, so ids must not be random.
      let counter = 0;
      crypto.randomUUID = () => `${(0xb04c7e21 + ++counter).toString(16)}-5d3a-4c1e-9f42-6a7b8c9d0e1f`;
      const query = navigator.permissions.query.bind(navigator.permissions);
      navigator.permissions.query = descriptor => descriptor.name === 'magnetometer' ? Promise.resolve({ state: 'granted' }) : query(descriptor);
      // Headless Chromium fires one empty orientation event of its own (no magnetometer); only the synthetic readings below get through.
      const add = window.addEventListener.bind(window);
      window.addEventListener = (type, listener, options) => type === 'deviceorientationabsolute'
        ? add(type, event => { if (!event.isTrusted) listener(event); }, options)
        : add(type, listener, options);
      // A phone held flat and steady, so the compass reads a heading instead of a sensor warning.
      setInterval(() => window.dispatchEvent(new DeviceOrientationEvent('deviceorientationabsolute', { alpha: 40, beta: 0, gamma: 0, absolute: true })), 100);
    }, [FIX]);
    const page = await context.newPage();
    await page.clock.setFixedTime(NOW);
    await page.route('https://tile.openstreetmap.org/**', route => route.fulfill({ contentType: 'image/png', body: tile }));
    await page.route('**/api/**', route => {
      const { pathname } = new URL(route.request().url());
      if (pathname === '/api/challenge') return route.fulfill({ json: challenge });
      if (route.request().method() === 'POST') return route.fulfill({ status: 201, json: { id: route.request().postDataJSON().id } });
      if (pathname.endsWith('/findings')) return route.fulfill({ json: { status: 'pending' } });
      return route.fulfill({ status: 404, json: { error: 'not_found' } });
    });
    if (process.env.DEBUG_SHOTS) {
      page.on('console', message => console.log('console', message.type(), message.text()));
      page.on('response', response => console.log('response', response.status(), response.url()));
    }
    const shots = join(outDir, folder, 'images/phoneScreenshots');
    await mkdir(shots, { recursive: true });
    const save = async (name, image) => { await writeFile(join(shots, name), image); console.log('wrote', folder, name); };

    await page.goto(origin + '/');
    await page.locator('.rows .row, button.event, main button').first().waitFor();
    await save('01-start.png', await settle(page));

    // "Człowiek z bronią" (Person with a gun): Kiedy -> Teraz -> the direction dial on Gdzie.
    await page.getByRole('button', { name: /^(Człowiek z bronią|Person with a gun)/ }).first().click();
    await page.getByRole('button', { name: /^(Teraz|Now)/ }).click();
    await page.getByText(/^(Gdzie widzisz|Where do you see)/).first().waitFor();
    await save('02-place.png', await settle(page));

    // Leave the dial, say it was not at home, save.
    await page.locator('.screen-foot .primary').click();
    await page.locator('#home-check').getByRole('button', { name: /^(Nie|No)$/ }).click();
    await page.locator('.screen-foot .primary').click();
    await page.getByText(/(zapisane|saved)/i).first().waitFor();
    await save('03-saved.png', await settle(page));
    await context.close();
  }
} finally {
  await browser.close();
  server.close();
}
