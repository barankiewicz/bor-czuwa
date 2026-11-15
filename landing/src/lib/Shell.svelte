<script lang="ts">
  import type { Snippet } from 'svelte';
  import '@app/routes/tokens.css';
  import './landing.css';
  import favicon from '@brand/icons/favicon.svg?url';
  import lockup from '@brand/lockup/horizontal.svg?url';
  import lockupDark from '@brand/lockup/horizontal-reversed.svg?url';
  import symbolSmall from '@brand/symbol/symbol-small.svg?url';
  import symbolSmallDark from '@brand/symbol/symbol-small-reversed.svg?url';
  import display from './fonts/archivo-850-80.woff2?url';
  import displayHeading from './fonts/archivo-800-100.woff2?url';
  import { copy, paths, type Lang, type PageKey } from './copy';
  import { site } from './site';
  import { structuredData } from './structured-data';
  import { shareAlt, shareFile, use } from './share';

  let { lang, page, script, children }: { lang: Lang; page: PageKey; script?: string; children: Snippet } = $props();
  const text = $derived(copy[lang]);
  const other = $derived<Lang>(lang === 'pl' ? 'en' : 'pl');
  const links = ['about', 'support', 'privacy', 'terms'] as const;
  const url = (l: Lang) => `${site.url}${paths[page][l]}`;
  // A data block, allowed in the page policy by its hash (svelte.config.js).
  const image = $derived(use[page][lang]);
  const jsonLd = $derived(`<script type="application/ld+json">${structuredData(lang, page)}</` + 'script>');
</script>

<svelte:head>
  <title>{text[page].title}</title>
  <meta name="description" content={text[page].description} />
  <link rel="canonical" href={url(lang)} />
  <link rel="alternate" hreflang="pl" href={url('pl')} />
  <link rel="alternate" hreflang="en" href={url('en')} />
  <link rel="alternate" hreflang="x-default" href={url('pl')} />
  <link rel="icon" href={favicon} type="image/svg+xml" />
  <link rel="preload" href={display} as="font" type="font/woff2" crossorigin="anonymous" />
  <link rel="preload" href={displayHeading} as="font" type="font/woff2" crossorigin="anonymous" />
  <link rel="preload" href="/fonts/AtkinsonHyperlegibleNext-wght.woff2" as="font" type="font/woff2" crossorigin="anonymous" />
  <meta property="og:type" content="website" />
  <meta property="og:site_name" content={text.name} />
  <meta property="og:title" content={text[page].title} />
  <meta property="og:description" content={text[page].description} />
  <meta property="og:url" content={url(lang)} />
  <meta property="og:locale" content={lang === 'pl' ? 'pl_PL' : 'en_GB'} />
  <meta property="og:locale:alternate" content={lang === 'pl' ? 'en_GB' : 'pl_PL'} />
  <meta property="og:image" content={`${site.url}${shareFile(image)}`} />
  <meta property="og:image:type" content="image/png" />
  <meta property="og:image:width" content="1200" />
  <meta property="og:image:height" content="630" />
  <meta property="og:image:alt" content={shareAlt(image, lang)} />
  <meta name="twitter:card" content="summary_large_image" />
  <meta name="twitter:image:alt" content={shareAlt(image, lang)} />
  <meta name="theme-color" content="#f6f7f5" media="(prefers-color-scheme: light)" />
  <meta name="theme-color" content="#1b1a17" media="(prefers-color-scheme: dark)" />
  <link rel="apple-touch-icon" href="/brand/apple-touch-icon.png" />
  <link rel="manifest" href="/manifest.webmanifest" />
  {#if site.verification.google}<meta name="google-site-verification" content={site.verification.google} />{/if}
  {#if site.verification.bing}<meta name="msvalidate.01" content={site.verification.bing} />{/if}
  <script src="/count.js" defer></script>
  {#if script}<script type="module" src={script}></script>{/if}
  {@html jsonLd}
</svelte:head>

<a class="skip" href="#main">{text.skip}</a>
<header class="site-head wrap">
  <a class="home" href={paths.home[lang]}>
    <img class="on-light" src={lockup} alt={text.name} width="139" height="64" />
    <img class="on-dark" src={lockupDark} alt={text.name} width="139" height="64" />
  </a>
  <nav class="site-nav" aria-label={lang === 'pl' ? 'Strony' : 'Pages'}>
    {#each links as key (key)}
      <a href={paths[key][lang]} aria-current={key === page ? 'page' : undefined}>{text.nav[key]}</a>
    {/each}
  </nav>
  <div class="head-end">
    <a class="lang" href={paths[page][other]} hreflang={other} lang={other}>{text.otherLanguage}</a>
    <button class="theme" type="button" aria-pressed="false" aria-label={text.theme} title={text.theme}>
      <svg viewBox="0 0 24 24" aria-hidden="true"><path class="moon" d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z" /><g class="sun"><circle cx="12" cy="12" r="4" /><path d="M12 2v2" /><path d="M12 20v2" /><path d="m4.93 4.93 1.41 1.41" /><path d="m17.66 17.66 1.41 1.41" /><path d="M2 12h2" /><path d="M20 12h2" /><path d="m6.34 17.66-1.41 1.41" /><path d="m19.07 4.93-1.41 1.41" /></g></svg>
    </button>
  </div>
</header>
<main id="main">{@render children()}</main>
<footer class="bar">
  <div class="bar-row wrap">
    <a class="bar-brand" href={paths.home[lang]}>
      <span class="bar-mark"><img class="on-light" src={symbolSmall} alt="" width="24" height="24" /><img class="on-dark" src={symbolSmallDark} alt="" width="24" height="24" /></span>{text.name}
    </a>
    <a class="bar-link" href={site.portfolioUrl}>{text.footer.portfolio}</a>
    <a class="bar-link" href={site.repoUrl}>
      <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M15 22v-4a4.8 4.8 0 0 0-1-3.5c3 0 6-2 6-5.5.08-1.25-.27-2.48-1-3.5.28-1.15.28-2.35 0-3.5 0 0-1 0-3 1.5-2.64-.5-5.36-.5-8 0C6 2 5 2 5 2c-.3 1.15-.3 2.35 0 3.5A5.403 5.403 0 0 0 4 9c0 3.5 3 5.5 6 5.5-.39.49-.68 1.05-.85 1.65-.17.6-.22 1.23-.15 1.85v4" /><path d="M9 18c-4.51 2-5-2-7-2" /></svg>{text.footer.github}
    </a>
    <span class="bar-rights">{text.footer.copyright}</span>
    <p class="bar-line">{text.footer.line}</p>
  </div>
</footer>
