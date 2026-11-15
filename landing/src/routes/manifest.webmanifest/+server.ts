import { manifest } from '$lib/files';

export const prerender = true;
export const trailingSlash = 'never';
export const GET = () => new Response(manifest(), { headers: { 'Content-Type': 'application/manifest+json' } });
