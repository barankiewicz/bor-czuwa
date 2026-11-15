import { copy, paths, type Lang, type PageKey } from './copy.ts';
import { site } from './site.ts';

// The kit's icons at fixed paths (symlinks in static/brand), so the structured data and the page
// head can name them without a build hash. The share images are in share.ts.
export const brandFiles = { icon: '/brand/icon-512.png' };

// The JSON-LD each page carries: the organisation, the site and the app, and on every page but the
// home page a breadcrumb back to it. svelte.config.js allows each version by hash in the page
// policy, so it names every language and page.
export function structuredData(lang: Lang, page: PageKey = 'home'): string {
  const text = copy[lang];
  const organisation = {
    '@type': 'Organization',
    '@id': `${site.url}/#organisation`,
    name: text.name,
    url: `${site.url}/`,
    logo: `${site.url}${brandFiles.icon}`,
    sameAs: [site.repoUrl]
  };
  const website = {
    '@type': 'WebSite',
    '@id': `${site.url}/#website`,
    url: `${site.url}${paths.home[lang]}`,
    name: text.name,
    inLanguage: lang,
    publisher: { '@id': organisation['@id'] }
  };
  const breadcrumb = page === 'home' ? [] : [{
    '@type': 'BreadcrumbList',
    itemListElement: [
      { '@type': 'ListItem', position: 1, name: text.name, item: `${site.url}${paths.home[lang]}` },
      { '@type': 'ListItem', position: 2, name: text[page].title.split(' · ')[0], item: `${site.url}${paths[page][lang]}` }
    ]
  }];
  const app = {
    '@type': 'WebApplication',
    '@id': `${site.url}/#app`,
    name: text.name,
    url: site.appUrl,
    description: text.home.description,
    inLanguage: ['pl', 'en'],
    applicationCategory: 'UtilitiesApplication',
    operatingSystem: 'Android, Web',
    isAccessibleForFree: true,
    offers: { '@type': 'Offer', price: '0', priceCurrency: 'PLN' },
    license: 'https://www.gnu.org/licenses/gpl-3.0.html',
    publisher: { '@id': organisation['@id'] },
    mainEntityOfPage: `${site.url}${paths.home[lang]}`
  };
  // A data block is never run, but "</" is escaped anyway so no text can close the element.
  return JSON.stringify({ '@context': 'https://schema.org', '@graph': [organisation, website, app, ...breadcrumb] }).replaceAll('</', '<\\/');
}
