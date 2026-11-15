<script lang="ts">
  import FindingsSources from './FindingsSources.svelte';
  import { summarizeFindings } from './findings-summary';
  import type { NoticeRuleSet } from './notice-composer';
  import type { FindingsResult, Report } from './report';
  import { followHeight, lineOut, reveal, textIn, unfold } from './reveal';
  import { translate, type Language } from './strings';

  let { report, findings, rule, language, waiting, retry, ambonaHref, ambonaDisabled, ambonaError, onambona }: {
    report: Report; findings: FindingsResult; rule: NoticeRuleSet | undefined; language: Language;
    /** What the Reporter is told while there are no computed Findings. */
    waiting: string;
    retry?: () => void;
    ambonaHref: string; ambonaDisabled?: boolean; ambonaError?: string; onambona?: (event: MouseEvent) => void;
  } = $props();
  const t = (value: string) => translate(language, value);
  const summary = $derived(findings.status === 'computed' ? summarizeFindings(report, findings, rule, language) : undefined);
  let sources = $state<ReturnType<typeof FindingsSources>>();
</script>

<section class="findings" aria-labelledby="findings-title">
  <h2 id="findings-title">{t('Co wynika z pomiarów')}</h2>
  {#if findings.status === 'computed' && summary}
    <div class="findings-result" transition:reveal={unfold}>
      <p class="findings-caveat">{t('Pomiary opisują miejsce. Nie oceniają, czy ktoś złamał prawo.')}</p>
      {#if summary.facts.length}
        <ul class="facts-list">
          {#each summary.facts as fact (fact.key)}
            <li class="fact" class:metric={fact.key === 'dwelling' || (fact.key === 'ambona' && findings.nearest_ambona?.status === 'mapped')} class:ban={fact.ban} data-fact={fact.key}>
              <span class="fact-what">{fact.what}</span>
              <span class="fact-value"><b>{fact.value}</b>{#if fact.margin}<small>{fact.margin}</small>{/if}</span>
              <span class="fact-meaning">{fact.meaning}</span>
            </li>
          {/each}
        </ul>
      {/if}
      {#if summary.unchecked}<p class="unchecked">{summary.unchecked}</p>{/if}
      <button class="quiet sources-open" onclick={event => sources?.open(event.currentTarget)}>{t('Skąd te wyniki')}</button>
      <FindingsSources bind:this={sources} {report} {findings} {rule} {language} {ambonaHref} {ambonaDisabled} {ambonaError} {onambona} />
    </div>
  {:else}
    <div class="findings-waiting" transition:reveal={unfold}>
      <p class="result-copy" use:followHeight><span class="result-stack">{#key waiting}<span in:textIn out:lineOut>{waiting}</span>{/key}</span></p>
      {#if retry}<div transition:reveal><button class="quiet" onclick={retry}>{t('Spróbuj teraz')}</button></div>{/if}
    </div>
  {/if}
</section>

<style>
  /* Measured numbers lead; one quiet rule separates each complete fact group. */
  .findings { margin: 24px 0 8px; }
  h2 { margin: 0 0 8px; }
  .findings-caveat { margin: 0; color: var(--muted); font-size: .94rem; }
  .findings-waiting p { margin: 4px 0; }
  .facts-list { display: grid; gap: 20px; list-style: none; margin: 20px 0 0; padding: 0; }
  .fact { display: flex; flex-direction: column; gap: 4px; min-width: 0; }
  .fact + .fact { padding-top: 20px; box-shadow: inset 0 1px 0 var(--rule); }
  .fact-what { color: var(--muted); font-size: .94rem; }
  .fact-value { display: flex; flex-wrap: wrap; align-items: baseline; gap: 0 10px; }
  .fact-value b { min-width: 0; overflow-wrap: anywhere; font-family: "Source Serif 4", Georgia, serif; font-weight: 600; font-size: 1.25rem; line-height: 1.2; font-variant-numeric: tabular-nums lining-nums; }
  .metric .fact-value b { font-size: 2rem; line-height: 1.1; }
  .metric[data-fact="dwelling"] .fact-value b { font-size: 3rem; }
  .fact-value small { color: var(--muted); font-size: .94rem; font-variant-numeric: tabular-nums; }
  .fact-meaning { color: var(--muted); font-size: .94rem; overflow-wrap: anywhere; max-width: 68ch; }
  .ban .fact-value b { color: var(--alert); font-size: 1.35rem; }
  .unchecked { margin: 20px 0 0; color: var(--muted); font-size: .88rem; }
  .sources-open { min-height: 56px; margin-top: 4px; }
</style>
