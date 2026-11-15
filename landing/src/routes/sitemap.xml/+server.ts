import { sitemap } from '$lib/files';

export const prerender = true;
export const trailingSlash = 'never';
export const GET = () => new Response(sitemap(), { headers: { 'Content-Type': 'application/xml' } });
