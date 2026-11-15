<script lang="ts">
  import { translate } from '@app/lib/strings';
  import symbolWhite from '@brand/symbol/symbol-white.svg?url';
  import playPl from './badge/play-pl.png?url';
  import playEn from './badge/play-en.png?url';
  import { copy, paths, type Lang } from './copy';
  import { defaults, drawIllo, layoutVars } from './illo.mjs';
  import { site } from './site';
  import Shell from './Shell.svelte';
  import { supporters } from './supporters';

  let { lang }: { lang: Lang } = $props();
  const text = $derived(copy[lang].home);
  const [headA, headB] = $derived(text.headline.split('? ').map((part, i) => (i === 0 ? `${part}?` : part)));

  // The drawing is rendered once, at build time, with ticket 09's function and tuned defaults. Each
  // grain line is numbered top to bottom (data-i), a hook for motion work.
  const drawing = drawIllo(defaults).replace(/(<g class="grain"[^>]*>)([\s\S]*?)(<\/g>)/, (_m: string, open: string, body: string, close: string) => {
    let i = 0;
    return open + body.replace(/<path /g, () => `<path data-i="${i++}" `) + close;
  });
  // How far the drawing's lowest line is painted below the middle of its viewBox, in the drawing's
  // own units, with the viewBox's size. The svg fills its frame as a slice and draws past it, so
  // landing.css turns these into the room the hero keeps under the frame, and no line reaches the
  // section that follows (owner, 2026-11-13).
  const [, viewY, viewW, viewH] = /viewBox="(\S+) (\S+) (\S+) (\S+)"/.exec(drawing)!.slice(1).map(Number);
  const grainBottom = Math.max(...[...drawing.matchAll(/<path data-i[^>]*?(class="fill" )?d="([^"]+)"(?: stroke-width="([\d.]+)")?/g)].map(([, , d, width]) =>
    Math.max(...[...d.matchAll(/[ML]\S+ (-?[\d.]+)/g)].map(point => Number(point[1]))) + Number(width ?? 0) / 2));
  const dropVars = { '--illo-vw': viewW, '--illo-vh': viewH, '--illo-drop': +(grainBottom - viewY - viewH / 2).toFixed(1) };
  const heroStyle = Object.entries({ ...layoutVars(defaults), ...dropVars }).map(([key, value]) => `${key}: ${value}`).join('; ');

  // Lucide (ISC), the app's icon set, for the app's capture screen on the phone.
  const icons: Record<string, string> = {
    'arrow-right': '<path d="M5 12h14"/><path d="m12 5 7 7-7 7"/>',
    'audio-lines': '<path d="M2 10v3"/><path d="M6 6v11"/><path d="M10 3v18"/><path d="M14 8v7"/><path d="M18 5v13"/><path d="M22 10v3"/>',
    'user-round': '<circle cx="12" cy="8" r="5"/><path d="M20 21a8 8 0 0 0-16 0"/>',
    bone: '<path d="M17 10c.7-.7 1.69 0 2.5 0a2.5 2.5 0 1 0 0-5 .5.5 0 0 1-.5-.5 2.5 2.5 0 1 0-5 0c0 .81.7 1.8 0 2.5l-7 7c-.7.7-1.69 0-2.5 0a2.5 2.5 0 0 0 0 5c.28 0 .5.22.5.5a2.5 2.5 0 1 0 5 0c0-.81-.7-1.8 0-2.5Z"/>',
    'paw-print': '<circle cx="11" cy="4" r="2"/><circle cx="18" cy="8" r="2"/><circle cx="20" cy="16" r="2"/><path d="M9 10a5 5 0 0 1 5 5v3.5a3.5 3.5 0 0 1-6.84 1.045Q6.52 17.48 4.46 16.84A3.5 3.5 0 0 1 5.5 10Z"/>',
    lasso: '<path d="M3.704 14.467a10 8 0 1 1 3.115 2.375"/><path d="M7 22a5 5 0 0 1-2-3.994"/><circle cx="5" cy="16" r="2"/>',
    'folder-open': '<path d="m6 14 1.5-2.9A2 2 0 0 1 9.24 10H20a2 2 0 0 1 1.94 2.5l-1.54 6a2 2 0 0 1-1.95 1.5H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3.9a2 2 0 0 1 1.69.9l.81 1.2a2 2 0 0 0 1.67.9H18a2 2 0 0 1 2 2v2"/>'
  };
  const icon = (name: string) => `<svg viewBox="0 0 24 24" aria-hidden="true">${icons[name]}</svg>`;
  // The capture screen's own strings, from the app's catalogue.
  const events: [string, string][] = [
    ['Strzał', 'audio-lines'], ['Człowiek z bronią', 'user-round'], ['Szczątki w lesie', 'bone'],
    ['Ranne zwierzę', 'paw-print'], ['Kłusownictwo', 'lasso']
  ];
  const app = (polish: string) => translate(lang, polish);
