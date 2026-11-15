import { test, expect, type Page } from '@playwright/test';
import { answerNow, leaveCompass } from './stages.ts';

test.use({ serviceWorkers: 'block' });
const note = 'Zapis przed odejściem';

async function openNote(page: Page) {
  await page.goto('/');
  await page.getByRole('button', { name: 'Strzał', exact: true }).click();
  await answerNow(page);
  await leaveCompass(page);
  await page.locator('summary', { hasText: 'Notatka' }).click();
  await expect(page.getByLabel('Co jeszcze chcesz przekazać?')).toBeVisible();
}

type DraftBlockerWindow = Window & typeof globalThis & {
  navigationHold: {
    targeted: boolean;
    held: boolean;
    deadlineExpired: boolean;
    releasedOnTrustedPagehide: boolean;
    failure?: string;
  };
  releaseDraftBlocker(): void;
};

async function holdDraftStore(page: Page, id: string) {
  await page.evaluate(id => {
    const native = window as DraftBlockerWindow;
    const state: DraftBlockerWindow['navigationHold'] = {
      targeted: false, held: false, deadlineExpired: false, releasedOnTrustedPagehide: false
    };
    native.navigationHold = state;
    const retain = () => sessionStorage.setItem('draft-navigation-hold', JSON.stringify(state));
    const { promise, resolve, reject } = (Promise as PromiseConstructor & {
      withResolvers<T>(): { promise: Promise<T>; resolve(value: T): void; reject(reason: unknown): void };
    }).withResolvers<void>();
    const put = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function (...args: Parameters<typeof put>) {
      const request = put.apply(this, args);
      if (this.name === 'drafts' && args[0]?.id === id && !state.targeted) {
        state.targeted = true;
        retain();
      }
      return request;
    };
    // A store reads the Draft before it puts it, in the same transaction; that read is queued behind the blocker too.
    const get = IDBObjectStore.prototype.get;
    IDBObjectStore.prototype.get = function (...args: Parameters<typeof get>) {
      const request = get.apply(this, args);
      if (this.name === 'drafts' && this.transaction.mode === 'readwrite' && args[0] === id && !state.targeted) {
        state.targeted = true;
        retain();
      }
      return request;
    };
    const request = indexedDB.open('bor-czuwa');
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const db = request.result, transaction = db.transaction('drafts', 'readwrite');
      const store = transaction.objectStore('drafts');
      let released = false;
      const release = () => {
        if (released) return;
        released = true;
        clearTimeout(timer);
        transaction.abort();
      };
      const timer = setTimeout(() => {
        state.deadlineExpired = true;
        retain();
        release();
      }, 10_000);
      native.releaseDraftBlocker = release;
      transaction.onabort = () => {
        db.close();
        if (!released) {
          state.failure = transaction.error?.name ?? 'Unexpected blocker abort';
          retain();
          reject(transaction.error);
        }
      };
      transaction.oncomplete = () => {
        db.close();
        state.failure = 'Blocker completed before release';
        retain();
        reject(new Error(state.failure));
      };
      const keepAlive = () => {
        if (released) return;
        const read = store.getKey(id);
        read.onsuccess = () => {
          if (!state.held) { state.held = true; retain(); resolve(undefined); }
          keepAlive();
        };
        read.onerror = () => {
          if (released) return;
          state.failure = read.error?.name ?? 'Blocker read failed';
          retain();
          reject(read.error);
        };
      };
      window.addEventListener('pagehide', event => {
        if (!event.isTrusted || released) return;
        state.releasedOnTrustedPagehide = true;
        retain();
        release();
      }, true);
      keepAlive();
    };
    return promise;
  }, id);
}

test('real navigation preserves the same Draft note before application hydration', async ({ page, context }) => {
  await context.setGeolocation({ latitude: 53.4, longitude: 22.8, accuracy: 12 });
  await openNote(page);
  const id = new URL(page.url()).searchParams.get('draft')!;
  const captured = await page.locator('#when-row .value').textContent();
  const capturedAt = await page.evaluate(id => new Promise<string>((resolve, reject) => {
    const request = indexedDB.open('bor-czuwa');
    request.onsuccess = () => {
      const db = request.result, read = db.transaction('drafts').objectStore('drafts').get(id);
      read.onsuccess = () => { resolve(read.result.capturedAt); db.close(); };
      read.onerror = () => reject(read.error);
    };
    request.onerror = () => reject(request.error);
  }), id);
  await page.route('**/__draft_storage_probe.html?*', route => route.fulfill({
    contentType: 'text/html', body: `<!doctype html><meta charset="utf-8"><script>
      const request = indexedDB.open('bor-czuwa');
      request.onsuccess = () => {
        const db = request.result, transaction = db.transaction('drafts', 'readonly');
        const read = transaction.objectStore('drafts').get(new URL(location.href).searchParams.get('id'));
        read.onsuccess = () => window.rawDraft = read.result;
        transaction.oncomplete = () => { db.close(); window.probeComplete = true; };
      };
    </script>`
  }));
  const destination = new URL('/__draft_storage_probe.html?id=' + encodeURIComponent(id), page.url()).href;
  await page.getByLabel('Co jeszcze chcesz przekazać?').fill(note);
  // A real document navigation follows immediately, with no save/read/wait in between.
  await page.goto(destination);
  await expect.poll(() => page.evaluate(() => (window as any).probeComplete === true)).toBe(true);
  const raw = await page.evaluate(() => (window as any).rawDraft);
  expect(raw.id).toBe(id);
  expect(raw.note).toBe(note);
  expect(raw.capturedAt).toBe(capturedAt);
  await page.goto('/');
  await page.getByRole('button', { name: 'Moje zapisy', exact: true }).click();
  await page.getByRole('button', { name: /^Dokończ zgłoszenie/ }).click();
  await expect(page.locator('#when-row .value')).toHaveText(captured ?? '');
  await expect(page.getByLabel('Co jeszcze chcesz przekazać?')).toHaveValue(note);
});

