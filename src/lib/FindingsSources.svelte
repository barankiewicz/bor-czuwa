<script lang="ts">
  import { tick } from 'svelte';
  import { explainDwelling, explainNight, seasonCitation } from './finding-explanation';
  import { polishDatasetName } from './findings-reading';
  import { areaShare, distance, protectedKinds, protectedLabel } from './findings-summary';
  import { icons } from './icons';
  import type { NoticeRuleSet } from './notice-composer';
  import type { Findings, Report } from './report';
  import { translate, type Language } from './strings';

  let { report, findings, rule, language, ambonaHref, ambonaDisabled = false, ambonaError = '', onambona }: {
    report: Report; findings: Findings; rule: NoticeRuleSet | undefined; language: Language;
    ambonaHref: string; ambonaDisabled?: boolean; ambonaError?: string; onambona?: (event: MouseEvent) => void;
  } = $props();
  const t = (value: string) => translate(language, value);
  const svg = (name: string) => `<svg aria-hidden="true" viewBox="0 0 24 24">${icons[name]}</svg>`;
  const day = (at: string | undefined) => at ? new Date(at.length === 10 ? `${at}T12:00:00Z` : at)
    .toLocaleDateString(language === 'en' ? 'en-GB' : 'pl-PL', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Europe/Warsaw' }) : '';
  const datasets = (match: (name: string) => boolean) => findings.datasets.filter(dataset => match(dataset.name));
  const area = $derived('type' in report.incident_location);
  const obwod = $derived(findings.obwod_lowiecki);
  const osm = $derived(datasets(name => name === 'OpenStreetMap hunting stands')[0]);
  const protectedAreas = $derived(findings.protected_areas?.status === 'computed' ? findings.protected_areas : undefined);
  const documents = { plan_ochrony: 'Plan ochrony', zadania_ochronne: 'Zadania ochronne' };

  let dialog: HTMLDialogElement;
  let running: Animation[] = [];
  let returnTo: HTMLElement | undefined;
  let closing = false;
  const still = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
  $effect(() => {
    if (!ambonaError) return;
    void tick().then(() => {
      if (dialog.open) dialog.querySelector('#ambona-download-error')?.scrollIntoView({ block: 'nearest', behavior: 'instant' });
    });
  });

  /** Moves the sheet and its backdrop from wherever they are painted now, so an interrupted open closes smoothly. */
  function move(from: number, to: 0 | 1, duration: number, easing: string) {
    const shift = (value: number) => `translateY(${(1 - value) * 16}px)`;
    for (const animation of running) animation.cancel();
    const options = { duration, easing, fill: 'forwards' } as const;
    running = [dialog.animate({ opacity: [from, to], transform: [shift(from), shift(to)] }, options),
      dialog.animate({ opacity: [from, to] }, { ...options, pseudoElement: '::backdrop' })];
    return running[0].finished;
  }
  /** Opens the sheet. It rises 16 px while fading in from transparent, so it is never painted where it lands first. */
  export function open(opener?: HTMLElement) {
    returnTo = opener;
    closing = false;
    dialog.showModal();
    dialog.querySelector<HTMLElement>('.sheet-body')!.scrollTop = 0;
    if (still()) return;
    // Started in the same task as showModal, so the first painted frame is already transparent.
    void move(0, 1, 220, 'ease-out').then(() => { for (const animation of running) animation.cancel(); running = []; }, () => {});
  }
  function close() {
    if (closing || !dialog.open) return;
    if (still()) { dialog.close(); return; }
    closing = true;
    move(Number(getComputedStyle(dialog).opacity), 0, 180, 'ease-in').then(() => {
      dialog.close();
      for (const animation of running) animation.cancel();
      running = [];
      closing = false;
    }, () => {});
  }
  function cancel(event: Event) { event.preventDefault(); close(); }
  function backdrop(event: MouseEvent) { if (event.target === dialog) close(); }
  function closed() { returnTo?.focus(); returnTo = undefined; }
</script>

{#snippet source(match: (name: string) => boolean)}
  {#each datasets(match) as dataset (dataset.name)}
    <li>{t(polishDatasetName(dataset.name))}{#if dataset.publisher_date}, {t('stan z')} {day(dataset.publisher_date)}{/if}. {t('Pobrano')} {day(dataset.retrieved_at)}.</li>
  {/each}
{/snippet}
{#snippet external(href: string, label: string)}
  <a class="source-link" {href} target="_blank" rel="noreferrer"><span>{label}</span>{@html svg('external-link')}</a>
{/snippet}

<dialog class="sheet" bind:this={dialog} aria-labelledby="sources-title" oncancel={cancel} onclick={backdrop} onclose={closed}>
  <div class="sheet-panel">
    <header class="sheet-head">
      <h2 id="sources-title">{t('Skąd te wyniki')}</h2>
      <button class="sheet-close" onclick={close}>{t('Zamknij')}</button>
    </header>
    <div class="sheet-body">
      <dl class="sheet-ids">
        <div><dt>{t('Zestaw reguł')}</dt><dd>{findings.rule_set_id}</dd></div>
        <div><dt>{t('Migawka danych przestrzennych')}</dt><dd>{findings.geodata_snapshot_id}</dd></div>
        <div><dt>{t('Stan danych')}</dt><dd>{day(findings.snapshot_date)}</dd></div>
      </dl>

      <section aria-labelledby="sources-dwelling">
        <h3 id="sources-dwelling">{t('Zabudowania mieszkalne')}</h3>
        {#if rule}<p>{explainDwelling(findings.dwelling_distance, findings.accuracy_m, rule, language)}</p><p class="citation">{rule.citations.dwelling}</p>{/if}
        <ul class="sheet-sources">{@render source(name => name.startsWith('BDOT10k'))}</ul>
      </section>

      <section aria-labelledby="sources-protected">
        <h3 id="sources-protected">{t('Obszary chronione')}</h3>
        <p>{t(area
          ? 'Park narodowy i rezerwat bez dokumentów ochronnych mogą oznaczać zakaz. Podajemy zakaz tylko dla obszaru, który w całości leży w granicach i ich nie dotyka. Pozostałe obszary pokazano jako kontekst.'
          : 'Park narodowy i rezerwat bez dokumentów ochronnych mogą oznaczać zakaz. Granicę porównuje się z dokładnością punktu. Pozostałe obszary pokazano jako kontekst.')}</p>
        {#if protectedAreas}
          {#each protectedKinds as kind (kind)}
            {#each protectedAreas[kind] as entry (entry.inspire_id)}
              <div class="sheet-area">
                <p><strong>{entry.name}</strong> · {protectedLabel(kind, language)}{#if kind === 'otulina'} ({entry.parent_kind === 'park_narodowy' ? t('otulina parku narodowego') : t('otulina rezerwatu')}){/if}</p>
                {#if entry.boundary_distance}<p>{t(area ? 'Odległość obszaru od granicy:' : 'Punkt wewnątrz granic. Odległość od granicy:')} {distance(entry.boundary_distance.value_m, language)}{#if !area && findings.accuracy_m !== null}, {t('dokładność')} ±{Math.round(findings.accuracy_m)} m{/if}.</p>{/if}
                {#if entry.coverage}<p>{entry.coverage === 'wholly_inside' ? t('Cały obszar leży w granicach.')
                  : entry.area_share === undefined ? t('Część obszaru leży w granicach.')
                  : `${t('W granicach leży część obszaru:')} ${areaShare(entry.area_share, language)}.`}</p>{/if}
                {#if kind === 'rezerwat'}
                  {#if entry.document_state === 'neither'}<p>{t('Według migawki CRFOP rezerwat nie ma planu ochrony ani zadań ochronnych.')}</p>
                  {:else if entry.document_state === 'not_in_crfop_snapshot'}<p>{t('Brak rezerwatu w tej migawce CRFOP. Nie ustalono dokumentów ochronnych.')}</p>
                  {:else}
                    <p>{t('Możliwość polowania zależy od obszarów wyznaczonych w dokumentach ochronnych.')}</p>
                    {#each entry.documents ?? [] as document (document.kind)}{@render external(document.url, `${t(documents[document.kind])} ${t('w CRFOP')}`)}{/each}
                  {/if}
                {:else if kind !== 'park_narodowy'}<p>{t('Informacja o obszarze. Ta forma ochrony sama nie ustanawia zakazu polowania.')}</p>{/if}
              </div>
            {/each}
          {/each}
          {#if protectedAreas.rules}<p class="citation">{protectedAreas.rules.citation}</p>{/if}
        {:else}<p>{t('Brak wyniku dla obszarów chronionych w tej migawce danych.')}</p>{/if}
        <ul class="sheet-sources">{@render source(name => name.startsWith('GDOS') || name === 'GDOŚ' || name === 'CRFOP')}</ul>
      </section>

      <section aria-labelledby="sources-noc">
        <h3 id="sources-noc">{t('Noc')}</h3>
        {#if rule}<p>{explainNight(rule, language)}</p><p class="citation">{rule.citations.noc}</p>
        {:else}<p>{t('Nie znaleziono zapisanego zestawu reguł dla tego wyniku.')}</p>{/if}
      </section>

      <section aria-labelledby="sources-season">
        <h3 id="sources-season">{t('Okres ochronny')}</h3>
        {#if rule}
          {#if findings.okres_ochronny?.status === 'in_closed_season' || findings.okres_ochronny?.status === 'outside_closed_season'}<p>{t('Datę porównano z okresem ochronnym wskazanego gatunku w tym zestawie reguł. Szczegóły gatunku i miejscowe wyjątki mogą mieć znaczenie.')}</p>{/if}
          <p class="citation">{seasonCitation(rule, report.species, findings.okres_ochronny)}</p>
        {:else}<p>{t('Nie znaleziono zapisanego zestawu reguł dla tego wyniku.')}</p>{/if}
      </section>

      <section aria-labelledby="sources-obwod">
        <h3 id="sources-obwod">{t('Obwód łowiecki')}</h3>
        {#if obwod.status !== 'not_computed'}
          <p>{t(obwod.disclaimer)}</p>
          {#if obwod.status === 'inside'}<p>{t('Obwód łowiecki:')} {obwod.name}, {t('nr')} {obwod.number} ({obwod.source_year}).</p>{/if}
          {#if obwod.status === 'area'}{#each obwod.obwody as item (`${item.number}:${item.source_year}`)}<p>{item.name}, {t('nr')} {item.number} ({item.source_year}).</p>{/each}{/if}
          <ul class="sheet-sources"><li>{t('Pobrano')} {day(obwod.retrieved_at)}.</li></ul>
          {@render external(obwod.source_url, t(obwod.source_name))}
        {:else}<p>{t('Nie ustalono obwodu łowieckiego dla tego zestawu danych.')}</p>{/if}
      </section>

      <section aria-labelledby="sources-ambona">
        <h3 id="sources-ambona">{t('Ambony')}</h3>
        {#if findings.nearest_ambona && findings.nearest_ambona.status !== 'not_computed'}
          {#if area && findings.nearest_ambona.status === 'mapped' && findings.nearest_ambona.measured_from === 'area_edge'}<p>{t(findings.nearest_ambona.distance_m === 0
            ? 'Ambona leży we wskazanym obszarze, więc odległość wynosi 0 m.'
            : 'Odległość mierzy się od krawędzi wskazanego obszaru, a gdy ambona leży w obszarze, wynosi 0 m.')}</p>{/if}
          <p>{t('Pokrycie OpenStreetMap jest niepełne. Wynik nie potwierdza polowania ani naruszenia prawa; brak oznaczenia nie potwierdza braku ambony.')}</p>
          <ul class="sheet-sources">
            <li>{t('Data źródła:')} {day(osm?.publisher_date ?? osm?.retrieved_at)}. {t('Pobrano:')} {day(osm?.retrieved_at)}.</li>
            <li>{t('Migawka:')} {findings.geodata_snapshot_id}.</li>
          </ul>
          <p class="attribution">© {@render external('https://www.openstreetmap.org/copyright', 'OpenStreetMap contributors')}</p>
          {@render external('https://opendatacommons.org/licenses/odbl/1-0/', 'ODbL')}
          <a class="source-link" href={ambonaHref} aria-disabled={ambonaDisabled || undefined} aria-describedby={ambonaError ? 'ambona-download-error' : undefined} onclick={onambona}><span>{t('Pobierz zbiór oznaczonych ambon (ODbL)')}</span></a>
          {#if ambonaError}<p id="ambona-download-error" class="ambona-error" role="alert">{ambonaError}</p>{/if}
        {:else}<p>{t('Brak wyniku dla ambon w tej migawce danych.')}</p>{/if}
      </section>
    </div>
  </div>
</dialog>

<style>
  /* A sheet rises from the foot of the screen on a phone and sits centred on a wide one. Square, flat, ruled in ink. */
  .sheet { position: fixed; inset: auto 0 0; margin: 0 auto; padding: 0; width: min(100%, 640px); max-width: 100%;
    max-height: none; border: 0; border-top: 1px solid var(--ink); background: var(--paper); color: var(--ink);
    /* Only the body scrolls, so the dialog itself never becomes a focus stop without a ring. */
    overflow: visible;
  }
  .sheet::backdrop { background: rgb(0 0 0 / .42); }
  @media (min-width: 761px) { .sheet { inset: 0; margin: auto; border: 1px solid var(--ink); }
    .sheet .sheet-panel { max-height: min(80dvh, 760px); } }
  .sheet-panel { display: flex; flex-direction: column; max-height: 88dvh; }
  .sheet-head { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 0 12px; padding: 4px 20px 4px 20px; border-bottom: 1px solid var(--rule); }
  .sheet-head h2 { margin: 0; min-width: 0; font-size: 1.35rem; }
  .sheet-close { flex: none; }
  .sheet-body:focus-visible { outline: 3px solid var(--focus); outline-offset: -3px; }
  .sheet-body { overflow-y: auto; overscroll-behavior: contain; padding: 8px 20px calc(24px + env(safe-area-inset-bottom)); }
  .sheet-ids { margin: 8px 0 0; }
  .sheet-ids div { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1.2fr); gap: 12px; padding: 8px 0; border-bottom: 1px solid var(--rule); }
  .sheet-ids dt { font-weight: 600; }
  .sheet-ids dd { margin: 0; overflow-wrap: anywhere; color: var(--muted); }
  section { padding: 12px 0 8px; border-bottom: 1px solid var(--rule); }
  section:last-child { border-bottom: 0; }
  h3 { margin: 12px 0 4px; font-family: "Source Serif 4", Georgia, serif; font-weight: 600; font-size: 1.1rem; }
  p { margin: 6px 0; max-width: 68ch; }
  .citation, .sheet-sources { color: var(--muted); font-size: .88rem; }
  .sheet-sources { list-style: none; margin: 6px 0; padding: 0; }
  .sheet-area { padding: 6px 0; }
  .attribution { display: flex; align-items: center; gap: 4px; margin: 0; }
  .source-link { display: flex; align-items: center; gap: 8px; min-height: 56px; min-width: 56px; width: fit-content; max-width: 100%;
    color: var(--action); font-weight: 700; text-decoration: none; overflow-wrap: anywhere; }
  .source-link:hover { text-decoration: underline; text-underline-offset: .2em; }
  .source-link :global(svg) { flex: none; width: 16px; height: 16px; }
  .source-link[aria-disabled="true"] { color: var(--muted); }
  .ambona-error { color: var(--alert); }
  @media (max-width: 20rem) { .sheet-ids div { grid-template-columns: 1fr; gap: 2px; } }
</style>
