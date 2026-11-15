import { test, expect, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { openMap, answerHome, expectQuickTabStaysOut, footer, heading, save, stubReportServer, toReview } from './stages.ts';

const points = JSON.parse(await readFile(new URL('../../data/fixtures/acceptance.json', import.meta.url), 'utf8'));

async function choosePoint(page: Page, lat: number, lon: number) {
  await openMap(page);
  if (!await page.locator('details.advanced').evaluate(element => (element as HTMLDetailsElement).open)) {
    await page.getByText('Wpisz współrzędne', { exact: true }).click();
  }
  await page.getByLabel('Szerokość geograficzna').fill(String(lat));
  await page.getByLabel('Długość geograficzna').fill(String(lon));
  await page.getByRole('button', { name: 'Wskaż wpisany punkt' }).click();
  await footer(page).getByRole('button', { name: 'Dalej' }).click();
  await expect(heading(page, 'Sprawdź i zapisz')).toBeVisible();
}

test('the first home answer saves the home, later Reports nearby are decided by it, and a chosen point is judged against it', async ({ page, context }) => {
  const home = points.barn.point;
  await context.setGeolocation({ latitude: home.lat, longitude: home.lon, accuracy: 12 });
  const posts: Record<string, unknown>[] = [];
  page.on('request', request => {
    if (request.method() === 'POST' && request.url().endsWith('/api/reports')) posts.push(request.postDataJSON());
  });
  // Only the outgoing payloads matter here, so the uploads spend no daily Reports.
  await stubReportServer(page);
  await page.goto('/');
  for (const [index, name] of ['Strzał', 'Człowiek z bronią', 'Szczątki w lesie', 'Ranne zwierzę', 'Kłusownictwo'].entries()) {
    if (index === 1) await context.setGeolocation({ latitude: home.lat + 0.0005, longitude: home.lon, accuracy: 12 });
    await toReview(page, name);
    if (index === 0) {
      await expect(page.locator('#home-check')).toBeVisible();
      expect(posts).toHaveLength(0);
      await answerHome(page, true);
    } else {
      // The saved home decides: no question, and the way out is one tap away.
      await expect(page.locator('#home-check')).toHaveCount(0);
      await expect(page.getByRole('button', { name: 'Nie jestem w domu' })).toBeVisible();
    }
    await expect(page.locator('.privacy')).toContainText('Twój dom nie będzie widoczny.');
    if (name === 'Szczątki w lesie') {
      await footer(page).getByRole('button', { name: 'Dokończę później' }).click();
      await page.reload();
      continue;
    }
    const posted = page.waitForRequest(request => request.method() === 'POST' && request.url().endsWith('/api/reports'));
    await save(page);
    const payload = (await posted).postDataJSON();
    expect(payload.device_fix).toBeNull();
    expect(payload.incident_location).toMatchObject({ type: 'area', basis: 'reporter_selected_area', precise_fix_withheld: 'home_privacy' });
    expect(JSON.stringify(payload)).not.toContain(String(home.lat));
    await expect(page.getByText('Zapisano na serwerze.', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Bór czuwa' }).click();
    await page.reload();
  }
  await toReview(page, 'Człowiek z bronią');
  await page.getByRole('button', { name: 'Nie jestem w domu' }).click();
  // Away from home at the home's own fix: a direction from there would show the home, so it has to be a home Report.
  await expect(page.locator('#draft-next')).toContainText('Jesteś przy zapisanym domu.');
  // Earlier, the place is a point on the map, judged against the home.
  await page.getByRole('button', { name: 'Zmień: Kiedy' }).click();
  await page.getByRole('button', { name: 'Kilka godzin temu' }).click();
  await footer(page).getByRole('button', { name: 'Dalej' }).click();
  await expect(heading(page, 'Gdzie to było?')).toBeVisible();
  await choosePoint(page, home.lat, home.lon);
  // A point at the saved home is a home Report again, until the Reporter says otherwise.
  await expect(page.locator('.privacy')).toContainText('Twój dom nie będzie widoczny.');
  await page.getByRole('button', { name: 'Nie jestem w domu' }).click();
  await expect(page.locator('#draft-next')).toContainText('Ten punkt jest przy zapisanym domu.');
  await page.getByRole('button', { name: 'Zmień: Gdzie' }).click();
  await choosePoint(page, home.lat + 0.002, home.lon);
  await expect(page.locator('#draft-next')).toHaveCount(0);
  const ordinary = page.waitForRequest(request => request.method() === 'POST' && request.url().endsWith('/api/reports'));
  await save(page);
  const area = (await ordinary).postDataJSON();
  expect(area.device_fix).toBeNull();
  expect(area.incident_location).toMatchObject({ type: 'area', basis: 'reporter_selected_area', precise_fix_withheld: null });
  const [west, south, east, north] = area.incident_location.bounds;
  expect((south + north) / 2).toBeCloseTo(Number((home.lat + 0.002).toFixed(5)), 5);
  expect((west + east) / 2).toBeCloseTo(Number(home.lon.toFixed(5)), 5);
  await expect(page.getByText('Zapisano na serwerze.', { exact: true })).toBeVisible();
  const local = await page.evaluate(async () => {
    const request = indexedDB.open('bor-czuwa');
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const result = await new Promise<{
      reports: { privateFix?: { lat: number }; report: { device_fix: null | { lat: number }; incident_location: { source?: string; type?: string } } }[];
      home: { fix: { lat: number } };
      drafts: { eventType: number; fix?: { lat: number }; fromHome?: boolean }[];
    }>((resolve, reject) => {
      const transaction = db.transaction(['reports', 'home', 'drafts']);
      const reports = transaction.objectStore('reports').getAll();
      const home = transaction.objectStore('home').get('mine');
      const drafts = transaction.objectStore('drafts').getAll();
      transaction.oncomplete = () => resolve({ reports: reports.result, home: home.result, drafts: drafts.result });
      transaction.onerror = () => reject(transaction.error);
    });
    db.close();
    return result;
  });
  expect(local.home.fix.lat).toBe(home.lat);
  expect(local.reports).toHaveLength(5);
  expect(local.reports.every(item => item.report.incident_location.type === 'area')).toBe(true);
  expect(local.reports.every(item => item.privateFix)).toBe(true);
  expect(local.reports.filter(item => item.privateFix?.lat === home.lat)).toHaveLength(1);
  expect(local.reports.filter(item => item.privateFix?.lat === home.lat + 0.0005)).toHaveLength(4);
  // The unfinished remains Draft leaves the home question to the saved home.
  expect(local.drafts).toHaveLength(1);
  expect(local.drafts[0]).toMatchObject({ eventType: 2, fix: { lat: home.lat + 0.0005 } });
  expect(local.drafts[0].fromHome).toBeUndefined();
});

async function savedHome(page: Page) {
  return page.evaluate(async () => {
    const request = indexedDB.open('bor-czuwa');
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const result = await new Promise<{ home?: { fix: { lat: number } }; reports: number }>((resolve, reject) => {
      const transaction = db.transaction(['home', 'reports']);
      const home = transaction.objectStore('home').get('mine');
      const reports = transaction.objectStore('reports').count();
      transaction.oncomplete = () => resolve({ home: home.result, reports: reports.result });
      transaction.onerror = () => reject(transaction.error);
    });
    db.close();
    return result;
  });
}

test('Menu shows the saved home and removes only it, and the next Report from home saves it again', async ({ page, context }) => {
  const home = points.barn.point;
  await context.setGeolocation({ latitude: home.lat, longitude: home.lon, accuracy: 12 });
  const posts: string[] = [];
  // The server's state does not matter here, so the daily Report limit is not spent.
  await page.route('**/api/reports', route => {
    posts.push(route.request().postData() ?? '');
    return route.fulfill({ status: 201, contentType: 'application/json', body: '{"id":"accepted"}' });
  });
  await page.route('**/api/reports/*/findings', route => route.fulfill({ json: { status: 'pending' } }));
  const menu = async () => {
    await page.getByRole('button', { name: 'Menu' }).click();
    await expect(heading(page, 'Menu')).toBeVisible();
  };
  const saveFromHome = async () => {
    await page.getByRole('button', { name: 'Bór czuwa' }).click();
    await toReview(page, 'Człowiek z bronią');
    await expect(page.locator('#home-check')).toBeVisible();
    await answerHome(page, true);
    await save(page);
    await expect(heading(page, /^Zgłoszenie$/)).toBeVisible();
  };
  await page.goto('/');
  await menu();
  await expect(page.getByRole('region', { name: 'Twój dom' })).toHaveCount(0);

  await saveFromHome();
  await menu();
  const row = page.getByRole('region', { name: 'Twój dom' });
  await expect(row).toContainText('Dom nie opuszcza telefonu.');
  const remove = row.getByRole('button', { name: 'Usuń zapisany dom' });

  // Anuluj, then Escape, each fold the confirmation and give focus back to Usuń.
  await remove.click();
  const confirm = page.getByRole('group', { name: 'Usunąć zapisany dom?' });
  await expect(confirm).toContainText('Zapisane zgłoszenia się nie zmienią.');
  await expect(confirm.getByRole('button', { name: 'Anuluj' })).toBeFocused();
  await confirm.getByRole('button', { name: 'Anuluj' }).click();
  await expect(confirm).toHaveCount(0);
  await expect(remove).toBeFocused();
  await remove.click();
  await expect(confirm.getByRole('button', { name: 'Anuluj' })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(confirm).toHaveCount(0);
  await expect(remove).toBeFocused();
  expect((await savedHome(page)).home?.fix.lat).toBe(home.lat);

  await remove.click();
  await confirm.getByRole('button', { name: 'Usuń', exact: true }).click();
  const result = page.getByText('Dom usunięty z tego telefonu.');
  await expect(result).toBeVisible();
  await expect(page.locator('.result-line')).toBeFocused();
  await expect(row).toHaveCount(0);
  expect(await savedHome(page)).toEqual({ home: undefined, reports: 1 });

  await page.reload();
  await menu();
  await expect(page.getByRole('region', { name: 'Twój dom' })).toHaveCount(0);
  await expect(result).toHaveCount(0);

  // With no saved home the question comes back, and answering it saves the home again.
  await saveFromHome();
  expect(await savedHome(page)).toMatchObject({ home: { fix: { lat: home.lat } }, reports: 2 });
  await menu();
  await expect(page.getByRole('region', { name: 'Twój dom' })).toBeVisible();
  // The upload runs in the background after saving, so wait for the second one.
  await expect.poll(() => posts.length).toBe(2);
  for (const body of posts) expect(body).not.toContain(String(home.lat));
});

test('a poor fix that could be at home asks the home question', async ({ page, context }) => {
  const home = points.barn.point;
  const posts: Record<string, unknown>[] = [];
  page.on('request', request => {
    if (request.method() === 'POST' && request.url().endsWith('/api/reports')) posts.push(request.postDataJSON());
  });
  await stubReportServer(page);
  await page.goto('/');
  // The first answer from home saves the home.
  await context.setGeolocation({ latitude: home.lat, longitude: home.lon, accuracy: 12 });
  await toReview(page, 'Człowiek z bronią');
  await answerHome(page, true);
  await save(page);
  await expect(page.getByText('Zapisano na serwerze.', { exact: true })).toBeVisible();
  posts.length = 0;

  const draftFix = () => page.evaluate(async () => {
    const request = indexedDB.open('bor-czuwa');
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const drafts = await new Promise<{ fix?: { lat: number; lon: number; accuracy_m: number } }[]>((resolve, reject) => {
      const all = db.transaction('drafts').objectStore('drafts').getAll();
      all.onsuccess = () => resolve(all.result);
      all.onerror = () => reject(all.error);
    });
    db.close();
    return drafts.at(-1)?.fix;
  });
  // The reading is set before the page loads, so no earlier fix can be captured instead, and the Draft
  // is checked to hold exactly that reading.
  const review = async (distanceM: number, accuracy: number) => {
    const reading = { latitude: home.lat + distanceM / 111_000, longitude: home.lon, accuracy };
    await context.setGeolocation(reading);
    await page.getByRole('button', { name: 'Bór czuwa' }).click();
    await page.reload();
    await toReview(page, 'Człowiek z bronią');
    const fix = await draftFix();
    expect(fix?.accuracy_m).toBe(accuracy);
    expect(fix?.lat).toBeCloseTo(reading.latitude, 5);
    expect(fix?.lon).toBeCloseTo(reading.longitude, 5);
    return reading;
  };
  const send = async () => {
    const posted = page.waitForRequest(request => request.method() === 'POST' && request.url().endsWith('/api/reports'));
    await save(page);
    return (await posted).postDataJSON();
  };

  // Controls: 149 m is masked and 160 m with a good fix is sent as it is, neither with a question.
  await review(149, 8);
  await expect(page.locator('#home-check')).toHaveCount(0);
  expect((await send()).incident_location).toMatchObject({ precise_fix_withheld: 'home_privacy' });
  await review(160, 8);
  await expect(page.locator('#home-check')).toHaveCount(0);
  expect((await send()).device_fix).toMatchObject({ accuracy_m: 8 });

  // The audit's case: 160 m away, Accuracy 150 m. Nothing leaves before the answer.
  const postsBefore = posts.length;
  await review(160, 150);
  await expect(page.locator('#home-check')).toBeVisible();
  // Saving with the question unanswered is refused on screen, and nothing is posted.
  // Zapisz stays pressable on purpose (aria-disabled), so the click is forced.
  await expect(page.locator('#draft-next')).toContainText('Odpowiedz na pytanie o dom.');
  await expect(async () => {
    await footer(page).getByRole('button', { name: 'Zapisz zgłoszenie' }).click({ force: true });
    await expect(page.locator('#home-check.missing')).toBeVisible({ timeout: 1500 });
  }).toPass();
  expect(posts).toHaveLength(postsBefore);
  await answerHome(page, true);
  const masked = await send();
  expect(masked.device_fix).toBeNull();
  expect(masked.incident_location).toMatchObject({ type: 'area', precise_fix_withheld: 'home_privacy' });
  expect(JSON.stringify(masked)).not.toContain(String(home.lat));
  expect(JSON.stringify(masked)).not.toContain(String(home.lon));

  const reading = await review(160, 150);
  await expect(page.locator('#home-check')).toBeVisible();
  await answerHome(page, false);
  const exact = await send();
  expect(exact.device_fix).toMatchObject({ accuracy_m: 150 });
  expect(exact.device_fix.lat).toBeCloseTo(reading.latitude, 5);
  expect(exact.device_fix.lon).toBeCloseTo(reading.longitude, 5);
});

test('Menu keeps one delete confirmation open, and Escape returns focus to its own row', async ({ page, context }) => {
  const home = points.barn.point;
  await context.setGeolocation({ latitude: home.lat, longitude: home.lon, accuracy: 12 });
  await page.route('**/api/reports', route => route.fulfill({ status: 201, contentType: 'application/json', body: '{"id":"accepted"}' }));
  await page.route('**/api/reports/*/findings', route => route.fulfill({ json: { status: 'pending' } }));
  await page.goto('/');
  await toReview(page, 'Człowiek z bronią');
  await answerHome(page, true);
  await save(page);
  await expect(heading(page, /^Zgłoszenie$/)).toBeVisible();
  await page.evaluate(() => new Promise<void>((resolve, reject) => {
    const request = indexedDB.open('bor-czuwa');
    request.onsuccess = () => {
      const db = request.result;
      const t = db.transaction('signer', 'readwrite');
      t.objectStore('signer').put({ id: 'mine', details: { name: 'Anna Nowak', address: 'ul. Polna 2' } });
      t.oncomplete = () => { db.close(); resolve(); };
      t.onerror = () => reject(t.error);
    };
    request.onerror = () => reject(request.error);
  }));
  await page.reload();
  await page.getByRole('button', { name: 'Menu' }).click();
  const homeRemove = page.getByRole('button', { name: 'Usuń zapisany dom' });
  const signerRemove = page.getByRole('button', { name: 'Usuń zapamiętane dane podpisu' });
  const homeConfirm = page.getByRole('group', { name: 'Usunąć zapisany dom?' });
  const signerConfirm = page.getByRole('group', { name: 'Usunąć zapamiętane dane podpisu?' });
  await homeRemove.click();
  await expect(homeConfirm).toBeVisible();
  await signerRemove.click();
  await expect(signerConfirm).toBeVisible();
  await expect(homeConfirm).toHaveCount(0);
  await page.keyboard.press('Escape');
  await expect(signerConfirm).toHaveCount(0);
  await expect(signerRemove).toBeFocused();
  await signerRemove.click();
  await homeRemove.click();
  await expect(signerConfirm).toHaveCount(0);
  await expect(homeConfirm).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(homeConfirm).toHaveCount(0);
  await expect(homeRemove).toBeFocused();
});

test('a delete confirmation shows its focus indicator, and focus waits until the panel is visible', async ({ page, context }) => {
  const home = points.barn.point;
  await context.setGeolocation({ latitude: home.lat, longitude: home.lon, accuracy: 12 });
  await page.route('**/api/reports', route => route.fulfill({ status: 201, contentType: 'application/json', body: '{"id":"accepted"}' }));
  await page.route('**/api/reports/*/findings', route => route.fulfill({ json: { status: 'pending' } }));
  await page.goto('/');
  await toReview(page, 'Człowiek z bronią');
  await answerHome(page, true);
  await save(page);
  await expect(heading(page, /^Zgłoszenie$/)).toBeVisible();
  await page.evaluate(() => new Promise<void>((resolve, reject) => {
    const request = indexedDB.open('bor-czuwa');
    request.onsuccess = () => {
      const db = request.result;
      const t = db.transaction('signer', 'readwrite');
      t.objectStore('signer').put({ id: 'mine', details: { name: 'Anna Nowak', address: 'ul. Polna 2' } });
      t.oncomplete = () => { db.close(); resolve(); };
      t.onerror = () => reject(t.error);
    };
    request.onerror = () => reject(request.error);
  }));
  await page.reload();
  await page.getByRole('button', { name: 'Menu' }).click();
  for (const [row, title] of [['Usuń zapisany dom', 'Usunąć zapisany dom?'], ['Usuń zapamiętane dane podpisu', 'Usunąć zapamiętane dane podpisu?']]) {
    const confirm = page.getByRole('group', { name: title });
    await page.getByRole('button', { name: row }).focus();
    await page.evaluate(() => {
      const w = window as unknown as { early: number; frames: number };
      w.early = 0; w.frames = 0;
      const loop = () => {
        const panel = document.querySelector('.home-confirm');
        const a = document.activeElement;
        if (panel && a && panel.contains(a)) { w.frames++; if (Number(getComputedStyle(panel).opacity) < 1) w.early++; }
        requestAnimationFrame(loop);
      };
      requestAnimationFrame(loop);
    });
    await page.keyboard.press('Enter');
    const anuluj = confirm.getByRole('button', { name: 'Anuluj' });
    await expect(anuluj).toBeFocused();
    await page.waitForTimeout(300);
    const early = await page.evaluate(() => (window as unknown as { early: number }).early);
    expect(early, `${title}: frames with focus inside a panel still fading in`).toBe(0);
    for (const button of [anuluj, confirm.getByRole('button', { name: 'Usuń', exact: true })]) {
      await button.focus();
      await page.keyboard.press('Shift+Tab'); await page.keyboard.press('Tab');
      const ring = await button.evaluate(el => { const s = getComputedStyle(el); const r = el.getBoundingClientRect(); const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
        const foot = document.querySelector('.screen-foot')?.getBoundingClientRect().top ?? innerHeight;
        return { style: s.outlineStyle, width: parseFloat(s.outlineWidth), color: s.outlineColor, offset: parseFloat(s.outlineOffset), obscured: !(top === el || el.contains(top)) || r.bottom + 5 > foot }; });
      expect(ring).toMatchObject({ style: 'solid', width: 3, obscured: false });
      expect(ring.color).not.toBe('rgba(0, 0, 0, 0)');
    }
    await page.keyboard.press('Escape');
    await expect(confirm).toHaveCount(0);
  }
});

test('a quick Tab after opening a Menu confirm does not walk into it or lose focus to Anuluj', async ({ page, context }) => {
  const home = points.barn.point;
  await context.setGeolocation({ latitude: home.lat, longitude: home.lon, accuracy: 12 });
  await page.route('**/api/reports', route => route.fulfill({ status: 201, contentType: 'application/json', body: '{"id":"accepted"}' }));
  await page.route('**/api/reports/*/findings', route => route.fulfill({ json: { status: 'pending' } }));
  await page.goto('/');
  await toReview(page, 'Człowiek z bronią');
  await answerHome(page, true);
  await save(page);
  await expect(heading(page, /^Zgłoszenie$/)).toBeVisible();
  await page.evaluate(() => new Promise<void>((resolve, reject) => {
    const request = indexedDB.open('bor-czuwa');
    request.onsuccess = () => {
      const db = request.result;
      const t = db.transaction('signer', 'readwrite');
      t.objectStore('signer').put({ id: 'mine', details: { name: 'Anna Nowak', address: 'ul. Polna 2' } });
      t.oncomplete = () => { db.close(); resolve(); };
      t.onerror = () => reject(t.error);
    };
    request.onerror = () => reject(request.error);
  }));
  await page.reload();
  await page.getByRole('button', { name: 'Menu' }).click();
  await expectQuickTabStaysOut(page, page.getByRole('button', { name: 'Usuń zapamiętane dane podpisu' }), '.signer-confirm');
  await page.keyboard.press('Escape');
  await expectQuickTabStaysOut(page, page.getByRole('button', { name: 'Usuń zapisany dom' }), '.home-confirm');
});
