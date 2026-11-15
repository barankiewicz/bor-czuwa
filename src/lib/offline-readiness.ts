import { version } from '$app/environment';

export type OfflineGroup = 'shell' | 'catalog' | 'pdf';
export type OfflineState = 'ready' | 'loading' | 'missing';
export type OfflineStatus = Record<OfflineGroup, OfflineState>;

const allMissing: OfflineStatus = { shell: 'missing', catalog: 'missing', pdf: 'missing' };

/**
 * Follows what the service worker has stored for use without a network. The capture shell installs
 * on its own; the authority directory and the PDF engine download after it and can fail alone.
 * `prepare` fetches whatever is missing and, after a failed installation, registers the worker again.
 * The Android app bundles every file, so it is always ready.
 *
 * A new version installs beside the running one and waits. `updated` reports that one is ready, or
 * that another tab already started it while this one still runs the old code. A running tab never
 * reloads by itself: `restart`, which the Reporter asks for, activates it and reloads, and otherwise
 * `startWaitingUpdate` starts it at the next idle cold start.
 */
/**
 * Called at a cold start that opens no Draft or Notice, before anything is drawn. A waiting version
 * takes over only when this is the app's one open window, and the page then reloads into it, so the
 * Reporter first sees the new version and no running tab changes under them. Resolves false when
 * there is nothing to start; when it starts one, it never resolves, as the page is about to reload.
 */
export async function startWaitingUpdate() {
  if (!('serviceWorker' in navigator)) return false;
  const container = navigator.serviceWorker;
  const next = (await container.getRegistration().catch(() => undefined))?.waiting;
  if (!next) return false;
  // Listening first: the worker skips waiting as soon as it has answered.
  const controlled = new Promise(resolve => container.addEventListener('controllerchange', resolve, { once: true }));
  // A waiting worker from before this message existed never answers, and the start goes on.
  const alone = await new Promise<boolean>(resolve => {
    const channel = new MessageChannel();
    const timer = setTimeout(() => resolve(false), 1500);
    channel.port1.onmessage = event => { clearTimeout(timer); resolve(event.data === true); };
    next.postMessage({ type: 'activate-if-alone' }, [channel.port2]);
  });
  if (!alone) return false;
  await Promise.race([controlled, new Promise(resolve => setTimeout(resolve, 5000))]);
  // A version that never activated keeps waiting; reloading would only ask again on every start.
  if ((await container.getRegistration().catch(() => undefined))?.waiting === next) return false;
  location.reload();
  return new Promise<never>(() => {});
}

export function watchOfflineReadiness(bundled: boolean, update: (status: OfflineStatus) => void,
  updated: (ready: boolean) => void) {
  if (bundled || !('serviceWorker' in navigator)) {
    update(bundled ? { shell: 'ready', catalog: 'ready', pdf: 'ready' } : allMissing);
    return { prepare: async () => {}, restart: async () => {}, stop() {} };
  }
  const container = navigator.serviceWorker;
  const watched = new WeakSet<ServiceWorker | ServiceWorkerRegistration>();
  let waiting = false;
  let olderThanWorker = false;
  const report = () => updated(waiting || olderThanWorker);
  const onMessage = (event: MessageEvent) => {
    // The worker asks before removing an older version's files.
    if (event.data?.type === 'app-version') event.ports[0]?.postMessage({ version });
    if (event.data?.type === 'offline-status') {
      update(event.data.status);
      olderThanWorker = !!event.data.version && event.data.version !== version;
      report();
    }
  };
  // A newly activated worker, first install or update, takes over here and is asked to fill its groups.
  const onController = () => { void prepare(); };
  container.addEventListener('message', onMessage);
  container.addEventListener('controllerchange', onController);
  let stopped = false;
  function follow(registration: ServiceWorkerRegistration, next: ServiceWorker) {
    if (watched.has(next)) return;
    watched.add(next);
    const changed = () => {
      if (next.state === 'redundant' && !registration.active) update(allMissing);
      waiting = !!registration.active && registration.waiting === next;
      report();
    };
    next.addEventListener('statechange', changed);
    changed();
  }
  async function prepare() {
    const registration = await container.register('/service-worker.js').catch(() => undefined);
    if (stopped) return;
    const installing = registration?.installing ?? registration?.waiting;
    // An older active worker keeps serving its own complete shell while an update installs.
    if (registration?.active) registration.active.postMessage({ type: 'offline-prepare' });
    else update({ ...allMissing, shell: installing ? 'loading' : 'missing' });
    if (registration && installing) follow(registration, installing);
    if (registration && !watched.has(registration)) {
      watched.add(registration);
      registration.addEventListener('updatefound', () => { if (registration.installing) follow(registration, registration.installing); });
    }
  }
  async function restart() {
    const next = (await container.getRegistration())?.waiting;
    if (next) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const activated = new Promise(resolve => {
        container.addEventListener('controllerchange', resolve, { once: true });
        timer = setTimeout(resolve, 10_000);
      });
      next.postMessage({ type: 'activate-update' });
      await activated;
      clearTimeout(timer);
    }
    location.reload();
  }
  return { prepare, restart, stop() {
    stopped = true;
    container.removeEventListener('message', onMessage);
    container.removeEventListener('controllerchange', onController);
  } };
}
