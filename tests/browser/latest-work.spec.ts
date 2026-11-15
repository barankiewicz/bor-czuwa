import { test, expect, type Page } from '@playwright/test';
import { clockedGeolocation } from './stages.ts';

const checkInEnabled = process.env.VITE_CHECK_IN_ENABLED === 'true';

// Rows leave out the year of this year's dates, so the fixtures' 2026 needs a 2026 clock.
test.beforeEach(async ({ page }) => { await page.clock.setFixedTime(new Date('2026-10-02T10:00:00Z')); });

async function seedDrafts(page: Page, count: number) {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Co się stało?' })).toBeVisible();
  await page.evaluate(async count => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('bor-czuwa');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const tx = db.transaction('drafts', 'readwrite');
    for (let index = 0; index < count; index++) tx.objectStore('drafts').put({
      id: `draft-${index}`, eventType: index === count - 1 ? 4 : 1,
      capturedAt: new Date(Date.UTC(2026, 8, index + 1, 12)).toISOString()
    });
    await new Promise<void>((resolve, reject) => { tx.oncomplete = () => resolve(); tx.onerror = () => reject(tx.error); });
    db.close();
  }, count);
  await page.reload();
}

/** Every Event row ends above the footer, so capture never needs a swipe because of older work. */
async function expectRowsAboveFold(page: Page) {
  await expect(page.locator('.event-row')).toHaveCount(5);
  const [last, foot] = await Promise.all([page.locator('.event-row').last().boundingBox(), page.locator('.screen-foot').boundingBox()]);
  expect(last!.y + last!.height).toBeLessThanOrEqual(foot!.y);
}

for (const count of [0, 1, 20]) test(`home shows at most one task for ${count} Drafts`, async ({ page }) => {
  await seedDrafts(page, count);
  await expectRowsAboveFold(page);
  await expect(page.getByRole('button', { name: /^Dokończ zgłoszenie/ })).toHaveCount(count ? 1 : 0);
  await expect(page.getByRole('button', { name: 'Usuń szkic' })).toHaveCount(0);
  await expect(page.locator('.task-count')).toHaveText(count ? [String(count)] : []);
  // The no-help line left home for Sprawdź, where it sits above the save button (ticket 29).
  await expect(page.getByText('Zgłoszenie nie sprowadza pomocy.')).toHaveCount(0);
  const library = page.getByRole('button', { name: 'Moje zapisy', exact: true });
  if (count) await expect(library).toHaveAccessibleDescription(`${count} do zrobienia`);
  await library.click();
  await expect(page.getByRole('heading', { name: 'Do zrobienia' })).toHaveCount(count ? 1 : 0);
  await expect(page.getByRole('button', { name: /^Dokończ zgłoszenie/ })).toHaveCount(count);
  if (count) await expect(library).toHaveAccessibleDescription(`${count} do zrobienia`);
});

test('the card names the Event and the step the Draft opens on', async ({ page }) => {
  await seedDrafts(page, 1);
  // The seeded Draft is a poaching Draft with no answers yet, so it resumes at Kiedy.
  const card = page.locator('.continuation').getByRole('button');
  await expect(card).toHaveAccessibleName(/^Dokończ zgłoszenie kłusownictwa 1 września \d\d:\d\d · Dalej: Kiedy to się stało\?$/);
  await card.click();
  await expect(page.getByRole('heading', { level: 1, name: 'Kiedy to się stało?' })).toBeVisible();
});

test('editing an older Draft persists latest activity; removing it reveals next work', async ({ page }) => {
  await seedDrafts(page, 20);
  await page.getByRole('button', { name: 'Moje zapisy', exact: true }).click();
  await page.getByRole('button', { name: /^Dokończ zgłoszenie .* 1 września/ }).click();
  await page.getByRole('button', { name: 'Kilka godzin temu' }).click();
  await page.getByRole('button', { name: 'Dokończę później' }).click();
  await page.getByRole('button', { name: 'Bór czuwa' }).click();
  await page.reload();
  await expect(page.locator('.continuation')).toContainText('1 września');
  await page.getByRole('button', { name: 'Moje zapisy', exact: true }).click();
  await page.locator('.record-card').filter({ hasText: /\D1 września/ }).getByRole('button', { name: 'Usuń szkic' }).click();
  await page.getByRole('group', { name: 'Usunąć szkic?' }).getByRole('button', { name: 'Usuń', exact: true }).click();
  await page.getByRole('button', { name: 'Bór czuwa' }).click();
  await expect(page.locator('.continuation')).toContainText('20 września');
  await expect(page.locator('.event-row')).toHaveCount(5);
});

