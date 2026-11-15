import { createHash } from 'node:crypto';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const root = path.resolve('build');
const hashes = new Set();
const htmlFiles = [];
const configuredApiOrigin = process.env.VITE_API_ORIGIN;
const apiOrigin = configuredApiOrigin ? new URL(configuredApiOrigin) : undefined;
if (apiOrigin && (apiOrigin.protocol !== 'https:' || apiOrigin.origin !== configuredApiOrigin)) {
  throw new Error('VITE_API_ORIGIN must be an HTTPS origin');
}

async function visit(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) await visit(file);
    else if (entry.name.endsWith('.html')) {
      const html = await readFile(file, 'utf8');
      htmlFiles.push([file, html]);
      for (const match of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) {
        if (/\bsrc\s*=/.test(match[1]) || !match[2].trim()) continue;
        hashes.add(`'sha256-${createHash('sha256').update(match[2]).digest('base64')}'`);
      }
    }
  }
}

await visit(root);
if (!hashes.size) throw new Error('No SvelteKit bootstrap scripts found for CSP');

const directives = [
  "default-src 'none'",
  `script-src 'self' ${[...hashes].sort().join(' ')}`,
  "style-src-elem 'self'",
  // Map tiles, area outlines and the compass set calculated inline positions/angles.
  "style-src-attr 'unsafe-inline'",
  // Raster tiles for the place picker and the Sprawdź map.
  "img-src 'self' blob: https://tile.openstreetmap.org",
  "font-src 'self'",
  // Vector tiles under the direction target, fetched and drawn by the app, and the elevation tiles its
  // contour lines are traced from (Mapzen terrain tiles on AWS open data), limited to that bucket's path.
  `connect-src 'self' https://tiles.openfreemap.org https://s3.amazonaws.com/elevation-tiles-prod/${apiOrigin ? ` ${apiOrigin.origin}` : ''}`,
  "worker-src 'self'",
  "media-src 'self' blob:",
  "manifest-src 'self'",
  "object-src 'none'",
  "frame-src 'none'",
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self'"
];
const policy = directives.join('; ');
// Capacitor loads bundled HTML without nginx, so its policy travels with each document.
const metaPolicy = directives.filter(value => !value.startsWith('frame-ancestors ')).join('; ');
for (const [file, html] of htmlFiles) {
  if (!html.includes('<head>')) throw new Error(`No head in ${file}`);
  await writeFile(file, html.replace('<head>',
    `<head><meta http-equiv="Content-Security-Policy" content="${metaPolicy}">`));
}

await writeFile(path.join(root, 'security-headers.conf'), [
  `add_header Content-Security-Policy "${policy}" always;`,
  'add_header X-Frame-Options "DENY" always;',
  'add_header X-Content-Type-Options "nosniff" always;',
  'add_header Permissions-Policy "camera=(self), geolocation=(self)" always;',
  'add_header Referrer-Policy "no-referrer" always;',
  ''
].join('\n'));
