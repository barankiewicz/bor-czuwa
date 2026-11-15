import adapter from '@sveltejs/adapter-static';
import { vitePreprocess } from '@sveltejs/vite-plugin-svelte';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { structuredData } from './src/lib/structured-data.ts';
import { site } from './src/lib/site.ts';

// The page template's head script (theme and motion, before first paint) and each language's and
// page's JSON-LD block are inline, so the policy names them by the sha256 of their exact text. The hashes
// are computed from the same sources the pages are built from, so an edit cannot drift from them.
const template = readFileSync(new URL('./src/app.html', import.meta.url), 'utf8');
const inline = [...template.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(match => match[1]);
const sha256 = text => `sha256-${createHash('sha256').update(text).digest('base64')}`;
const pages = ['home', 'about', 'support', 'privacy', 'terms'];
const ownScripts = [...inline, ...['pl', 'en'].flatMap(lang => pages.map(page => structuredData(lang, page)))].map(sha256);

export default {
  preprocess: vitePreprocess(),
  kit: {
    adapter: adapter(),
    // The landing sits on shared hosting that may ignore a header file, so each prerendered page
    // carries its policy in a meta element. The pages ship no SvelteKit runtime (csr is off), so
    // the only inline scripts are the two named above. frame-ancestors cannot be set in a meta
    // element and lives in static/.htaccess.
    csp: {
      mode: 'hash',
      directives: {
        'default-src': ['none'],
        'script-src': ['self', ...ownScripts],
        'style-src-elem': ['self'],
        // The page template wraps the body in an element with an inline display value.
        'style-src-attr': ['unsafe-inline'],
        'img-src': ['self'],
        'font-src': ['self'],
        // The page-opening count, and nothing else (ticket 14).
        'connect-src': [site.statsUrl],
        // The web manifest; without it the default-src 'none' would refuse to read it.
        'manifest-src': ['self'],
        'object-src': ['none'],
        'frame-src': ['none'],
        'base-uri': ['self'],
        'form-action': ['none']
      }
    },
    // The app's sources, imported rather than copied: tokens, fonts, the mark and the legal markdown.
    alias: { '@app': '../src', '@static': '../static', '@brand': '../brand' }
  }
};
