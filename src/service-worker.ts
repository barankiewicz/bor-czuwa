/// <reference lib="webworker" />
import { build, files, version } from '$service-worker';
import type { Manifest } from 'vite';
import type { OfflineGroup, OfflineStatus } from '$lib/offline-readiness';

const worker = self as unknown as ServiceWorkerGlobalScope;

// Kit writes the client manifest before it builds this worker. The glob is empty in dev.
const manifest = Object.values(import.meta.glob<Manifest>('/.svelte-kit/output/client/.vite/manifest.json',
  { eager: true, import: 'default' }))[0] ?? {};
const asPath = (file: string) => `/${file}`;
const catalog = Object.entries(manifest).filter(([source]) => source.startsWith('data/authority-directory/'))
  .map(([, chunk]) => asPath(chunk.file));
const pdfEngine = Object.entries(manifest).find(([source]) => source === 'src/lib/notice-pdf.ts')?.[1];
const pdf = [...(pdfEngine ? [asPath(pdfEngine.file)] : []), '/fonts/NotoSans-Regular.ttf'];
const optional = new Set([...catalog, ...pdf]);
// The link-preview image is for other sites' crawlers, never for a Reporter offline.
const online = new Set(['/brand/share-1200x630.png']);
// Capture must not wait for the directory or the PDF engine.
const shell = [...build, ...files].filter(path => !optional.has(path) && !online.has(path))
  .concat(import.meta.env.VITE_BUILD_CONFIGURATION_PATH, '/', '/legal/privacy/v1/', '/legal/terms/v1/');
const groups: Record<OfflineGroup, string[]> = { shell, catalog, pdf };
const groupNames = Object.keys(groups) as OfflineGroup[];
const downloads = ['catalog', 'pdf'] as const;
const downloadOf = new Map(downloads.flatMap(group => groups[group].map(path => [path, group] as const)));
const cacheName = (group: OfflineGroup) => `app-${version}-${group}`;
const current = new Set(groupNames.map(cacheName));
const filling: Partial<Record<OfflineGroup, Promise<void>>> = {};

worker.addEventListener('install', event => {
  event.waitUntil((async () => {
    await (await caches.open(cacheName('shell'))).addAll(shell);
    // Hashed files kept by the previous version are the same bytes, so an update reuses them.
    for (const group of downloads) {
      const cache = await caches.open(cacheName(group));
      for (const path of groups[group]) {
        const kept = await caches.match(path);
        if (kept) await cache.put(path, kept);
      }
    }
    // An update also fetches what it could not reuse, so a restart made offline keeps the directory
    // and the PDF. A file that fails stays missing and the group says so; the install goes on.
    if (worker.registration.active) await Promise.all(downloads.map(store));
    // An older worker's cleanup can delete a cache while this one installs. Failing here retries the
    // install on the next update check instead of activating without a shell.
    if ((await missing('shell')).length) throw new Error('shell_incomplete');
    // An update waits: open tabs keep their version until the next idle cold start or a restart.
  })());
});
worker.addEventListener('activate', event => {
  event.waitUntil((async () => {
    await worker.clients.claim();
    await removeUnusedVersions();
  })());
});

// Each open tab says which version it runs. A tab that does not answer, still loading or from before
// this worker, might need any older file, so nothing is removed until every tab has answered.
async function versionsInUse() {
  const windows = await worker.clients.matchAll({ type: 'window', includeUncontrolled: true });
  const answers = await Promise.all(windows.map(client => new Promise<string | undefined>(resolve => {
    const channel = new MessageChannel();
    const timer = setTimeout(() => resolve(undefined), 2000);
    channel.port1.onmessage = event => { clearTimeout(timer); resolve(event.data?.version); };
    client.postMessage({ type: 'app-version' }, [channel.port2]);
  })));
  return answers.every(Boolean) ? new Set([version, ...answers as string[]]) : undefined;
}
// An update being installed or waiting has caches this worker does not know, so it removes nothing then.
const updatePending = () => !!(worker.registration.installing || worker.registration.waiting);
async function removeUnusedVersions() {
  if (updatePending()) return;
  const used = await versionsInUse();
  if (!used) return;
  for (const key of await caches.keys()) {
    const kept = /^app-(.+)-(shell|catalog|pdf)$/.exec(key)?.[1];
    if (updatePending()) return;
    if (kept && !used.has(kept)) await caches.delete(key);
  }
}
// This version's files first; an older tab's lazy imports can come from its own version's caches.
async function stored(request: Request | string, anyVersion: boolean) {
  for (const name of current) {
    const found = await caches.match(request, { cacheName: name });
    if (found) return found;
  }
  return anyVersion ? caches.match(request) : undefined;
}

async function missing(group: OfflineGroup) {
  const cache = await caches.open(cacheName(group));
  const found = await Promise.all(groups[group].map(path => cache.match(path)));
  return groups[group].filter((_, index) => !found[index]);
}
async function status(): Promise<OfflineStatus> {
  const entries = await Promise.all(groupNames.map(async group =>
    [group, filling[group] ? 'loading' : (await missing(group)).length ? 'missing' : 'ready'] as const));
  return Object.fromEntries(entries) as OfflineStatus;
}
async function announce() {
  const message = { type: 'offline-status', status: await status(), version };
  for (const client of await worker.clients.matchAll({ includeUncontrolled: true })) client.postMessage(message);
}
// Each file is stored as it arrives, so an interrupted download resumes with what is still missing.
async function store(group: typeof downloads[number]) {
  const cache = await caches.open(cacheName(group));
  for (const path of await missing(group)) {
    const response = await fetch(path).catch(() => undefined);
    // A failed write, such as a full quota, leaves the file missing and the group says so.
    if (response?.ok) await cache.put(path, response).catch(() => {});
  }
}
function fill(group: typeof downloads[number]) {
  return filling[group] ??= store(group).finally(() => { delete filling[group]; void announce(); });
}

worker.addEventListener('message', event => {
  if (event.data?.type === 'offline-status') event.waitUntil(announce());
  if (event.data?.type === 'offline-prepare') {
    event.waitUntil((async () => {
      await announce();
      const needsFiles = await Promise.all(downloads.map(async group => (await missing(group)).length > 0));
      const work = downloads.filter((_, index) => needsFiles[index]).map(fill);
      await announce();
      await Promise.all([...work, removeUnusedVersions()]);
    })());
  }
  if (event.data?.type === 'activate-update') event.waitUntil(worker.skipWaiting());
  // A cold start asks the waiting version to take over. Any other open window may hold work, so
  // the update keeps waiting while one exists.
  if (event.data?.type === 'activate-if-alone') {
    event.waitUntil((async () => {
      const alone = (await worker.clients.matchAll({ type: 'window', includeUncontrolled: true })).length <= 1;
      // Answered first: skipping resolves only once this version has activated.
      event.ports[0]?.postMessage(alone);
      if (alone) await worker.skipWaiting();
    })());
  }
});
worker.addEventListener('fetch', event => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'GET' || url.origin !== worker.location.origin || url.pathname.startsWith('/api/')) return;
  event.respondWith((async () => {
    const navigation = event.request.mode === 'navigate';
    const cached = await stored(navigation && url.pathname === '/' ? '/' : event.request, !navigation);
    if (cached) return cached;
    const response = await fetch(event.request);
    const group = downloadOf.get(url.pathname);
    if (group && response.ok) {
      const copy = response.clone();
      event.waitUntil(caches.open(cacheName(group)).then(cache => cache.put(url.pathname, copy)).then(announce));
    }
    return response;
  })());
});
