import { copy, type Lang, type PageKey } from './copy.ts';

// The share images (1200 x 630) that link previews show. landing/scripts/build-share-images.ts
// draws every file named here into static/share/, from the brand kit and the page titles in
// copy.ts. Which image a page uses is the `use` table below: change a value, rebuild, done.

// The owner's line, set on the tagline images. The English images carry it untranslated and do
// not explain it (owner, 2026-11-12).
export const tagline = ['Bór nie darzy.', 'Bór czuwa.'] as const;

export type ShareName = 'tagline' | 'tagline-dark' | `${PageKey}-${Lang}`;

// What each image shows: the page's own title, or the line. The shorter title (before the "·")
// keeps the text large enough to read at thumbnail size; the home page uses its headline.
export function shareText(name: ShareName): string[] {
  if (name === 'tagline' || name === 'tagline-dark') return [...tagline];
  const [page, lang] = name.split('-') as [PageKey, Lang];
  const text = copy[lang];
  return [page === 'home' ? text.home.headline : text[page].title.split(' · ')[0]];
}

export const shareNames: ShareName[] = [
  'tagline', 'tagline-dark',
  ...(['home', 'privacy', 'terms', 'about', 'support'] as const).flatMap(page => (['pl', 'en'] as const).map(lang => `${page}-${lang}` as ShareName))
];

// Proposal, for the owner to change after looking at the renders: the Polish home page and the
// project's general share (the app's) carry the line; every other page carries its title.
export const use: Record<PageKey, Record<Lang, ShareName>> = {
  home: { pl: 'tagline', en: 'home-en' },
  privacy: { pl: 'privacy-pl', en: 'privacy-en' },
  terms: { pl: 'terms-pl', en: 'terms-en' },
  about: { pl: 'about-pl', en: 'about-en' },
  support: { pl: 'support-pl', en: 'support-en' }
};
export const generalShare: ShareName = 'tagline';

export const shareFile = (name: ShareName) => `/share/${name}.png`;

// The alternative text of an image: what a person who cannot see it needs to know.
export function shareAlt(name: ShareName, lang: Lang): string {
  const brand = copy[lang].name;
  if (name === 'tagline' || name === 'tagline-dark') return `${brand}. ${tagline.join(' ')}`;
  return `${brand}. ${shareText(name).join(' ')}`;
}
