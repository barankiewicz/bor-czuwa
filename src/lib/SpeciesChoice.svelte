<script lang="ts">
  import { species } from './current-rule-set';
  import type { Report } from './report';
  import { disclosure } from './disclosure';

  let { value, onchange, t }: {
    value: Report['species'] | undefined;
    onchange: (next: Report['species']) => void;
    t: (text: string) => string;
  } = $props();

  let query = $state('');
  // "los" finds "Łoś": compare without case, diacritics or the Polish ł.
  const fold = (text: string) => text.toLocaleLowerCase('pl').normalize('NFD').replace(/\p{M}/gu, '').replace(/ł/g, 'l');
  // The chosen species stays listed while a search narrows, so its radio never looks cleared.
  const matches = $derived(species.filter(([code, label]) => code === value || fold(t(label)).includes(fold(query.trim()))));
  const chosen = $derived(value === 'unknown' ? t('Nie wiem') : value ? t(species.find(([code]) => code === value)?.[1] ?? value) : '');
</script>

<details class="disclosure" use:disclosure>
  <summary>{t('Gatunek')} <small>{chosen || t('nie podano')}</small></summary>
  <div class="disclosure-body">
    <label class="recipient-search">{t('Szukaj gatunku')}<input type="search" bind:value={query} autocomplete="off" /></label>
    <fieldset class="species-options">
      <legend class="sr-only">{t('Gatunek')}</legend>
      <label class="species-option"><input type="radio" name="species" checked={!value} onchange={() => onchange(null)} /> {t('Nie podano')}</label>
      <label class="species-option"><input type="radio" name="species" checked={value === 'unknown'} onchange={() => onchange('unknown')} /> {t('Nie wiem')}</label>
      {#each matches as [code, label] (code)}
        <label class="species-option"><input type="radio" name="species" checked={value === code} onchange={() => onchange(code)} /> {t(label)}</label>
      {/each}
    </fieldset>
    {#if !matches.length}<p class="muted" role="status">{t('Nie ma gatunku o tej nazwie. Wybierz „Nie wiem” albo „Nie podano”.')}</p>{/if}
  </div>
</details>
