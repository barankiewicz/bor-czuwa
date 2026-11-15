import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vite';

// The app's fonts (named as /fonts/... in tokens.css) and the kit's icon and share image (named by
// absolute URL in the share tags and structured data) reach static/ as symlinks into the app's
// static/fonts and brand/, so the landing keeps no copy of them and their paths carry no hash.
export default defineConfig({
  plugins: [sveltekit()],
  // Small assets such as the mark would otherwise be inlined as data: URLs, which the pages' own
  // CSP (img-src 'self') blocks. Emitting them as files keeps the policy strict.
  build: { assetsInlineLimit: 0 },
  server: { fs: { allow: ['..'] } }
});
