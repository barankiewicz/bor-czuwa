<script lang="ts">
  import LegalPage from '$lib/LegalPage.svelte';
  import source from '$lib/legal/v1/privacy.md?raw';
  import { demoTestRecipient } from '$lib/demo-handoff';
</script>

<svelte:head><title>{demoTestRecipient ? 'Prywatny test · Polityka prywatności · Bór czuwa' : import.meta.env.VITE_STAGING_BUILD ? 'Polityka prywatności · Bór czuwa · staging' : 'Polityka prywatności · Bór czuwa'}</title></svelte:head>
<LegalPage {source} />
