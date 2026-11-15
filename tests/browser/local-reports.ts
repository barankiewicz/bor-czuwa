import type { Page } from '@playwright/test';

/** Every row of one of the page's IndexedDB stores, read the way the app stores them. */
function localRows(page: Page, store: 'reports' | 'withdrawals') {
  return page.evaluate(name => new Promise<any[]>((resolve, reject) => {
    const request = indexedDB.open('bor-czuwa');
    request.onsuccess = () => {
      const db = request.result;
      const rows = db.transaction(name).objectStore(name).getAll();
      rows.onsuccess = () => { db.close(); resolve(rows.result); };
      rows.onerror = () => { db.close(); reject(rows.error); };
    };
    request.onerror = () => reject(request.error);
  }), store);
}

/** Every Report the phone holds. */
export const localReports = (page: Page) => localRows(page, 'reports');

/** Every Withdrawal still waiting for the server to confirm it. */
export const localWithdrawals = (page: Page) => localRows(page, 'withdrawals');

/** One stored Report by its ID, or undefined once it has left the phone. */
export async function localReport(page: Page, id: string) {
  return (await localReports(page)).find(row => row.report.id === id);
}
