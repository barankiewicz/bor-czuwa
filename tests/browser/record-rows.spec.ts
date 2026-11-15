import { test, expect, type Page } from '@playwright/test';
import { answerNow, leaveCompass, settled } from './stages.ts';

// Rows show local times; the fixtures' times are written for Warsaw.
test.use({ timezoneId: 'Europe/Warsaw' });

const fix = { lat: 52.1, lon: 21.2, accuracy_m: 12, at: '2026-09-30T05:12:00Z' };

async function seed(page: Page, drafts: object[], reports: object[] = []) {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Co się stało?' })).toBeVisible();
  await page.evaluate(async ({ drafts, reports }) => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('bor-czuwa');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const tx = db.transaction(['drafts', 'reports'], 'readwrite');
    for (const draft of drafts) tx.objectStore('drafts').put(draft);
    for (const report of reports) tx.objectStore('reports').put(report);
    await new Promise<void>((resolve, reject) => { tx.oncomplete = () => resolve(); tx.onerror = () => reject(tx.error); });
    db.close();
  }, { drafts, reports });
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Co się stało?' })).toBeVisible();
}

async function draftIds(page: Page) {
  return page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>(resolve => { const request = indexedDB.open('bor-czuwa'); request.onsuccess = () => resolve(request.result); });
    const ids = await new Promise<IDBValidKey[]>(resolve => { const request = db.transaction('drafts').objectStore('drafts').getAllKeys(); request.onsuccess = () => resolve(request.result); });
    db.close();
    return ids.map(String).sort();
  });
}

// Two Drafts captured in the same minute: one untyped, one shot still missing the home answer.
const sameMinute = [
  { id: 'untyped', eventType: null, capturedAt: '2026-09-30T05:12:10Z', fix },
  { id: 'shot', eventType: 0, capturedAt: '2026-09-30T05:12:40Z', fix }
];

test.beforeEach(async ({ page }) => {
  page.on('dialog', dialog => { throw new Error(`unexpected dialog: ${dialog.message()}`); });
  // Rows leave out the year of this year's dates, so the fixtures' 2026 needs a 2026 clock.
  await page.clock.setFixedTime(new Date('2026-10-02T10:00:00Z'));
});

