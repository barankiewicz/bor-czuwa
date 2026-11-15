import { countScript } from '$lib/files';

export const prerender = true;
export const trailingSlash = 'never';
export const GET = () => new Response(countScript(), { headers: { 'Content-Type': 'text/javascript; charset=utf-8' } });
