import type { Handle } from '@sveltejs/kit';
import { tagPolish } from '$lib/polish';

// Polish is the default; everything under /en/ is English. The page template holds a %lang% slot.
export const handle: Handle = ({ event, resolve }) => {
  const lang = event.url.pathname === '/en' || event.url.pathname.startsWith('/en/') ? 'en' : 'pl';
  return resolve(event, {
    // English pages keep some Polish terms; they are marked lang="pl" in the body (not the head).
    transformPageChunk: ({ html }) => {
      const page = html.replace('%lang%', lang);
      const body = page.indexOf('<body');
      return lang === 'en' && body > 0 ? page.slice(0, body) + tagPolish(page.slice(body)) : page;
    }
  });
};
