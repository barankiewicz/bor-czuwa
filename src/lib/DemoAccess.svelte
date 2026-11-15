<script lang="ts">
  import { onMount, tick } from 'svelte';
  import { clearNativeDemoInvitation, connectNativeDemo, hasNativeDemoInvitation, watchNativeDemoInvitation } from './api-url';
  import { translate, type Language } from './strings';

  let { language, onconnected }: { language: Language; onconnected: () => void } = $props();
  let code = $state('');
  let busy = $state(false);
  let accepted = $state(hasNativeDemoInvitation());
  let error = $state('');
  let section = $state<HTMLElement>();
  let invitationInput = $state<HTMLInputElement>();
  let clearButton = $state<HTMLButtonElement>();
  const t = (text: string) => translate(language, text);
  const ownedFocus = () => section?.contains(document.activeElement) ? document.activeElement : null;
  async function restoreFocus(previous: Element | null) {
    if (!previous) return;
    await tick();
    if (!section?.isConnected || (document.activeElement !== previous && document.activeElement !== document.body)) return;
    (accepted ? clearButton : invitationInput)?.focus();
  }
  onMount(() => watchNativeDemoInvitation(ready => {
    const previous = accepted !== ready ? ownedFocus() : null;
    if (accepted && !ready) error = 'Serwer nie przyjął kodu. Sprawdź zaproszenie lub poproś właścicielkę o aktualny kod.';
    accepted = ready;
    void restoreFocus(previous);
  }));

  async function connect(event: SubmitEvent) {
    event.preventDefault();
    if (busy) return;
    const previous = ownedFocus();
    busy = true;
    error = '';
    try {
      await connectNativeDemo(code);
      code = '';
      onconnected();
    } catch (cause) {
      error = cause instanceof Error && cause.message === 'demo_invitation_invalid'
        ? 'Wpisz 64-znakowy kod zaproszenia od właścicielki testu.'
        : cause instanceof Error && cause.message === 'demo_invitation_refused'
          ? 'Serwer nie przyjął kodu. Sprawdź zaproszenie lub poproś właścicielkę o aktualny kod.'
          : 'Nie udało się połączyć z serwerem testowym. Szkice zostają na telefonie. Spróbuj ponownie, gdy masz internet.';
    } finally {
      busy = false;
      await restoreFocus(previous);
    }
  }
</script>

<section aria-labelledby="demo-access-heading" bind:this={section}>
  <h2 id="demo-access-heading">{t('Dostęp do serwera testowego')}</h2>
  <p>{t('Możesz od razu zapisać szkic bez kodu i internetu. Kod jest potrzebny tylko do połączenia z serwerem testowym.')}</p>
  <p>{t('Kod zostaje tylko w pamięci uruchomionej aplikacji. Po jej ponownym uruchomieniu wpisz go jeszcze raz. Nie usuwamy przy tym szkiców ani zgłoszeń.')}</p>
  {#if accepted}
    <p role="status">{t('Serwer przyjął kod. Zapisane zgłoszenia mogą się teraz zsynchronizować.')}</p>
    <button bind:this={clearButton} onclick={() => { clearNativeDemoInvitation(); accepted = false; error = ''; }}>{t('Usuń kod z pamięci')}</button>
  {:else}
    <form onsubmit={connect} aria-busy={busy}>
      <label for="demo-invitation">{t('Kod zaproszenia')}<input id="demo-invitation" type="password" autocomplete="off" autocapitalize="off" spellcheck="false" bind:this={invitationInput} bind:value={code} readonly={busy} aria-describedby="demo-access-help" /></label>
      <p id="demo-access-help" class="muted">{t('Wpisz kod z prywatnego zaproszenia. Nie wpisuj hasła GitHub ani hasła do poczty.')}</p>
      <button type="submit" disabled={!code} aria-disabled={busy}>{t(busy ? 'Sprawdzanie kodu…' : 'Połącz z serwerem testowym')}</button>
    </form>
  {/if}
  {#if error}<p role="alert">{t(error)}</p>{/if}
</section>
