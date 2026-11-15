// Prints, as JSON, the exact URL the page-opening count script requests for each of the ten
// pages, by running the real script from files.ts in a stub browser. tests/test_stats_proxy.py
// posts these strings to nginx, so the two halves of the count are tested against each other.
import vm from 'node:vm';
import { countScript } from '../src/lib/files.ts';
import { paths } from '../src/lib/copy.ts';
import { site } from '../src/lib/site.ts';

const urls: Record<string, string> = {};
for (const page of Object.values(paths)) for (const pathname of Object.values(page)) {
  vm.runInNewContext(countScript(), {
    location: { origin: site.url, pathname },
    navigator: { onLine: true },
    fetch: (url: string) => { urls[pathname] = url; return Promise.resolve(); }
  });
}
console.log(JSON.stringify(urls));
