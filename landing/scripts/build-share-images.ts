// Draws the share images named in src/lib/share.ts into landing/static/share/, 1200 x 630 each.
// Run from the repository root: npx tsx landing/scripts/build-share-images.ts
// The lockup, as the kit draws it (never retyped), and the tokens come from the brand kit and the app, the title from copy.ts, and the
// type from the fonts the landing already ships, so the images change when those change.
import { chromium } from '@playwright/test';
import { copyFileSync, mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { generalShare, shareNames, shareText, type ShareName } from '../src/lib/share.ts';

const root = path.resolve(import.meta.dirname, '../..');
const out = path.join(root, 'landing/static/share');
const font = (file: string) => `data:font/woff2;base64,${readFileSync(path.join(root, file)).toString('base64')}`;
const svg = (file: string) => readFileSync(path.join(root, file), 'utf8').replace(/<title[\s\S]*?<\/title>/, '').replace(/ (width|height)="\d+"/g, '');

// The app's tokens: --paper, --ink and --action in light, and the dark theme's.
const themes = {
  light: { paper: '#f6f7f5', ink: '#1c1b18', accent: '#9e4310', mark: svg('brand/lockup/horizontal.svg') },
  dark: { paper: '#1b1a17', ink: '#efece4', accent: '#e88a4e', mark: svg('brand/lockup/horizontal-reversed.svg') }
};

const escape = (text: string) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;');

function page(name: ShareName): string {
  const theme = themes[name === 'tagline-dark' ? 'dark' : 'light'];
  const lines = shareText(name);
  const line = name.startsWith('tagline');
  // A page title is set as one block that shrinks to fit; the line is two lines, the second in
  // the accent colour.
  const size = line ? 132 : lines[0].length > 24 ? 104 : lines[0].length > 14 ? 128 : 150;
  const body = line
    ? `<p class="t">${escape(lines[0])}<br><em>${escape(lines[1])}</em></p>`
    : `<p class="t">${escape(lines[0])}</p>`;
  return `<!doctype html><meta charset="utf-8"><style>
@font-face{font-family:A;src:url(${font('landing/src/lib/fonts/archivo-850-80.woff2')});font-weight:850;font-stretch:80%}
@font-face{font-family:A;src:url(${font('landing/src/lib/fonts/archivo-800-100.woff2')});font-weight:800;font-stretch:100%}
@font-face{font-family:T;src:url(${font('landing/static/fonts/AtkinsonHyperlegibleNext-wght.woff2')});font-weight:200 800}
html,body{margin:0;width:1200px;height:630px;background:${theme.paper};color:${theme.ink};overflow:hidden}
main{position:relative;width:1200px;height:630px;box-sizing:border-box;padding:72px 80px}
.m{position:absolute;left:50px;top:40px;width:400px;height:185px}.m svg{width:100%;height:100%;display:block}
.t{position:absolute;left:80px;right:80px;bottom:72px;margin:0;font:850 ${size}px/0.98 A;font-stretch:80%;letter-spacing:0;text-transform:uppercase;color:${theme.ink};text-wrap:balance}
.t em{font-style:normal;color:${theme.accent}}
</style><main><div class="m">${theme.mark}</div>${body}</main>`;
}

mkdirSync(out, { recursive: true });
const browser = await chromium.launch();
try {
  const context = await browser.newContext({ viewport: { width: 1200, height: 630 }, deviceScaleFactor: 1 });
  const tab = await context.newPage();
  for (const name of shareNames) {
    await tab.setContent(page(name));
    await tab.evaluate(() => document.fonts.ready);
    // A title that overflows its block would be cut at the edge: fail rather than ship it.
    const box = await tab.evaluate(() => { const t = document.querySelector('.t')!.getBoundingClientRect(); const n = document.querySelector('.m')!.getBoundingClientRect(); return { top: t.top, bottom: t.bottom, nameBottom: n.bottom }; });
    if (box.top < box.nameBottom + 24 || box.bottom > 630) throw new Error(`${name}: the text does not fit (${JSON.stringify(box)})`);
    await tab.screenshot({ path: path.join(out, `${name}.png`) });
    console.log(name, 'ok');
  }
} finally { await browser.close(); }
// The app's share tags name the general image on the app host (src/app.html).
copyFileSync(path.join(out, `${generalShare}.png`), path.join(root, 'static/brand/share-1200x630.png'));
