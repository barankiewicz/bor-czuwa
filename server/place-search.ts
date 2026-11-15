import { createHmac, randomBytes } from 'node:crypto';
import { rateAddress } from './rate-limit.ts';

type Place = { name: string; lat: number; lon: number };
type Waiter = { client: string; at: number; go: (served: boolean) => void };

const gap = 1000;
const maxWaiting = 4;
const maxWait = 3000;
// How long a client's last served time is remembered, to tell who has had fewer turns lately.
const recent = 10_000;

/**
 * One upstream request per second in total and per client. A request that cannot go now waits
 * in a short queue, where the client served longest ago goes first; past the queue or the wait
 * limit it is refused. Client keys are salted hashes held in memory only and dropped about ten
 * seconds after the client's last upstream call.
 */
export function placeSearch(fetchPlace: typeof fetch = fetch, now: () => number = Date.now,
  sleep: (ms: number) => Promise<void> = ms => new Promise(resolve => setTimeout(resolve, ms).unref())) {
  const cache = new Map<string, { at: number; places: Place[] }>();
  const salt = randomBytes(32);
  let nextRequestAt = 0;
  const lastByClient = new Map<string, number>();
  const servedAt = new Map<string, number>();
  const waiting: Waiter[] = [];
  let pumping = false;

  let sweeping = false;
  function prune() {
    for (const [client, at] of lastByClient) {
      if (now() - at < gap) break;
      lastByClient.delete(client);
    }
    for (const [client, at] of servedAt) {
      if (now() - at < recent) break;
      servedAt.delete(client);
    }
  }
  // Expiry must not wait for the next request: sweep while any key is held.
  async function sweep() {
    if (sweeping) return;
    sweeping = true;
    try {
      while (lastByClient.size || servedAt.size) { await sleep(gap); prune(); }
    } finally { sweeping = false; }
  }
  function clientReady(client: string) {
    const last = lastByClient.get(client);
    return last === undefined ? 0 : last + gap;
  }
  function take(client: string) {
    nextRequestAt = now() + gap;
    lastByClient.delete(client);
    lastByClient.set(client, now());
    servedAt.delete(client);
    servedAt.set(client, now());
    void sweep();
  }
  async function pump() {
    if (pumping) return;
    pumping = true;
    try {
      while (waiting.length) {
        prune();
        for (let i = waiting.length - 1; i >= 0; i--) {
          if (now() - waiting[i].at >= maxWait) waiting.splice(i, 1)[0].go(false);
        }
        if (!waiting.length) break;
        const ready = waiting.filter(waiter => now() >= nextRequestAt && now() >= clientReady(waiter.client));
        if (ready.length) {
          // Least recently served first (never or long ago counts as oldest); arrival order breaks ties.
          const next = ready.reduce((best, waiter) =>
            (servedAt.get(waiter.client) ?? -1) < (servedAt.get(best.client) ?? -1) ? waiter : best);
          waiting.splice(waiting.indexOf(next), 1);
          take(next.client);
          next.go(true);
          await Promise.resolve();
          continue;
        }
        const wake = Math.min(Math.max(nextRequestAt, ...[0]),
          ...waiting.map(waiter => Math.max(nextRequestAt, clientReady(waiter.client))),
          ...waiting.map(waiter => waiter.at + maxWait));
        await sleep(Math.max(1, wake - now()));
      }
    } finally { pumping = false; }
  }
  async function slot(client: string, signal?: AbortSignal) {
    prune();
    if (!waiting.length && now() >= nextRequestAt && now() >= clientReady(client)) { take(client); return true; }
    if (waiting.some(waiter => waiter.client === client)) return false;
    if (waiting.length >= maxWaiting) {
      // Full queue: the client served least recently wins. Make room by turning away the waiter
      // whose client was served most recently, but only if the newcomer has waited longer for a turn.
      const last = (who: string) => servedAt.get(who) ?? -1;
      const victim = waiting.reduce((a, b) => last(b.client) > last(a.client) ? b : a);
      if (last(client) >= last(victim.client)) return false;
      waiting.splice(waiting.indexOf(victim), 1)[0].go(false);
    }
    if (signal?.aborted) return false;
    const served = new Promise<boolean>(go => {
      const waiter: Waiter = { client, at: now(), go };
      waiting.push(waiter);
      // An abandoned search gives its queue place back at once.
      signal?.addEventListener('abort', () => {
        const index = waiting.indexOf(waiter);
        if (index >= 0) waiting.splice(index, 1)[0].go(false);
      }, { once: true });
    });
    void pump();
    return served;
  }
  const search = async (query: string, address: string, signal?: AbortSignal): Promise<{ status: number; places?: Place[] }> => {
    const text = query.trim().replace(/\s+/g, ' ');
    if (text.length < 3 || text.length > 100 || /[\r\n]/.test(query)) return { status: 400 };
    const key = text.toLocaleLowerCase('pl');
    const saved = cache.get(key);
    if (saved && now() - saved.at < 86_400_000) return { status: 200, places: saved.places };
    const client = createHmac('sha256', salt).update(rateAddress(address)).digest('hex');
    if (!await slot(client, signal)) return { status: 429 };
    try {
      const url = new URL('https://nominatim.openstreetmap.org/search');
      url.searchParams.set('q', text);
      url.searchParams.set('format', 'jsonv2');
      url.searchParams.set('countrycodes', 'pl');
      url.searchParams.set('limit', '5');
      const response = await fetchPlace(url, {
        headers: { 'User-Agent': 'BorCzuwa/0.1 (https://github.com/barankiewicz/bor-czuwa)', Accept: 'application/json' },
        signal: AbortSignal.timeout(7000)
      });
      if (!response.ok) return { status: 503 };
      const data = await response.json() as unknown;
      if (!Array.isArray(data)) return { status: 503 };
      const places = data.slice(0, 5).flatMap((item): Place[] => {
        if (!item || typeof item !== 'object') return [];
        const row = item as Record<string, unknown>;
        const lat = Number(row.lat), lon = Number(row.lon);
        return typeof row.display_name === 'string' && row.display_name.length <= 300 &&
          Number.isFinite(lat) && Number.isFinite(lon) && lat >= -90 && lat <= 90 && lon >= -180 && lon <= 180
          ? [{ name: row.display_name, lat, lon }] : [];
      });
      if (cache.size >= 200) cache.delete(cache.keys().next().value!);
      cache.set(key, { at: now(), places });
      return { status: 200, places };
    } catch { return { status: 503 }; }
  };
  return Object.assign(search, { tracked: () => new Set([...lastByClient.keys(), ...servedAt.keys(), ...waiting.map(waiter => waiter.client)]).size });
}
