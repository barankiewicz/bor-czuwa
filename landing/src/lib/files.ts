import { copy, paths, type Lang, type PageKey } from './copy.ts';
import { site } from './site.ts';

// The plain files a crawler or a browser asks for by name. Each is built from copy.ts and site.ts,
// so a changed page title, address or path reaches them without a second edit.
export const pageKeys: PageKey[] = ['home', 'about', 'support', 'privacy', 'terms'];
const abs = (page: PageKey, lang: Lang) => `${site.url}${paths[page][lang]}`;

// Search and AI crawlers are welcome (owner, 2026-11-12). The app host is not listed: it sends
// noindex itself, and this file is the landing's.
export const robots = () => `User-agent: *\nAllow: /\n\nSitemap: ${site.url}/sitemap.xml\n`;

export function sitemap(): string {
  const entries = pageKeys.flatMap(page => (['pl', 'en'] as const).map(lang => {
    const alternates = [['pl', 'pl'], ['en', 'en'], ['x-default', 'pl']] as const;
    return `  <url>\n    <loc>${abs(page, lang)}</loc>\n${alternates.map(([hreflang, to]) =>
      `    <xhtml:link rel="alternate" hreflang="${hreflang}" href="${abs(page, to)}"/>`).join('\n')}\n  </url>`;
  }));
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">\n${entries.join('\n')}\n</urlset>\n`;
}

// llms.txt (llmstxt.org): what the project is, in sentences taken from the signed-off copy, then
// the pages. Nothing here claims more than the pages do.
export function llms(): string {
  const en = copy.en;
  const features = Object.fromEntries(en.home.features.items.map(item => [item.title, item.body]));
  const facts = [
    en.home.description,
    en.home.lead,
    en.about.purpose[0],
    ...en.home.how.steps.map(step => `${step.title}. ${step.body}`),
    en.home.store.help
  ];
  const limits = [
    `${en.home.features.items[0].title}. ${en.home.features.items[0].body}`,
    en.about.intro[1],
    `${en.home.how.steps[1].body.split('. ').at(-1)}`,
    en.about.purpose[1],
    features['Approximate place']
  ];
  const lines = [
    `# ${en.name}`,
    '',
    `> ${en.home.description}`,
    '',
    'An app for reporting hunting incidents in Poland. It works as an Android app and in a web browser.',
    '',
    '## What it does',
    '',
    ...facts.map(fact => `- ${fact}`),
    '',
    '## What it does not do',
    '',
    ...limits.map(fact => `- ${fact}`),
    '',
    '## Who runs it',
    '',
    `- ${en.about.intro[0]}`,
    `- ${en.about.source.licence}`,
    `- ${features['Polish and English']}`,
    '',
    '## Pages',
    '',
    `- [${en.home.title}](${abs('home', 'en')}): ${en.home.description}`,
    `- [${en.about.title}](${abs('about', 'en')}): ${en.about.description}`,
    `- [${en.support.title}](${abs('support', 'en')}): ${en.support.description}`,
    `- [${en.privacy.title}](${abs('privacy', 'en')}): ${en.privacy.description}`,
    `- [${en.terms.title}](${abs('terms', 'en')}): ${en.terms.description}`,
    '',
    '## Polish pages',
    '',
    `- [${copy.pl.home.title}](${abs('home', 'pl')}): ${copy.pl.home.description}`,
    `- [${copy.pl.about.title}](${abs('about', 'pl')})`,
    `- [${copy.pl.support.title}](${abs('support', 'pl')})`,
    `- [${copy.pl.privacy.title}](${abs('privacy', 'pl')})`,
    `- [${copy.pl.terms.title}](${abs('terms', 'pl')})`,
    '',
    '## Elsewhere',
    '',
    `- [Web app](${site.appUrl})`,
    `- [Source code](${site.repoUrl}): ${en.about.source.licence}`,
    ''
  ];
  return lines.join('\n');
}

// RFC 9116. The contact is the project's address once it exists (site.email is a placeholder
// until then), so the file carries the repository's issue tracker meanwhile. The expiry is a
// year after the build, so a site that is no longer rebuilt says so itself.
export function securityTxt(now = new Date()): string {
  const expires = new Date(now.getTime() + 365 * 24 * 3600 * 1000).toISOString().replace(/\.\d+Z$/, 'Z');
  const contact = site.email.includes('@') ? `mailto:${site.email}` : `${site.repoUrl}/security/advisories/new`;
  return `Contact: ${contact}\nExpires: ${expires}\nPreferred-Languages: pl, en\nCanonical: ${site.url}/.well-known/security.txt\n`;
}

export function manifest(): string {
  return JSON.stringify({
    name: copy.pl.name,
    short_name: copy.pl.name,
    description: copy.pl.home.description,
    lang: 'pl',
    start_url: '/',
    scope: '/',
    display: 'browser',
    background_color: '#f6f7f5',
    theme_color: '#f6f7f5',
    icons: [
      { src: '/brand/icon-192.png', sizes: '192x192', type: 'image/png' },
      { src: '/brand/icon-512.png', sizes: '512x512', type: 'image/png' },
      { src: '/brand/maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' }
    ]
  }, null, 2) + '\n';
}

// The page-opening count (ticket 14), a classic script every page loads. One empty POST per
// document opening, with no credentials, no referrer, no retry and no queue. The page path goes
// in the query, as it is (the ten paths are plain ASCII and nginx matches the raw query), because
// the referrer is withheld; a page opened by its index.html name
// counts under its directory path; the app host's nginx counts only the ten known
// paths. Nothing is sent from any origin but the production one, nor while offline, and a
// navigation inside the site is a new document, so every page opening counts once and nothing
// else does.
export function countScript(): string {
  return `(() => {
  if (location.origin !== ${JSON.stringify(site.url)} || !navigator.onLine) return;
  fetch(${JSON.stringify(site.statsUrl)} + '?p=' + location.pathname.replace(/index\\.html$/, ''), {
    method: 'POST',
    // The answer is never read, so the request is sent as no-cors: nothing for the app host to
    // allow, and no CORS complaint in the visitor's console. (no-cors also rules out redirect: 'error'.)
    mode: 'no-cors',
    credentials: 'omit',
    referrerPolicy: 'no-referrer',
    cache: 'no-store',
    keepalive: true
  }).catch(() => {});
})();
`;
}