</script>

<Shell {lang} page="home" script="/motion.js">
  <section class="hero" style={heroStyle}>
    <div class="wrap hero-copy">
      <div class="copy-box">
        <h1 class="hl"><span class="hl-a">{headA}</span> <span class="hl-b">{headB}</span></h1>
        <p class="lead hook">{text.hook}</p>
        <p class="lead">{text.lead}</p>
      </div>
    </div>
    <div class="illo-frame">{@html drawing}</div>
    <div class="wrap hero-store">
      <div class="store">
        <div class="store-actions">
          <a class="btn btn-primary" href={site.appUrl}>{text.store.openApp}{@html icon('arrow-right')}</a>
          {#if site.showPlayBadge}
            <a class="play" href={site.playUrl}><img src={lang === 'pl' ? playPl : playEn} alt={text.store.play} width="145" height="56" /></a>
          {/if}
        </div>
        <p class="iphone">{text.store.iphone}</p>
        <p class="help">{text.store.help}</p>
      </div>
    </div>
  </section>
  <section class="why wrap" aria-labelledby="why">
    <h2 id="why" class="section-title">{text.why.heading}</h2>
    <div class="why-body">
      {#each text.why.body as paragraph (paragraph)}<p>{paragraph}</p>{/each}
    </div>
  </section>
  <section class="how wrap" aria-labelledby="how">
    <div class="how-copy">
      <h2 id="how" class="section-title">{text.how.heading}</h2>
      <ol class="steps">
        {#each text.how.steps as step, i (step.title)}
          <li><span class="num" aria-hidden="true">{i + 1}</span><div><h3>{step.title}</h3><p>{step.body}</p></div></li>
        {/each}
      </ol>
    </div>
    <div class="how-phone">
      <!-- A picture of the app's capture screen; the steps beside it say what it shows. -->
      <div class="phone" aria-hidden="true">
        <div class="screen">
          <div class="p-band">
            <span class="p-brand"><img src={symbolWhite} alt="" width="32" height="32" />{copy[lang].name}</span>
            <span class="p-actions"><span>{@html icon('folder-open')}</span><span>{app('Menu')}</span></span>
          </div>
          <div class="p-body">
            <p class="p-h1">{app('Co się stało?')}</p>
            <div class="p-rows">
              {#each events as [event, name] (event)}
                <span class="p-row"><span class="p-icon">{@html icon(name)}</span><span class="p-copy">{app(event)}</span></span>
              {/each}
            </div>
          </div>
          <div class="p-foot"><span class="p-primary">{app('Zapisz miejsce i czas')}</span></div>
        </div>
      </div>
    </div>
  </section>
  <section class="feat wrap" aria-labelledby="feat">
    <h2 id="feat" class="section-title">{text.features.heading}</h2>
    <ul class="features">
      {#each text.features.items as item (item.title)}
        <li><h3>{item.title}</h3><p>{item.body}</p></li>
      {/each}
    </ul>
  </section>
  <!-- Support the project (owner, 2026-11-12): the support page's own words, its link and the
       supporting organisations' logos. -->
  <section class="give wrap" aria-labelledby="give">
    <div class="give-copy">
      <h2 id="give" class="section-title">{copy[lang].support.heading}</h2>
      <p>{copy[lang].support.intro[0]}</p>
      <a class="btn btn-primary" href={paths.support[lang]}>{copy[lang].nav.support}<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12h14" /><path d="m12 5 7 7-7 7" /></svg></a>
    </div>
    {#if supporters.length}
      <div class="give-list">
        <h3>{copy[lang].support.listHeading}</h3>
        <ul class="supporters">
          {#each supporters as s (s.name)}
            <li><a href={s.url} rel="noopener"><span class="logo"><img src={`/supporters/${s.logo}`} alt="" /></span><span class="name">{s.name}</span></a></li>
          {/each}
        </ul>
      </div>
    {/if}
  </section>
</Shell>
