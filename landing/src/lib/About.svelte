<script lang="ts">
  import markSvg from '@brand/lockup/horizontal.svg?url';
  import { copy, type Lang } from './copy';
  import { site } from './site';
  import { brandFiles } from './structured-data';
  import Shell from './Shell.svelte';

  let { lang }: { lang: Lang } = $props();
  const text = $derived(copy[lang].about);
  const bare = (url: string) => url.replace(/^https?:\/\//, '');
</script>

<Shell {lang} page="about">
  <div class="page wrap">
    <h1 class="hl page-title">{text.heading}</h1>
    <div class="page-intro">
      {#each text.purpose as paragraph (paragraph)}<p>{paragraph}</p>{/each}
      {#each text.intro as paragraph (paragraph)}<p>{paragraph}</p>{/each}
    </div>
    <section class="page-part">
      <h2>{text.contact.heading}</h2>
      <p>{site.email}</p>
    </section>
    <section class="page-part">
      <h2>{text.mark.heading}</h2>
      <p class="downloads">
        <a class="textlink" href={markSvg} download="bor-czuwa.svg">{text.mark.svg}</a>
        <a class="textlink" href={brandFiles.icon} download="bor-czuwa.png">{text.mark.png}</a>
      </p>
    </section>
    <section class="page-part">
      <h2>{text.source.heading}</h2>
      <p>{text.source.licence}</p>
      <p><a class="textlink" href={site.repoUrl}>{bare(site.repoUrl)}</a></p>
    </section>
  </div>
</Shell>
