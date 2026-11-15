import { test, expect, type BrowserContext, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { clockedGeolocation, finishFromWhen } from './stages.ts';
import { localReports } from './local-reports.ts';
import { testDatabaseUrl } from '../helpers/test-database.ts';
import { loseReports } from '../helpers/server-loss.ts';

// Against the real API and a disposable PostGIS: the server loses a Report it already
// measured, and only the phone's copy can bring it back.
const stored = localReports;

/** Captures a Report through the real API and waits until the phone holds its terminal Findings. */
async function measuredReport(page: Page, context: BrowserContext) {
  await clockedGeolocation(page);
  await context.setGeolocation({ latitude: 52, longitude: 21, accuracy: 8 });
  await page.goto('/');
  await page.getByRole('button', { name: 'Człowiek z bronią', exact: true }).click();
  await finishFromWhen(page, false);
  await page.getByRole('button', { name: 'Zapisz zgłoszenie' }).click();
  await expect(page.getByText('Zapisano na serwerze.', { exact: true })).toBeVisible({ timeout: 30_000 });
  await expect.poll(async () => (await stored(page))[0]?.findings.status, { timeout: 60_000 }).not.toBe('pending');
  return (await stored(page))[0];
}

// One journey, so the suite spends two accepted writes of the 50-per-day budget here: the
// capture and the re-upload (a replay of a stored ID costs nothing).
test('reopening the app re-saves a measured Report a restored database lost, also when the phone stops after the server commits', async ({ page, context }) => {
  const before = await measuredReport(page, context);
  const id = before.report.id as string;
  const database = new Client({ connectionString: testDatabaseUrl() });
  await database.connect();
  try {
    // A restore from a backup taken before this Report arrived.
    await loseReports(database, [id]);
    // Reopening finds the loss and uploads again. The upload commits on the server, and the
    // phone stops before it hears the answer.
    let committed!: (status: number) => void;
    const commit = new Promise<number>(resolve => { committed = resolve; });
    await page.route('**/api/reports', async route => {
      const response = await route.fetch();
      committed(response.status());
    });
    await page.reload();
    expect(await commit).toBe(201);
    expect((await database.query('SELECT token_sha256 FROM report WHERE id = $1', [id])).rows[0]?.token_sha256).toBe(before.report.token_sha256);
    expect((await stored(page))[0].server_lost).toBe(true);
    // Stop the app before releasing the held request, so its answer can never reach this page.
    await page.goto('about:blank');
    await page.unroute('**/api/reports');
    const answers: number[] = [];
    page.on('response', response => { if (response.url().endsWith('/api/reports') && response.request().method() === 'POST') answers.push(response.status()); });
    await page.goto(`/?screen=report&report=${id}`);
    await page.getByRole('heading', { name: 'Zgłoszenie', exact: true }).waitFor();
    await expect(page.getByRole('status').filter({ hasText: /^Zapisano na serwerze\./ })).toBeVisible({ timeout: 30_000 });
    // The restarted phone uploads once more and the server answers it as a replay.
    await expect.poll(() => answers).toEqual([200]);
    const rows = await database.query(`SELECT r.token_sha256, (SELECT count(*)::int FROM report_event e WHERE e.report_id = r.id AND e.kind = 'created') AS created
      FROM report r WHERE r.id = $1`, [id]);
    expect(rows.rows).toEqual([{ token_sha256: before.report.token_sha256, created: 1 }]);
    const [after] = await stored(page);
    expect(after.report).toEqual(before.report);
    expect(after.token).toBe(before.token);
    expect(after.findings).toEqual(before.findings);
    expect(after.server_lost).toBeUndefined();
  } finally { await database.end(); }
});

// The ticket's own reproduction: Findings computed AND every Notice event already delivered, so
// nothing the phone sends by itself would ever meet the loss. Only the launch presence check does.
test('a lost Report whose Notice events all arrived is found on reopening and gets them back once each, in order', async ({ page, context }) => {
  const before = await measuredReport(page, context);
  const id = before.report.id as string;
  const noticeId = randomUUID();
  const common = { notice_id: noticeId, recipient_kind: 'police', unit_id: 'e7ffa23f-0186-4570-bbe4-91203d78864b',
    template_version: 'placeholder-2026-09-25', directory_version: '2026-09-24', at: '2026-10-05T10:05:00+02:00' };
  const events = ['notice_composed', 'handed_to_mail_client', 'confirmed_by_reporter'].map(kind => ({ ...common, id: randomUUID(), kind }));
  const outcome = { id: randomUUID(), kind: 'outcome_reported', notice_id: noticeId, recipient_kind: 'police',
    unit_id: common.unit_id, outcome: 'no_answer_yet', observed_on: '2026-10-05', at: '2026-10-05T10:06:00+02:00' };
  const database = new Client({ connectionString: testDatabaseUrl() });
  await database.connect();
  try {
    for (const item of [...events, outcome]) {
      const sent = await page.request.post(`/api/reports/${id}/events`, { data: item, headers: { authorization: `Bearer ${before.token}` } });
      expect(sent.status()).toBe(201);
    }
    // The phone records the same events as delivered, the state a normal send leaves behind.
    await page.evaluate(async ({ reportId, notice }) => {
      const request = indexedDB.open('bor-czuwa');
      const db = await new Promise<IDBDatabase>((resolve, reject) => { request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
      const store = db.transaction('reports', 'readwrite').objectStore('reports');
      const row = await new Promise<any>(resolve => { const get = store.get(reportId); get.onsuccess = () => resolve(get.result); });
      row.notices = [notice];
      await new Promise<void>((resolve, reject) => { const put = store.put(row); put.onsuccess = () => resolve(); put.onerror = () => reject(put.error); });
      db.close();
    }, { reportId: id, notice: { id: noticeId, recipient: { kind: 'police', id: 'police.monki', name: 'Policja', email: null }, others: [], variant: 'unsigned',
      events: events.map(item => ({ ...item, synced: true })), outcomes: [{ ...outcome, synced: true }] } });
    // The server's own Findings worker adds findings_computed after any upload; only what the phone sends is compared.
    const history = async () => (await database.query("SELECT kind, event_id FROM report_event WHERE report_id = $1 AND kind <> 'findings_computed' ORDER BY id", [id])).rows;
    const expected = [{ kind: 'created', event_id: null }, { kind: 'synced', event_id: null },
      ...[...events, outcome].map(item => ({ kind: item.kind, event_id: item.id }))];
    // Reproduction: with the server healthy, reopening finds nothing missing, so it sends no write and adds no event.
    expect((await history()).filter(row => row.event_id)).toHaveLength(4);
    const healthyWrites: string[] = [];
    const onHealthy = (request: { method(): string; url(): string }) => { if (request.method() === 'POST') healthyWrites.push(request.url()); };
    page.on('request', onHealthy);
    await page.reload();
    await expect.poll(() => page.evaluate(() => document.readyState)).toBe('complete');
    await new Promise(resolve => setTimeout(resolve, 2000));
    page.off('request', onHealthy);
    expect(healthyWrites).toEqual([]);
    expect(await history()).toEqual(expected);

    await loseReports(database, [id]);
    expect((await database.query('SELECT 1 FROM report WHERE id = $1', [id])).rowCount).toBe(0);
    await page.reload();
    await expect.poll(async () => (await history()).length, { timeout: 30_000 }).toBe(expected.length);
    expect(await history()).toEqual(expected);
    expect((await database.query('SELECT token_sha256 FROM report WHERE id = $1', [id])).rows[0].token_sha256).toBe(before.report.token_sha256);
    await expect.poll(async () => (await stored(page))[0].server_lost, { timeout: 30_000 }).toBeUndefined();
    const [after] = await stored(page);
    expect(after.report).toEqual(before.report);
    expect(after.token).toBe(before.token);
    expect(after.findings).toEqual(before.findings);
    expect(after.notices[0].events.every((item: { synced?: boolean }) => item.synced)).toBe(true);
    // Another reopening changes nothing: no duplicate events and no second upload.
    const writes: string[] = [];
    page.on('request', request => { if (request.method() === 'POST') writes.push(request.url()); });
    await page.reload();
    await page.waitForLoadState('load');
    await new Promise(resolve => setTimeout(resolve, 2000));
    expect(writes).toEqual([]);
    expect(await history()).toEqual(expected);
  } finally { await database.end(); }
});
