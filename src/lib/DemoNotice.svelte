<script lang="ts">
  import { demoTestRecipient } from './demo-handoff';
  import { translate, type Language } from './strings';

  let { language }: { language: Language } = $props();
</script>

{#if demoTestRecipient}
  <aside class="note" aria-label={translate(language, 'Prywatny test')}>
    <strong>{translate(language, 'Prywatny test. Tylko fikcyjne zgłoszenia.')}</strong>
    <p>{translate(language, 'Poczta testowa:')} <span class="route-address">{demoTestRecipient}</span></p>
    <p>{translate(language, 'Nie wysyłaj niczego do urzędów.')}</p>
  </aside>
{/if}
