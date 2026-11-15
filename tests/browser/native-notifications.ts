import type { BrowserContext, Page } from '@playwright/test';

// A fake of the Android shell's native notifications plugin for browser journeys. It behaves as the
// phone does: a delivered reminder stays listed as pending, and scheduling without the permission
// asks for it there and then.

export type Fake = { permission: string; exact: string };

export async function android(context: BrowserContext, fake: Fake = { permission: 'granted', exact: 'granted' }) {
  await context.addInitScript((initial: Fake) => {
    const native = window as any;
    native.androidBridge = {};
    const saved = sessionStorage.getItem('fake-notifications');
    const state = saved ? JSON.parse(saved) : { ...initial, pending: [], calls: [] };
    const keep = () => sessionStorage.setItem('fake-notifications', JSON.stringify(state));
    native.fakeNotifications = state;
    native.fakeListeners = [];
    const methods = ['checkPermissions', 'requestPermissions', 'registerActionTypes', 'checkExactNotificationSetting',
      'changeExactNotificationSetting', 'getPending', 'schedule', 'cancel', 'getDeliveredNotifications',
      'removeDeliveredNotificationsById'];
    native.Capacitor = {
      PluginHeaders: [
        { name: 'LocalNotifications', methods: [...methods.map(name => ({ name, rtype: 'promise' })),
          { name: 'addListener', rtype: 'callback' }, { name: 'removeListener', rtype: 'promise' }] },
        { name: 'App', methods: [{ name: 'addListener', rtype: 'callback' }, { name: 'removeListener', rtype: 'promise' }] }
      ],
      nativeCallback: (plugin: string, method: string, options: any, callback: (data: unknown) => void) => {
        if (method === 'addListener') native.fakeListeners.push({ plugin, event: options.eventName, callback });
        return `listener-${native.fakeListeners.length}`;
      },
      nativePromise: async (plugin: string, method: string, options: any) => {
        if (plugin !== 'LocalNotifications') return {};
        state.calls.push(method);
        let result: unknown = {};
        if (method === 'checkPermissions') result = { display: state.permission };
        if (method === 'requestPermissions') { state.permission = 'granted'; result = { display: 'granted' }; }
        if (method === 'checkExactNotificationSetting') result = { exact_alarm: state.exact };
        if (method === 'getPending') result = { notifications: state.pending };
        if (method === 'getDeliveredNotifications') result = { notifications: [] };
        // Like the real plugin, scheduling without the permission puts Android's dialog up there and then.
        if (method === 'schedule' && state.permission !== 'granted') { state.calls.push('requestPermissions'); state.permission = 'granted'; }
        // Like the real plugin, an exact reminder without the exact-alarm permission is scheduled inexactly with a warning.
        if (method === 'schedule' && state.exact !== 'granted' && options.notifications.some((item: { isExactNotification?: boolean }) => item.isExactNotification !== false)) {
          result = { warning: { code: 'SCHEDULED_INEXACT' } };
        }
        if (method === 'schedule') for (const item of JSON.parse(JSON.stringify(options.notifications))) {
          state.pending = [...state.pending.filter((other: { id: number }) => other.id !== item.id), item];
        }
        if (method === 'cancel') {
          const ids = options.notifications.map((item: { id: number }) => item.id);
          state.pending = state.pending.filter((item: { id: number }) => !ids.includes(item.id));
        }
        keep();
        return result;
      }
    };
    /** What Android sends when a reminder's action or body is tapped. */
    native.tapReminder = (actionId: string, notification: unknown) => {
      for (const listener of native.fakeListeners) {
        if (listener.event === 'localNotificationActionPerformed') listener.callback({ actionId, notification });
      }
    };
  }, fake);
}

export async function seedDrafts(page: Page, drafts: object[]) {
  await page.evaluate(async items => {
    const db = await new Promise<IDBDatabase>(resolve => {
      const request = indexedDB.open('bor-czuwa');
      request.onsuccess = () => resolve(request.result);
    });
    const tx = db.transaction('drafts', 'readwrite');
    for (const item of items) tx.objectStore('drafts').put(item);
    await new Promise<void>(resolve => { tx.oncomplete = () => resolve(); });
    db.close();
  }, drafts);
}

