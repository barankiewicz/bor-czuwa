// The site's constants. Edit them here and nowhere else.
export const site = {
  // This site's own origin, for canonical and alternate-language links and the share image.
  url: 'https://bor-czuwa.barankiewicz.dev',
  // Interim hosting under the owner's domain; an own domain later is a redeploy.
  appUrl: 'https://app.bor-czuwa.barankiewicz.dev/',
  // Where a page opening is counted (ticket 14): the app host's nginx proxies it to a private
  // GoatCounter. It is the one address the landing may contact besides itself.
  statsUrl: 'https://app.bor-czuwa.barankiewicz.dev/_stats/website',
  playUrl: 'https://play.google.com/store/apps/details?id=pl.borczuwa.app',
  repoUrl: 'https://github.com/barankiewicz/bor-czuwa',
  portfolioUrl: 'https://barankiewicz.dev',
  // The support page's donation link. Placeholder until the Buy Me a Coffee page exists.
  donateUrl: 'https://buymeacoffee.com/[konto]',
  // Placeholder until the project has its address; shown as it stands in both languages.
  email: '[e-mail projektu]',
  // Search-engine ownership checks, filled in by the owner after adding the site in Google Search
  // Console and Bing Webmaster Tools (ticket 14). Paste the token only: the part after content="
  // in the meta tag each console shows. An empty value renders no tag. A console's file method
  // works too: put its file in landing/static/ and leave these empty.
  verification: { google: '', bing: '' },
  // Nothing about Play may be shown before the listing is public.
  showPlayBadge: false
};
