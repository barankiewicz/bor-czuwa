import type { Handle } from '@sveltejs/kit';
import { themeBeforePaint } from '$lib/theme';

// Every prerendered shell sets its palette before the first paint; the CSP build step hashes this script.
export const handle: Handle = ({ event, resolve }) =>
  resolve(event, { transformPageChunk: ({ html }) => html.replace('</head>', `<script>${themeBeforePaint}</script></head>`) });