test.describe('with a diagnostic native reader', () => {
  test.use({ serviceWorkers: 'allow' });
  // These fields belong to this native fixture and its otherwise empty reader document.
  type NavigationWindow = DraftBlockerWindow & {
    probeComplete?: boolean;
    probeError?: unknown;
    rawDraft?: { id?: unknown; capturedAt?: unknown; note?: unknown };
    nativeHold?: unknown;
    applicationHydrated?: boolean;
  };

  test('leaving behind an earlier native Draft transaction retains the latest note before hydration', async ({ page, context }) => {
    await context.setGeolocation({ latitude: 53.4, longitude: 22.8, accuracy: 12 });
    await openNote(page);
    const id = new URL(page.url()).searchParams.get('draft')!;
    const captured = await page.locator('#when-row .value').textContent();
    const capturedAt = await page.evaluate(id => {
      // This reader runs in current Playwright Chromium; keep its ES2024 API typing local.
      const { promise, resolve, reject } = (Promise as PromiseConstructor & {
        withResolvers<T>(): { promise: Promise<T>; resolve(value: T): void; reject(reason: unknown): void };
      }).withResolvers<string>();
      const request = indexedDB.open('bor-czuwa');
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        const db = request.result, transaction = db.transaction('drafts', 'readonly');
        const read = transaction.objectStore('drafts').get(id);
        let capturedAt: string;
        read.onsuccess = () => { capturedAt = read.result.capturedAt; };
        transaction.oncomplete = () => { db.close(); resolve(capturedAt); };
        transaction.onabort = () => { db.close(); reject(transaction.error); };
      };
      return promise;
    }, id);
    await holdDraftStore(page, id);
    // Start the preceding no-note transaction through the ready form, not initial capture.
    await page.locator('#home-check').getByRole('button', { name: 'Nie', exact: true }).click();
    await expect.poll(() => page.evaluate(() => {
      const state = (window as NavigationWindow).navigationHold;
      return state.held && state.targeted;
    })).toBe(true);
    // Replace the actual reload response so storage is read before application hydration.
    await page.route(page.url(), route => route.fulfill({
      contentType: 'text/html', body: `<!doctype html><meta charset="utf-8"><script>
        window.applicationHydrated = false;
        const request = indexedDB.open('bor-czuwa');
        request.onerror = () => window.probeError = request.error.name;
        request.onsuccess = () => {
          const db = request.result, transaction = db.transaction('drafts', 'readonly');
          const read = transaction.objectStore('drafts').get(${JSON.stringify(id)});
          read.onsuccess = () => window.rawDraft = read.result;
          transaction.onabort = () => { db.close(); window.probeError = transaction.error?.name; };
          transaction.oncomplete = () => {
            db.close();
            window.nativeHold = JSON.parse(sessionStorage.getItem('draft-navigation-hold'));
            window.probeComplete = true;
          };
        };
      </script>`
    }), { times: 1 });
    const transport = await context.newCDPSession(page);
    await transport.send('Network.enable');
    try {
      // Target-wide bypass covers input through the raw read; registration remains untouched.
      await transport.send('Network.setBypassServiceWorker', { bypass: true });
      await page.getByLabel('Co jeszcze chcesz przekazać?').fill(note);
      // No read, assertion, sleep or commit wait occurs between the edit and actual navigation.
      await page.reload();
      await expect.poll(() => page.evaluate(() => {
        const native = window as NavigationWindow;
        return !!native.probeComplete || !!native.probeError;
      })).toBe(true);
      const proof = await page.evaluate(() => {
        const native = window as NavigationWindow;
        return { raw: native.rawDraft, hold: native.nativeHold, error: native.probeError, hydrated: native.applicationHydrated };
      });
      expect(proof.error).toBeUndefined();
      expect(proof.hydrated).toBe(false);
      expect(proof.hold).toEqual({ targeted: true, held: true, deadlineExpired: false, releasedOnTrustedPagehide: true });
      expect(proof.raw?.id).toBe(id);
      expect(proof.raw?.capturedAt).toBe(capturedAt);
      expect(proof.raw?.note).toBe(note);
    } finally {
      await transport.send('Network.setBypassServiceWorker', { bypass: false });
      await transport.detach();
    }
    await page.goto('/');
    await page.getByRole('button', { name: 'Moje zapisy', exact: true }).click();
    await page.getByRole('button', { name: /^Dokończ zgłoszenie/ }).click();
    await expect(page.locator('#when-row .value')).toHaveText(captured ?? '');
    await expect(page.getByLabel('Co jeszcze chcesz przekazać?')).toHaveValue(note);
  });
});

