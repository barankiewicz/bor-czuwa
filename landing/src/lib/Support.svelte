<script lang="ts">
  import { copy, type Lang } from './copy';
  import { site } from './site';
  import { supporters } from './supporters';
  import Shell from './Shell.svelte';

  let { lang }: { lang: Lang } = $props();
  const text = $derived(copy[lang].support);
  const [before, after] = $derived(text.logo.split('{email}'));
</script>

<Shell {lang} page="support">
  <div class="page wrap">
    <h1 class="hl page-title">{text.heading}</h1>
    <div class="support-top">
      <div class="page-intro">
        {#each text.intro as paragraph (paragraph)}<p>{paragraph}</p>{/each}
      </div>
      <div class="donate">
        <a class="btn btn-primary" href={site.donateUrl} rel="noopener">{text.donate}<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12h14" /><path d="m12 5 7 7-7 7" /></svg></a>
        <p>{before}{site.email}{after}</p>
      </div>
    </div>
    <section class="page-part" aria-labelledby="supporters">
      <h2 id="supporters">{text.listHeading}</h2>
      {#if supporters.length}
        <ul class="supporters">
          {#each supporters as s (s.name)}
            <li><a href={s.url} rel="noopener"><span class="logo"><img src={`/supporters/${s.logo}`} alt="" /></span><span class="name">{s.name}</span></a></li>
          {/each}
        </ul>
      {:else}
        <p>{text.empty}</p>
      {/if}
    </section>
  </div>
</Shell>
