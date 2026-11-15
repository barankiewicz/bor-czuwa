<script lang="ts">
  import LegalPage from '$lib/LegalPage.svelte';
  import source from '$lib/legal/v1/terms.md?raw';
  import { demoTestRecipient } from '$lib/demo-handoff';
</script>

<svelte:head><title>{demoTestRecipient ? 'Prywatny test · Regulamin serwisu · Bór czuwa' : import.meta.env.VITE_STAGING_BUILD ? 'Regulamin serwisu · Bór czuwa · staging' : 'Regulamin serwisu · Bór czuwa'}</title></svelte:head>
<LegalPage {source} />
