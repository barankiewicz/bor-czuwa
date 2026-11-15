import { browser } from '$app/environment';
import { holdsWork, readJourney } from '$lib/journey-navigation';
import { startWaitingUpdate } from '$lib/offline-readiness';

let started = false;

// Runs before the first screen is drawn, so a waiting update starts without showing the old version.
// Only a document's first load is a start; any later run of this load happens in a live tab.
export async function load({ url }) {
  if (!browser || started) return;
  started = true;
  if (!holdsWork(readJourney(url))) await startWaitingUpdate();
}
