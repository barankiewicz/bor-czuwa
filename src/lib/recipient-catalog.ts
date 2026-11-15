import gminy from '../../data/authority-directory/gminy.json?url';
import police from '../../data/authority-directory/police.json?url';
import regional from '../../data/authority-directory/regional.json?url';
import parks from '../../data/authority-directory/parks.json?url';
import { createRecipientCatalog, type RecipientCatalog, type RecipientUnit } from './recipient-resolver';

/**
 * The directory files are about 1.2 MB, so capture starts without them. They are hashed build
 * assets: the service worker precaches them with the rest of the build and the Android app bundles
 * them, so an installed app loads them offline. A failed load rejects, and calling again refetches.
 */
let loading: Promise<RecipientCatalog> | undefined;
export function loadRecipientCatalog() {
  loading ??= Promise.all([police, regional, parks, gminy].map(async url => {
    const response = await fetch(url);
    if (!response.ok) throw new Error('catalog_unavailable');
    return (await response.json() as { units: RecipientUnit[] }).units;
  })).then(parts => createRecipientCatalog(parts.flat()), cause => { loading = undefined; throw cause; });
  return loading;
}
