<script lang="ts">
  import { marked } from 'marked';
  import privacyEn from '@app/lib/legal/v1/privacy.en.md?raw';
  import privacyPl from '@app/lib/legal/v1/privacy.md?raw';
  import termsEn from '@app/lib/legal/v1/terms.en.md?raw';
  import termsPl from '@app/lib/legal/v1/terms.md?raw';
  import { privacyPolicyUrl, termsOfUseUrl } from '@app/lib/legal/versions';
  import { paths, type Lang } from './copy';
  import Shell from './Shell.svelte';

  let { lang, page }: { lang: Lang; page: 'privacy' | 'terms' } = $props();
  const sources = { privacy: { pl: privacyPl, en: privacyEn }, terms: { pl: termsPl, en: termsEn } };
  const appUrls = { privacy: privacyPolicyUrl, terms: termsOfUseUrl };
  // The same markdown files and the same parser as the app's legal routes. The texts link to each
  // other at the app's versioned routes, which hold the Polish. Here a text's link to its own
  // route is the English translation naming the binding Polish page, and a link to the other
  // document goes to this site's copy of it in the reader's language.
  const html = $derived((marked.parse(sources[page][lang]) as string)
    .replaceAll(`href="${appUrls[page]}"`, `href="${paths[page].pl}"`)
    .replaceAll(`href="${privacyPolicyUrl}"`, `href="${paths.privacy[lang]}"`)
    .replaceAll(`href="${termsOfUseUrl}"`, `href="${paths.terms[lang]}"`));
</script>

<Shell {lang} {page}>
  <div class="page wrap"><article class="legal" {lang}>{@html html}</article></div>
</Shell>