async function seedReports(page: Page) {
  await seedDrafts(page, 0);
  await page.route('**/api/**', route => route.fulfill({ status: 503, body: '{}' }));
  await page.clock.setFixedTime(new Date('2026-09-28T12:00:00Z'));
  await page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>(resolve => {
      const request = indexedDB.open('bor-czuwa');
      request.onsuccess = () => resolve(request.result);
    });
    const tx = db.transaction(['reports', 'withdrawals'], 'readwrite');
    const notice = (id: string, confirmed: boolean, signed = false, at = '2026-08-01T12:00:00Z') => ({
      id, recipient: { id, name: `Urząd ${id}`, kind: 'police', email: 'test@example.org' }, others: [],
      variant: signed ? 'signed' : 'unsigned', events: [{ id: `event-${id}`, notice_id: id,
        kind: confirmed ? 'confirmed_by_reporter' : 'notice_composed', at, recipient_kind: 'police', unit_id: id,
        template_version: 'test', directory_version: 'test', synced: true }]
    });
    const report = (id: string, synced = true, notices: ReturnType<typeof notice>[] = [], extra = {}) => ({
      report: { id, event_type: 'person_with_gun', captured_at: '2026-08-01T12:00:00Z',
        occurred_at: { at: '2026-08-01T12:00:00Z', coarseness: 'exact' },
        device_fix: { lat: 52, lon: 21, accuracy_m: 8, at: '2026-08-01T12:00:00Z' },
        incident_location: { lat: 52, lon: 21, source: 'device_fix' }, species: null, photo_sha256: [], has_note: false },
      token: 'fixture', findings: { status: 'pending' }, notices,
      events: [{ kind: 'created', at: '2026-08-01T12:00:00Z' }, ...(synced ? [{ kind: 'synced', at: '2026-09-28T12:00:00Z' }] : [])], ...extra
    });
    for (const item of [report('optional'), report('queued', false), report('refused', false, [], { sync_error: 'invalid', retry_at: 9999999999999 }),
      report('partial', true, [notice('confirmed', true), notice('prepared', false), notice('prepared2', false)], { lastActivityAt: '2026-09-27T12:00:00Z' }),
      report('due', true, [notice('due', true, true)]),
      report('future', true, [notice('future', true, true, '2026-09-27T12:00:00Z')]),
      report('unsigned', true, [notice('unsigned', true)])]) tx.objectStore('reports').put(item);
    tx.objectStore('withdrawals').put({ id: 'withdrawal', token: 'fixture', at: '2026-09-01T12:00:00Z' });
    await new Promise<void>(resolve => { tx.oncomplete = () => resolve(); });
    db.close();
  });
  await page.reload();
}