test('home shows the latest task as a card above the Event cards, fully visible, with a count in the masthead', async ({ page }) => {
  await seed(page, sameMinute);
  const card = page.locator('.continuation');
  await expect(card).toHaveCount(1);
  await expect(card.getByRole('button', { name: /^Dokończ zgłoszenie strzału/ })).toBeVisible();
  await expect(card).toContainText('Dalej: Kiedy to się stało?');
  await expect(page.getByRole('button', { name: 'Usuń szkic' })).toHaveCount(0);
  const [cardBox, headingBox, footerBox] = await Promise.all([card.boundingBox(), page.getByRole('heading', { name: 'Co się stało?' }).boundingBox(), page.locator('.screen-foot').boundingBox()]);
  expect(cardBox!.y + cardBox!.height).toBeLessThanOrEqual(headingBox!.y);
  expect(cardBox!.y + cardBox!.height).toBeLessThanOrEqual(footerBox!.y);
  expect(cardBox!.y).toBeGreaterThanOrEqual(0);
  await expect(page.locator('.task-count')).toHaveText('2');
  await page.getByRole('button', { name: 'Moje zapisy', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Moje zapisy' })).toBeVisible();
});

test('a quick-capture Draft says "Co się stało?" is next', async ({ page }) => {
  await seed(page, sameMinute.slice(0, 1));
  await expect(page.locator('.continuation')).toHaveText(/^\s*Dokończ zgłoszenie30 września \d\d:12 · Dalej: Co się stało\?$/);
  await expect(page.locator('.task-count')).toHaveText('1');
});

test('Drafts from the same minute differ by title and next step, named by the screen each opens', async ({ page }) => {
  await seed(page, sameMinute);
  await page.getByRole('button', { name: 'Moje zapisy', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Do zrobienia' })).toBeVisible();
  await expect(page.getByText(/tylko na (tym )?urządzeniu/)).toHaveCount(0);
  const shot = page.getByRole('button', { name: /^Dokończ zgłoszenie strzału/ });
  const untyped = page.getByRole('button', { name: /^Dokończ zgłoszenie 30/ });
  await expect(untyped).toContainText('Dalej: Co się stało?');
  await expect(shot).toContainText('Dalej: Kiedy to się stało?');
  await shot.click();
  // Kiedy was never answered, so the Draft resumes there; from Sprawdź the row names that screen's next step.
  await expect(page.getByRole('heading', { level: 1, name: 'Kiedy to się stało?' })).toBeVisible();
  await answerNow(page);
  await leaveCompass(page);
  const rowNext = (await page.locator('#draft-next').innerText()).trim().replace(/^Dalej:\s*/, '');
  await page.getByRole('button', { name: 'Dokończę później' }).click();
  await page.getByRole('button', { name: 'Moje zapisy', exact: true }).click();
  await expect(shot).toContainText(`Dalej: ${rowNext}`);
});

test('delete confirms inline, cancel keeps the Draft, confirm removes it and moves focus', async ({ page }) => {
  await seed(page, sameMinute);
  await page.getByRole('button', { name: 'Moje zapisy', exact: true }).click();
  const toggle = page.getByRole('button', { name: 'Usuń szkic' }).first();
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');
  const confirm = page.getByRole('group', { name: 'Usunąć szkic?' });
  await expect(confirm).toBeVisible();
  await expect(confirm.getByRole('button', { name: 'Anuluj' })).toBeFocused();
  await confirm.getByRole('button', { name: 'Anuluj' }).click();
  await expect(confirm).toHaveCount(0);
  await expect(toggle).toBeFocused();
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  expect(await draftIds(page)).toEqual(['shot', 'untyped']);

  await toggle.click();
  await page.getByRole('group', { name: 'Usunąć szkic?' }).getByRole('button', { name: 'Usuń', exact: true }).click();
  await expect(page.getByRole('button', { name: /^Dokończ zgłoszenie strzału/ })).toHaveCount(0);
  expect(await draftIds(page)).toEqual(['untyped']);
  await expect(page.getByRole('button', { name: /^Dokończ zgłoszenie 30/ })).toBeFocused();

  await page.getByRole('button', { name: 'Usuń szkic' }).click();
  await page.getByRole('group', { name: 'Usunąć szkic?' }).getByRole('button', { name: 'Usuń', exact: true }).click();
  expect(await draftIds(page)).toEqual([]);
  await expect(page.getByRole('heading', { name: 'Moje zapisy' })).toBeFocused();
});

test('delete works by keyboard alone and Escape closes the confirmation', async ({ page }) => {
  await seed(page, sameMinute.slice(1));
  await page.getByRole('button', { name: 'Moje zapisy', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Moje zapisy' })).toBeFocused();
  const resume = page.getByRole('button', { name: /^Dokończ zgłoszenie strzału/ });
  await resume.focus();
  await page.keyboard.press('Tab');
  const toggle = page.getByRole('button', { name: 'Usuń szkic' });
  await expect(toggle).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('button', { name: 'Anuluj' })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('group', { name: 'Usunąć szkic?' })).toHaveCount(0);
  await expect(toggle).toBeFocused();
  await page.keyboard.press('Enter');
  await page.keyboard.press('Tab');
  await expect(page.getByRole('button', { name: 'Usuń', exact: true })).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(resume).toHaveCount(0);
  expect(await draftIds(page)).toEqual([]);
});

test('a Notice waiting for its handoff is a task of its own, and the Report row stays in history', async ({ page }) => {
  await page.route('**/api/**', route => route.fulfill({ status: 503, body: '{}' }));
  const at = '2026-09-29T17:40:00Z';
  await seed(page, [], [{
    report: { id: 'report', event_type: 'shot', captured_at: at, occurred_at: { at, coarseness: 'exact' }, incident_location: { lat: 52, lon: 21, source: 'device_fix' }, species: null },
    token: 'fixture', events: [{ kind: 'created', at }], findings: { status: 'pending' },
    notices: [{ id: 'prepared', recipient: { id: 'psl', name: 'Państwowa Straż Łowiecka - podlaskie', kind: 'psl', email: 'test@example.org' }, others: [], variant: 'signed',
      events: [{ id: 'e', kind: 'notice_composed', at, synced: true }] }]
  }]);
  await expect(page.locator('.continuation').getByRole('button', { name: /^Potwierdź przekazanie: Straż Łowiecka Strzał, / })).toBeVisible();
  await page.getByRole('button', { name: 'Moje zapisy', exact: true }).click();
  await expect(page.getByRole('button', { name: /^Strzał/ })).toBeVisible();
  await page.getByRole('button', { name: /^Potwierdź przekazanie: Straż Łowiecka/ }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Państwowa Straż Łowiecka - podlaskie' })).toBeVisible();
});

test('each delete control names its Draft, and a confirmation does not outlive the visit', async ({ page }) => {
  await seed(page, sameMinute);
  await page.getByRole('button', { name: 'Moje zapisy', exact: true }).click();
  const toggles = page.getByRole('button', { name: 'Usuń szkic' });
  await expect(toggles.nth(0)).toHaveAccessibleDescription(/^Dokończ zgłoszenie strzału 30 września \d\d:12 · Dalej:/);
  await expect(toggles.nth(1)).toHaveAccessibleDescription(/^Dokończ zgłoszenie 30 września \d\d:12 · Dalej: Co się stało\?/);
  await toggles.nth(0).click();
  await expect(page.getByRole('group', { name: 'Usunąć szkic?' })).toBeVisible();
  await page.getByRole('button', { name: 'Bór czuwa' }).click();
  await page.getByRole('button', { name: 'Moje zapisy', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Moje zapisy' })).toBeVisible();
  await expect(page.getByRole('group', { name: 'Usunąć szkic?' })).toHaveCount(0);
  await expect(toggles.nth(0)).toHaveAttribute('aria-expanded', 'false');
});

test('a Withdrawal in progress is a status in Moje zapisy and never a card on home', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Co się stało?' })).toBeVisible();
  await page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>(resolve => { const request = indexedDB.open('bor-czuwa'); request.onsuccess = () => resolve(request.result); });
    const tx = db.transaction('withdrawals', 'readwrite');
    tx.objectStore('withdrawals').put({ id: 'withdrawal', token: 'fixture', at: '2026-09-27T12:00:00Z' });
    await new Promise<void>(resolve => { tx.oncomplete = () => resolve(); });
    db.close();
  });
  await page.route('**/api/**', route => route.fulfill({ status: 503, body: '{}' }));
  await page.reload();
  await expect(page.locator('.continuation')).toHaveCount(0);
  await expect(page.locator('.calm')).toHaveCount(0);
  await page.getByRole('button', { name: 'Moje zapisy', exact: true }).click();
  await page.getByRole('button', { name: 'Przejdź do historii', exact: true }).click();
  await expect(page.locator('#history-heading')).toBeFocused();
  // History, under its month and led by its day, not a task and not a button.
  const history = page.locator('.history');
  await expect(history.getByRole('heading', { level: 3, name: 'Wrzesień 2026' })).toBeVisible();
  await expect(history.locator('.record-static .date-col')).toHaveText('27niedz.');
  await expect(history.locator('.record-static .record-copy')).toHaveText(/^\s*Wycofane zgłoszenie\s*\d\d:00 · Usuwanie z serwera w toku\s*$/);
  await expect(page.getByRole('heading', { name: 'Do zrobienia' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Usuń szkic' })).toHaveCount(0);
});

// Local times in Warsaw (UTC+2 in October): 06:12 and 06:40 today, 05:50 yesterday.
const morning = '2026-10-02T04:12:00Z', later = '2026-10-02T04:40:00Z', yesterday = '2026-10-01T03:50:00Z';
const unit = (id: string, kind: string, name: string) => ({ id, name, kind, email: 'test@example.org' });
function notice(id: string, recipient: ReturnType<typeof unit>, confirmed: boolean, extra: object = {}) {
  return { id, recipient, others: [], variant: 'unsigned', ...extra,
    events: [{ id: `e-${id}`, kind: confirmed ? 'confirmed_by_reporter' : 'notice_composed', at: morning, synced: true }] };
}
function report(id: string, event_type: string, at: string, extra: object = {}, synced = true) {
  return { report: { id, event_type, captured_at: at, occurred_at: { at, coarseness: 'exact' }, device_fix: { lat: 52, lon: 21, accuracy_m: 8, at },
    incident_location: { lat: 52, lon: 21, source: 'device_fix' }, species: null, photo_sha256: [], has_note: false },
    token: 'fixture', findings: { status: 'pending' }, events: [{ kind: 'created', at }, ...(synced ? [{ kind: 'synced', at }] : [])], ...extra };
}
const places = (gmina: string) => ({ noticePreparation: { choices: [], suggestion: { roles: [], gminy: [], places: { gmina, powiat: null, nadlesnictwo: null } } } });
const homeArea = { type: 'area', bounds: [21, 52, 21.05, 52.03], basis: 'reporter_selected_area', precise_fix_withheld: 'home_privacy' };
const history = [
  report('handed', 'shot', morning, { ...places('Borki Leśne'), notices: [
    notice('pol', unit('pol', 'police', 'Komenda Powiatowa Policji w Borkach'), true),
    notice('psl', unit('psl', 'psl', 'Państwowa Straż Łowiecka w Borkach'), false)] }),
  report('quiet', 'shot', later, places('Jodłowa Wola')),
  report('home', 'remains', yesterday, { ...places('Borki Leśne'), notices: [
    { ...notice('gm', unit('gm', 'gmina', 'Urząd Gminy Borki Leśne'), true, { places: { gmina: 'Borki Leśne', powiat: null, nadlesnictwo: null } }),
      outcomes: [{ id: 'o', kind: 'outcome_reported', notice_id: 'gm', recipient_kind: 'gmina', unit_id: 'gm', outcome: 'proceedings_opened', observed_on: '2026-10-01', at: yesterday }] }] })
];
history[2].report.incident_location = homeArea as never;

test('Report rows say which Report is which and where its Notices stand, grouped by month, two screens from home', async ({ page }) => {
  await page.route('**/api/**', route => route.fulfill({ status: 503, body: '{}' }));
  await seed(page, [], history);
  // Budget 2 / 1 / 0: home, one tap, the Notice summary on the row, nothing below the fold.
  await page.getByRole('button', { name: 'Moje zapisy', exact: true }).click();
  const list = page.locator('.history');
  await expect(list.getByRole('heading', { level: 2, name: 'Historia' })).toBeVisible();
  await expect(list.getByRole('heading', { level: 3 })).toHaveText(['Październik 2026']);
  // Each row leads with its day in its own column, hidden from the accessible name, which says the day already.
  await expect(list.locator('.date-col')).toHaveText(['2pt.', '2pt.', '1czw.']);
  const rows = list.locator('.record-main');
  await expect(rows).toHaveCount(3);
  await expect(page.getByText('Zapisano na serwerze.')).toHaveCount(0);
  // Short, distinct names with the day; the state is the description.
  await expect(rows.nth(0)).toHaveAccessibleName('Strzał, dziś 06:40 · gm. Jodłowa Wola');
  // Nothing happened to it, so the row says nothing more than its time and place.
  await expect(rows.nth(0)).toHaveAccessibleDescription('');
  await expect(rows.nth(1)).toHaveAccessibleName('Strzał, dziś 06:12 · gm. Borki Leśne');
  await expect(rows.nth(1)).toHaveAccessibleDescription('Przekazano 1 z 2 · Czeka: Straż Łowiecka');
  // From home: no place word, since the only one known came from the home's area.
  await expect(rows.nth(2)).toHaveAccessibleName('Szczątki w lesie, wczoraj 05:50');
  await expect(rows.nth(2)).toHaveAccessibleDescription('Przekazano 1 z 1 · Gmina: wszczęto postępowanie');
  await expect(rows.nth(2)).toContainText('05:50');
  await expect(rows.nth(2)).not.toContainText('gm.');
  const [last, foot] = await Promise.all([rows.nth(1).boundingBox(), page.locator('.screen-foot').boundingBox()]);
  expect(last!.y + last!.height).toBeLessThanOrEqual(foot!.y);
  // The handoff still waiting is a task above the history.
  await expect(page.getByRole('heading', { level: 2 })).toHaveText(['Do zrobienia', 'Historia']);
  await rows.nth(1).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Zgłoszenie' })).toBeVisible();
});

test('a Report waiting for the internet or refused says so on its row while it applies', async ({ page, context }) => {
  await page.route('**/api/**', route => route.fulfill({ status: 503, body: '{}' }));
  await seed(page, [], [report('queued', 'shot', morning, {}, false),
    report('refused', 'person_with_gun', later, { sync_error: 'invalid', retry_at: 9999999999999 }, false)]);
  await context.setOffline(true);
  await page.getByRole('button', { name: 'Moje zapisy', exact: true }).click();
  const rows = page.locator('.history .record-main');
  await expect(rows.nth(0)).toHaveAccessibleDescription('Nie zostało przyjęte. Otwórz, żeby zobaczyć dlaczego.');
  await expect(rows.nth(1)).toHaveAccessibleDescription('Czeka na internet, potem zapisze się samo');
  await expect(page.locator('.history')).not.toContainText('Bez powiadomień');
  await expect(page.getByRole('button', { name: /^Zgłoszenie nie zostało przyjęte/ })).toBeVisible();
});

test('the library footer says where it goes', async ({ page }) => {
  await seed(page, [], [history[1]]);
  await page.getByRole('button', { name: 'Moje zapisy', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Nowe zgłoszenie' })).toHaveCount(0);
  await page.locator('.screen-foot').getByRole('button', { name: 'Wróć do ekranu głównego' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Co się stało?' })).toBeVisible();
});

test('a Report on a gmina border shows a place word only once the Reporter chose the gmina', async ({ page }) => {
  const border = (gminaAnswer?: string) => ({ noticePreparation: { choices: [], gminaAnswer, suggestion: { roles: [], gminaQuestion: true, places: undefined,
    gminy: [{ ...unit('a', 'gmina', 'Urząd Gminy Borki Leśne'), place: 'Borki Leśne', powiat: 'borkowski' }, { ...unit('b', 'gmina', 'Urząd Gminy Jodłowa Wola'), place: 'Jodłowa Wola', powiat: 'borkowski' }] } } });
  await seed(page, [], [report('open', 'shot', morning, border()), report('chosen', 'shot', later, border('b'))]);
  await page.getByRole('button', { name: 'Moje zapisy', exact: true }).click();
  const rows = page.locator('.history .record-main');
  await expect(rows.nth(0)).toHaveAccessibleName('Strzał, dziś 06:40 · gm. Jodłowa Wola');
  await expect(rows.nth(1)).toHaveAccessibleName('Strzał, dziś 06:12');
});


for (const [name, drafts] of [['empty', []], ['task-only', sameMinute]] as const) {
  test(`History jump is absent from ${name} library`, async ({ page }) => {
    await seed(page, [...drafts]);
    await page.getByRole('button', { name: 'Moje zapisy', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Przejdź do historii', exact: true })).toHaveCount(0);
    await expect(page.locator('#history-heading')).toHaveCount(0);
    expect(await draftIds(page)).toEqual(drafts.map(draft => draft.id).sort());
  });
}

async function libraryData(page: Page) {
  return page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>(resolve => { const request = indexedDB.open('bor-czuwa'); request.onsuccess = () => resolve(request.result); });
    const names = ['drafts', 'reports', 'withdrawals'];
    const tx = db.transaction(names);
    const values = await Promise.all(names.map(name => new Promise<unknown[]>(resolve => { const request = tx.objectStore(name).getAll(); request.onsuccess = () => resolve(request.result); })));
    db.close();
    return Object.fromEntries(names.map((name, index) => [name, values[index]]));
  });
}

for (const size of [3, 1000]) {
  test(`History jump preserves ${size} Reports, tasks and live Back without another navigation entry`, async ({ page }) => {
    await page.route('**/api/**', route => route.fulfill({ status: 503, body: '{}' }));
    // Keep background retries outside this navigation fixture.
    const reports = (size === 3 ? structuredClone(history) : Array.from({ length: size }, (_, index) =>
      report(`history-${index}`, 'shot', new Date(Date.parse(morning) - index * 60000).toISOString())))
      .map(local => ({ ...local, retry_at: 9999999999999 }));
    const drafts = Array.from({ length: 170 }, (_, index) => ({ ...sameMinute[0], id: `draft-${index}` }));
    await seed(page, drafts, reports);
    await page.getByRole('button', { name: 'Moje zapisy', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Moje zapisy', exact: true })).toBeFocused();
    await settled(page);
    const jump = page.getByRole('button', { name: 'Przejdź do historii', exact: true });
    await expect(jump).toHaveCount(1);
    const before = { url: page.url(), length: await page.evaluate(() => history.length), data: await libraryData(page),
      tasks: await page.locator('.record-list .record-main').allTextContents(), months: await page.locator('.history-month h3').allTextContents() };
    await page.keyboard.press('Tab');
    await expect(jump).toBeFocused();
    const target = await jump.boundingBox();
    expect(target!.width).toBeGreaterThanOrEqual(56); expect(target!.height).toBeGreaterThanOrEqual(56);
    await page.keyboard.press('Enter');
    const heading = page.locator('#history-heading');
    await expect(heading).toBeFocused();
    const framed = await heading.evaluate(element => {
      const r = element.getBoundingClientRect(), p = document.querySelector('.screen-body')!.getBoundingClientRect(), style = getComputedStyle(element);
      const ring = parseFloat(style.outlineWidth) + parseFloat(style.outlineOffset);
      const alpha = Number((style.outlineColor.match(/[\d.]+/g) ?? [])[3] ?? 1);
      return element.matches(':focus-visible') && style.outlineStyle === 'solid' && parseFloat(style.outlineWidth) > 0 && alpha > 0
        && r.top - ring >= p.top && r.bottom + ring <= p.bottom && r.left - ring >= p.left && r.right + ring <= p.right;
    });
    expect(framed).toBe(true);
    expect(page.url()).toBe(before.url); expect(await page.evaluate(() => history.length)).toBe(before.length);
    expect(await libraryData(page)).toEqual(before.data);
    expect(await page.locator('.record-list .record-main').allTextContents()).toEqual(before.tasks);
    expect(await page.locator('.history-month h3').allTextContents()).toEqual(before.months);
    const row = page.locator('.history .record-main').first();
    await row.scrollIntoViewIfNeeded();
    const beforeOpenScroll = await page.locator('.screen-body').evaluate(element => element.scrollTop);
    await row.click();
    await expect(page.getByRole('heading', { name: 'Zgłoszenie', exact: true })).toBeVisible();
    expect(new URL(page.url()).searchParams.get('report')).toBe(reports.slice().sort((a, b) => Date.parse(b.report.captured_at) - Date.parse(a.report.captured_at))[0].report.id);
    await page.goBack();
    await expect(jump).toHaveCount(1);
    await settled(page);
    await expect(row).toBeInViewport();
    await expect.poll(() => page.locator('.screen-body').evaluate(element => element.scrollTop)).toBe(beforeOpenScroll);
    expect(await libraryData(page)).toEqual(before.data);
    await page.goBack();
    await expect(page.getByRole('heading', { name: 'Co się stało?', exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Moje zapisy', exact: true }).click();
    await jump.click(); await expect(heading).toBeFocused();
    expect(page.url()).toBe(before.url);
    await page.reload(); await expect(jump).toHaveCount(1);
    expect(await libraryData(page)).toEqual(before.data);
  });
}
