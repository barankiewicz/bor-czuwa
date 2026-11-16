<script lang="ts">
  import { onMount } from 'svelte';
  import { afterNavigate, goto } from '$app/navigation';
  import { marked } from 'marked';
  import { icons } from './icons';
  import { translate, type Language } from './strings';
  import { watchTheme } from './theme';
  import './legal.css';
  import DemoNotice from './DemoNotice.svelte';
  import { demoTestRecipient } from './demo-handoff';

  let { source }: { source: string } = $props();
  let language = $state<Language>('pl');
  // Opened from a screen of the app, the way back returns to that screen rather than to home.
  let openedFromApp = false;
  afterNavigate(({ type, from }) => { openedFromApp = type !== 'enter' && from?.route.id === '/'; });
  onMount(() => {
    language = localStorage.getItem('interface-language') === 'en' ? 'en' : 'pl';
    // The app keeps its screens in history entries SvelteKit does not track, so going back into one
    // only changes the URL. Load the app at that screen instead of leaving this page on view.
    const leave = (event: PopStateEvent) => { if (!event.state?.['sveltekit:history']) void goto(location.href, { replaceState: true }); };
    addEventListener('popstate', leave);
    const theme = watchTheme();
    return () => { removeEventListener('popstate', leave); theme.stop(); };
  });
  const html = $derived(marked.parse(source) as string);
  function back(event: MouseEvent) {
    if (!openedFromApp) return;
    event.preventDefault();
    history.back();
  }
</script>

<header class="legal-bar">
  <a href="/" lang={language} onclick={back}><svg aria-hidden="true" viewBox="0 0 24 24">{@html icons['arrow-left']}</svg>{translate(language, 'Wróć do aplikacji')}</a>
</header>
<main class="legal-page" lang={demoTestRecipient ? language : 'pl'}>
  {#if demoTestRecipient}
    <DemoNotice {language} />
    <h1>{translate(language, 'Prywatny test')}</h1>
    <p>{translate(language, 'Ten prywatny test działa na serwerze OVH w Kanadzie, poza EOG. Nie służy do zgłaszania prawdziwych zdarzeń. Używaj wyłącznie fikcyjnych danych, także w podpisie, notatkach i zdjęciach.')}</p>
    <p>{translate(language, 'Połączenie przekazuje adres IP do Kanady. GPS może zapisać prawdziwą pozycję telefonu. Do prób używaj fikcyjnego miejsca i czasu; nie zapisuj danych prawdziwego zdarzenia.')}</p>
    <p>{translate(language, 'Mapa i wyszukiwanie miejsc łączą się z usługami OpenStreetMap. Ich zasady prywatności obowiązują także w teście.')} <a href="https://wiki.osmfoundation.org/wiki/Privacy_Policy" target="_blank" rel="noreferrer">OpenStreetMap Foundation</a>.</p>
    <p>{translate(language, 'Nazwy urzędów i dane mapowe są prawdziwe. Powiadomienia kierujemy wyłącznie do skrzynki testowej, nie do urzędów. Poczta i udostępnianie otwierają inną aplikację: sprawdź odbiorcę przed wysłaniem.')}</p>
    <p>{translate(language, 'Zgłoszenia testowe zostają do czasu, gdy właścicielka zleci ich usunięcie. Możesz też wycofać pojedyncze zgłoszenie. Sami nie robimy kopii zapasowych; OVH trzyma jedną kopię dysku, sprzed najwyżej doby. Testów nie przenosimy do wersji publicznej.')}</p>
    <p>{translate(language, 'Poniżej zachowujemy projekt dokumentu dla wersji docelowej. Opisy serwera, publikacji i podstawy przetwarzania nie opisują tego testu ani nie oznaczają zgody na publiczne wdrożenie.')}</p>
    <details class="disclosure"><summary>{translate(language, 'Projekt dokumentu dla wersji docelowej')}</summary><article lang="pl">{@html html}</article></details>
  {:else}
    <article>{@html html}</article>
  {/if}
</main>