test('finish later waits for native commit before leaving and announcing saved state', async ({ page, context }) => {
  await context.setGeolocation({ latitude: 53.4, longitude: 22.8, accuracy: 12 });
  await openNote(page);
  const id = new URL(page.url()).searchParams.get('draft')!;
  await holdDraftStore(page, id);
  await page.evaluate(() => {
    const native = window as any;
    native.draftCommitted = false;
    native.requiredNote = 'Zapis przed odejściem';
    native.earlySavedConfirmation = false;
    const put = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function (...args: Parameters<typeof put>) {
      const request = put.apply(this, args);
      if (this.name === 'drafts' && args[0]?.note) {
        const transaction = this.transaction;
        transaction.addEventListener('complete', () => { native.draftCommitted = true; native.lastCommittedNote = args[0].note; }, { once: true });
      }
      return request;
    };
    new MutationObserver(() => {
      if (document.querySelector('.brief-confirmation')?.textContent?.includes('Zapisane na telefonie.') && native.lastCommittedNote !== native.requiredNote) native.earlySavedConfirmation = true;
    }).observe(document.body, { subtree: true, childList: true, characterData: true });
  });
  await page.getByLabel('Co jeszcze chcesz przekazać?').fill(note);
  await page.getByRole('button', { name: 'Dokończę później', exact: true }).click();
  await expect.poll(() => page.evaluate(() => {
    const state = (window as DraftBlockerWindow).navigationHold;
    return state.held && state.targeted;
  })).toBe(true);
  await expect(page.getByRole('heading', { name: 'Sprawdź i zapisz', exact: true })).toBeVisible();
  await expect(page.getByText('Zapisane na telefonie. Dokończysz, kiedy zechcesz.', { exact: true })).toHaveCount(0);
  await page.evaluate(() => { (window as any).requiredNote = 'Dopisana notatka podczas zapisu'; });
  await page.getByLabel('Co jeszcze chcesz przekazać?').fill('Dopisana notatka podczas zapisu');
  await page.evaluate(() => (window as DraftBlockerWindow).releaseDraftBlocker());
  await expect(page.getByRole('heading', { name: 'Co się stało?', exact: true })).toBeVisible();
  await expect(page.locator('.brief-confirmation')).toContainText('Zapisane na telefonie. Dokończysz, kiedy zechcesz.');
  await expect(page.getByRole('status').filter({ hasText: 'Zapisane na telefonie. Dokończysz, kiedy zechcesz.' })).toHaveCount(1);
  expect(await page.evaluate(() => (window as any).earlySavedConfirmation)).toBe(false);
  expect(await page.evaluate(() => (window as any).lastCommittedNote)).toBe('Dopisana notatka podczas zapisu');
  const held = await page.evaluate(() => (window as DraftBlockerWindow).navigationHold);
  expect(held.deadlineExpired).toBe(false);
  expect(held.failure).toBeUndefined();
});

test('finish later retains the note and error when storage fails, then retries without claiming success early', async ({ page, context }) => {
  await context.setGeolocation({ latitude: 53.4, longitude: 22.8, accuracy: 12 });
  await openNote(page);
  await page.evaluate(() => {
    const native = window as any;
    native.refuseDraftWrite = true;
    const put = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function (...args: Parameters<typeof put>) {
      if (this.name === 'drafts' && args[0]?.note && native.refuseDraftWrite) throw new DOMException('probe quota refusal', 'QuotaExceededError');
      return put.apply(this, args);
    };
  });
  await page.getByLabel('Co jeszcze chcesz przekazać?').fill(note);
  await page.getByRole('button', { name: 'Dokończę później', exact: true }).click();
  await expect(page.getByRole('alert')).toHaveText('Brak miejsca na urządzeniu. Zwolnij miejsce i spróbuj ponownie.');
  await expect(page.getByRole('heading', { name: 'Sprawdź i zapisz', exact: true })).toBeVisible();
  await expect(page.getByLabel('Co jeszcze chcesz przekazać?')).toHaveValue(note);
  await expect(page.getByText('Zapisane na telefonie. Dokończysz, kiedy zechcesz.', { exact: true })).toHaveCount(0);
  await page.evaluate(() => { (window as any).refuseDraftWrite = false; });
  await page.getByRole('button', { name: 'Dokończę później', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Co się stało?', exact: true })).toBeVisible();
  await page.reload();
  await page.getByRole('button', { name: 'Moje zapisy', exact: true }).click();
  await page.getByRole('button', { name: /^Dokończ zgłoszenie/ }).click();
  await expect(page.getByLabel('Co jeszcze chcesz przekazać?')).toHaveValue(note);
});
