import type { Page } from '@playwright/test';

/**
 * Waits until the service worker controls the page and holds every offline group: the capture
 * shell, the authority directory and the PDF engine. The last two download after installation.
 */
export async function untilOfflineReady(page: Page) {
  await page.evaluate(async () => {
    const worker = (await navigator.serviceWorker.ready).active!;
    if (!navigator.serviceWorker.controller) {
      await new Promise<void>(resolve => navigator.serviceWorker.addEventListener('controllerchange', () => resolve(), { once: true }));
    }
    await new Promise<void>(resolve => {
      const check = (event: MessageEvent) => {
        if (event.data?.type !== 'offline-status') return;
        if (Object.values(event.data.status).every(state => state === 'ready')) {
          navigator.serviceWorker.removeEventListener('message', check);
          resolve();
        } else setTimeout(() => worker.postMessage({ type: 'offline-status' }), 100);
      };
      navigator.serviceWorker.addEventListener('message', check);
      worker.postMessage({ type: 'offline-status' });
    });
  });
}