test('only the Reporter\'s tasks count, each opens its own screen, and finishing one removes only it', async ({ page }) => {
  await seedReports(page);
  const library = page.getByRole('button', { name: 'Moje zapisy', exact: true });
  // The refusal, two handoffs to confirm and the due check-in; never the upload or the Withdrawal.
  await expect(library).toHaveAccessibleDescription(`${checkInEnabled ? 4 : 3} do zrobienia`);
  await expect(page.locator('.task-count')).toHaveText(checkInEnabled ? '4' : '3');
  await expectRowsAboveFold(page);
  // The newest task is an unconfirmed handoff; its card opens that Notice, where its route and question are.
  // Two handoffs to police wait, so each names its unit in full; the one police check-in says "Policja".
  const card = page.locator('.continuation').getByRole('button');
  await expect(card).toHaveAccessibleName(/^Potwierdź przekazanie: Urząd prepared Człowiek z bronią, 1 sierpnia/);
  await card.click();
  await expect(page.getByRole('heading', { level: 1, name: 'Urząd prepared' })).toBeVisible();
  await expect(page.locator('main .badge')).toHaveCount(0);
  await library.click();
  const tasks = page.locator('.record-list').first().getByRole('button');
  await expect(tasks).toHaveText([/^\s*Potwierdź przekazanie: Urząd prepared(?!2)/, /^\s*Potwierdź przekazanie: Urząd prepared2/,
    ...(checkInEnabled ? [/^\s*Czy Policja odpowiedziała\?/] : []), /^\s*Zgłoszenie nie zostało przyjęte/]);
  // Automatic work is history, not a task.
  await expect(page.locator('.history #row-queued-state')).toBeVisible();
  await expect(page.getByText('Usuwanie z serwera w toku', { exact: false })).toBeVisible();
  await page.getByRole('button', { name: /^Potwierdź przekazanie: Urząd prepared(?!2)/ }).click();
  await page.getByRole('link', { name: 'Otwórz w poczcie' }).click();
  await page.getByRole('button', { name: 'Jeszcze nie' }).click();
  await library.click();
  await expect(library).toHaveAccessibleDescription(`${checkInEnabled ? 4 : 3} do zrobienia`);
  await page.getByRole('button', { name: /^Potwierdź przekazanie: Urząd prepared(?!2)/ }).click();
  await page.getByRole('link', { name: 'Otwórz w poczcie' }).click();
  await page.getByRole('button', { name: 'Potwierdzam przekazanie', exact: true }).click();
  await library.click();
  await expect(library).toHaveAccessibleDescription(`${checkInEnabled ? 3 : 2} do zrobienia`);
  await expect(page.getByRole('button', { name: /^Potwierdź przekazanie: Urząd prepared(?!2)/ })).toHaveCount(0);
  // The other police handoff is now the only one, so it takes the short name.
  await expect(page.getByRole('button', { name: /^Potwierdź przekazanie: Policja/ })).toHaveCount(1);
  // The refused Report opens the Report, where its refusal and what to do next are.
  await page.getByRole('button', { name: /^Zgłoszenie nie zostało przyjęte/ }).click();
  await expect(page.getByText('Serwer nie przyjął zgłoszenia.', { exact: false }).first()).toBeVisible();
});

test('answering due Signed Notice check-in clears action even when no answer has arrived', async ({ page }) => {
  test.skip(!checkInEnabled, 'Requires a build with VITE_CHECK_IN_ENABLED=true');
  await seedReports(page);
  const library = page.getByRole('button', { name: 'Moje zapisy', exact: true });
  await library.click();
  await page.getByRole('button', { name: /^Czy Policja odpowiedziała/ }).click();
  await expect(page.getByRole('heading', { level: 1, name: /^Czy .* odpowiedział/ })).toBeVisible();
  await page.locator('.answers').getByRole('button', { name: 'Jeszcze nie' }).click();
  await expect(page.locator('#check-in-saved')).toContainText('Zapytamy znowu.');
  await library.click();
  await expect(library).toHaveAccessibleDescription('3 do zrobienia');
  await expect(page.getByRole('button', { name: /^Czy Policja/ })).toHaveCount(0);
  await page.reload();
  await expect(library).toHaveAccessibleDescription('3 do zrobienia');
});

