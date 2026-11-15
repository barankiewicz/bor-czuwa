<script lang="ts">
  import { onNavigate } from '$app/navigation';
  import { demoTestRecipient } from '$lib/demo-handoff';

  let { children } = $props();
  // Moving between the app and a legal page uses the app's one root crossfade, never a cut.
  onNavigate(navigation => {
    if (!document.startViewTransition || matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    return new Promise(resolve => {
      document.startViewTransition(async () => { resolve(); await navigation.complete; });
    });
  });
</script>

<svelte:head>
  <title>{demoTestRecipient ? 'Bór czuwa · TEST' : import.meta.env.VITE_STAGING_BUILD ? 'Bór czuwa · staging' : 'Bór czuwa'}</title>
  {#if import.meta.env.VITE_STAGING_BUILD}<meta name="robots" content="noindex, nofollow" />{/if}
</svelte:head>

{@render children()}