for (const [name, seed, line] of [
  ['an upload', 'queued', 'Zapisane zgłoszenie trafi na serwer, gdy będzie internet.'],
  ['a Withdrawal', 'withdrawal', null]
] as const) test(`home says nothing needs the Reporter while only ${name} is pending`, async ({ page, context }) => {
  await seedDrafts(page, 0);
  await page.evaluate(async seed => {
    const db = await new Promise<IDBDatabase>(resolve => { const request = indexedDB.open('bor-czuwa'); request.onsuccess = () => resolve(request.result); });
    const tx = db.transaction(['reports', 'withdrawals'], 'readwrite');
    if (seed === 'withdrawal') tx.objectStore('withdrawals').put({ id: 'withdrawal', token: 'fixture', at: '2026-09-01T12:00:00Z' });
    else tx.objectStore('reports').put({
      report: { id: 'queued', event_type: 'shot', captured_at: '2026-08-01T12:00:00Z', occurred_at: { at: '2026-08-01T12:00:00Z', coarseness: 'exact' },
        device_fix: { lat: 52, lon: 21, accuracy_m: 8, at: '2026-08-01T12:00:00Z' }, incident_location: { lat: 52, lon: 21, source: 'device_fix' },
        species: null, photo_sha256: [], has_note: false },
      token: 'fixture', findings: { status: 'pending' }, events: [{ kind: 'created', at: '2026-08-01T12:00:00Z' }] });
    await new Promise<void>(resolve => { tx.oncomplete = () => resolve(); });
    db.close();
  }, seed);
  await page.route('**/api/**', route => route.abort());
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Co się stało?' })).toBeVisible();
  // The forest case: no signal at all, so the line can say when the upload will happen.
  await context.setOffline(true);
  // Only the upload is worth a line; with nothing the Reporter would wonder about, home says nothing.
  if (line) await expect(page.locator('.calm')).toHaveText(line);
  else await expect(page.locator('.calm')).toHaveCount(0);
  await expect(page.locator('.continuation')).toHaveCount(0);
  await expect(page.locator('.task-count')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Moje zapisy', exact: true })).toHaveAccessibleDescription('');
  await expectRowsAboveFold(page);
  await context.setOffline(false);
});

test('explicit location retry makes older Draft latest without waiting for GPS to order it', async ({ page, context }) => {
  await clockedGeolocation(page);
  await context.setGeolocation({ latitude: 52.1, longitude: 21.1, accuracy: 8 });
  await seedDrafts(page, 2);
  await page.getByRole('button', { name: 'Moje zapisy', exact: true }).click();
  await page.getByRole('button', { name: /^Dokończ zgłoszenie .* 1 września/ }).click();
  // Without a fix, Teraz leads to the map, which offers the retry.
  await page.getByRole('button', { name: /^Teraz/ }).click();
  await page.getByRole('button', { name: 'Spróbuj ustalić miejsce ponownie' }).click();
  await expect(page.getByRole('button', { name: 'Spróbuj ustalić miejsce ponownie' })).toHaveCount(0);
  await page.getByRole('button', { name: 'Dokończę później' }).click();
  await page.getByRole('button', { name: 'Bór czuwa' }).click();
  await page.reload();
  await expect(page.locator('.continuation')).toContainText('1 września');
});

test('mixed work: tasks open directly, finished correspondence stays, the app\'s work never displaces capture', async ({ page }) => {
  await seedDrafts(page, 0);
  await page.route('**/api/**', route => route.fulfill({ status: 503, body: '{}' }));
  await page.clock.setFixedTime(new Date('2026-09-28T12:00:00Z'));
  await page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>(resolve => { const request = indexedDB.open('bor-czuwa'); request.onsuccess = () => resolve(request.result); });
    const tx = db.transaction(['reports', 'withdrawals'], 'readwrite');
    const notice = (id: string, kind: string, name: string, confirmed: boolean, signed = false, outcome?: string) => ({
      id, recipient: { id, name, kind, email: 'test@example.org' }, others: [], variant: signed ? 'signed' : 'unsigned',
      events: [{ id: `event-${id}`, notice_id: id, kind: confirmed ? 'confirmed_by_reporter' : 'notice_composed', at: '2026-08-01T12:00:00Z',
        recipient_kind: kind, unit_id: id, template_version: 'test', directory_version: 'test', synced: true }],
      outcomes: outcome ? [{ id: `outcome-${id}`, kind: 'outcome_reported', notice_id: id, recipient_kind: kind, unit_id: id,
        outcome, observed_on: '2026-09-20', at: '2026-09-20T12:00:00Z', synced: true }] : undefined
    });
    const report = (id: string, at: string, notices: ReturnType<typeof notice>[] = [], extra: object = {}, synced = true) => ({
      report: { id, event_type: 'person_with_gun', captured_at: at, occurred_at: { at, coarseness: 'exact' },
        device_fix: { lat: 52, lon: 21, accuracy_m: 8, at }, incident_location: { lat: 52, lon: 21, source: 'device_fix' },
        species: null, photo_sha256: [], has_note: false },
      token: 'fixture', findings: { status: 'pending' }, notices,
      events: [{ kind: 'created', at }, ...(synced ? [{ kind: 'synced', at }] : [])], ...extra
    });
    for (const item of [
      // One Report, two Notices: the police handoff confirmed, the Straż Łowiecka one not.
      report('split', '2026-09-28T06:12:00Z', [notice('police', 'police', 'Komenda Powiatowa Policji w Borkach', true), notice('psl', 'psl', 'Państwowa Straż Łowiecka w Borkach', false)]),
      // Several similar Reports from one morning, one of them with a recorded outcome.
      report('answered', '2026-09-28T06:40:00Z', [notice('gmina', 'gmina', 'Urząd Gminy Borki', true, true, 'reply')]),
      report('similar', '2026-09-28T06:50:00Z'),
      report('due', '2026-08-01T12:00:00Z', [notice('due', 'police', 'Komenda Miejska Policji w Lesie', true, true)]),
      report('queued', '2026-09-28T07:00:00Z', [], {}, false),
      report('refused', '2026-09-28T07:05:00Z', [], { sync_error: 'invalid', retry_at: 9999999999999 }, false)
    ]) tx.objectStore('reports').put(item);
    tx.objectStore('withdrawals').put({ id: 'withdrawal', token: 'fixture', at: '2026-09-27T18:20:00Z' });
    await new Promise<void>(resolve => { tx.oncomplete = () => resolve(); });
    db.close();
  });
  await page.reload();
  const library = page.getByRole('button', { name: 'Moje zapisy', exact: true });
  // The handoff, the check-in and the refusal; the upload and the Withdrawal are the app's to finish.
  await expect(library).toHaveAccessibleDescription(`${checkInEnabled ? 3 : 2} do zrobienia`);
  await expectRowsAboveFold(page);
  const noDelivery = /doręcz|dostarcz|wysłan|otrzymał/i;
  await expect(page.locator('main')).not.toContainText(noDelivery);
  await library.click();
  const tasks = page.locator('.record-list').first().getByRole('button');
  await expect(tasks).toHaveText([/^\s*Zgłoszenie nie zostało przyjęte/, /^\s*Potwierdź przekazanie: Straż Łowiecka/, ...(checkInEnabled ? [/^\s*Czy Policja odpowiedziała\?/] : [])]);
  const history = page.locator('.history .record-main');
  await expect(history).toHaveCount(6);
  await expect(page.locator('main')).not.toContainText(noDelivery);
  if (checkInEnabled) {
    // The check-in opens the question itself, not the Report.
    await tasks.filter({ hasText: 'Czy Policja' }).click();
    await expect(page.getByRole('heading', { level: 1, name: 'Czy Komenda Miejska Policji w Lesie odpowiedziała?' })).toBeVisible();
    await page.locator('.answers').getByRole('button', { name: 'Przyszła odpowiedź' }).click();
    await expect(page.locator('#check-in-saved')).toBeVisible();
    await library.click();
  }
  await expect(library).toHaveAccessibleDescription('2 do zrobienia');
  await expect(tasks).toHaveText([/^\s*Zgłoszenie nie zostało przyjęte/, /^\s*Potwierdź przekazanie: Straż Łowiecka/]);
  // Answered correspondence leaves the tasks and stays in history.
  await expect(history).toHaveCount(6);
  await page.getByRole('button', { name: 'Bór czuwa' }).click();
  await expect(page.locator('.continuation')).toContainText('Zgłoszenie nie zostało przyjęte');
  await expectRowsAboveFold(page);
});
