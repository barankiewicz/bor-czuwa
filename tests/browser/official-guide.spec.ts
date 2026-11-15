import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { translate, type Language } from '../../src/lib/strings.ts';
import { demoRecipient } from './demo.ts';
import { settled } from './stages.ts';

const findings = JSON.parse(await readFile(new URL('./computed-findings.json', import.meta.url), 'utf8'));
const reportId = '352ad090-8888-4888-8888-888888888888';
const noticeId = '552ad090-8888-4888-8888-888888888888';
const at = '2026-10-05T12:00:00Z';
test.use({ serviceWorkers: 'block' });

for (const language of ['pl', 'en'] as Language[]) test(`official guide keeps its outline and routes in ${language}`, async ({ page }, testInfo) => {
  const t = (value: string) => translate(language, value);
  await page.addInitScript(language => {
    localStorage.setItem('first-launch-seen', '1');
    localStorage.setItem('interface-language', language);
  }, language);
  const apiMethods: string[] = [];
  page.on('request', request => { if (new URL(request.url()).pathname.startsWith('/api/')) apiMethods.push(request.method()); });
  await page.route('**/api/**', route => route.fulfill({ status: 503, json: { error: 'disposable_no_server' } }));
  await page.goto('/');
  await expect(page.getByRole('heading', { name: t('Co się stało?'), exact: true })).toBeVisible();
  for (const variant of ['signed', 'unsigned'] as const) for (const email of [null, 'test-recipient@example.invalid']) {
    await page.evaluate(async ({ variant, email, findings, reportId, noticeId, at }) => {
      const db = await new Promise<IDBDatabase>(resolve => {
        const request = indexedDB.open('bor-czuwa'); request.onsuccess = () => resolve(request.result);
      });
      const tx = db.transaction(['reports', 'signer'], 'readwrite');
      tx.objectStore('reports').put({ report: { id: reportId, event_type: 'shot', captured_at: at,
        occurred_at: { at, source: 'device_clock', coarseness: 'exact' }, device_fix: null,
        incident_location: { lat: 53.403481, lon: 22.658699, source: 'moved_by_reporter' }, species: null, has_note: false,
        app_version: '0.1.0', privacy_policy_version: '1', terms_of_use_version: '1', token_sha256: '0'.repeat(64) },
      token: '1'.repeat(64), findings, events: [{ kind: 'created', at }, { kind: 'synced', at }],
      notices: [{ id: noticeId, recipient: { kind: 'police', id: 'police.fixture', name: 'Urząd testowy', email },
        others: [], variant, events: [{ id: '652ad090-8888-4888-8888-888888888888', kind: 'notice_composed',
          notice_id: noticeId, recipient_kind: 'police', unit_id: 'police.fixture', template_version: '1', directory_version: '1', at, synced: true }] }] });
      tx.objectStore('signer').put({ id: 'mine', details: { name: 'Osoba Testowa', address: 'Fikcyjna 1', phone: '' } });
      await new Promise<void>(resolve => { tx.oncomplete = () => resolve(); }); db.close();
    }, { variant, email, findings, reportId, noticeId, at });
    await page.goto(`/?screen=notice&report=${reportId}&notice=${noticeId}`);
    await expect(page.getByRole('heading', { level: 1, name: 'Urząd testowy' })).toBeVisible();
    const guide = page.locator('.official-filing');
    if (variant === 'unsigned') {
      await expect(page.locator('.handoff-route strong')).toHaveText(t(email || demoRecipient ? 'Wyślesz ze swojej poczty' : 'Brak potwierdzonego adresu'));
      await expect(guide).toHaveCount(0);
      continue;
    }
    if (email || demoRecipient) {
      await expect(page.locator('.handoff-route strong')).toHaveText(t('Wyślesz ze swojej poczty'));
      await expect(guide).toHaveCount(0);
      await page.getByRole('button', { name: t(demoRecipient ? 'Pobierz testowy PDF' : 'Złóż PDF w serwisie urzędowym'), exact: true }).first().click();
    }
    if (demoRecipient) { await expect(guide).toHaveCount(0); continue; }
    await page.locator('summary', { hasText: t('Jak złożyć przez ePUAP lub e-Doręczenia?') }).click();
    await settled(page);
    await guide.evaluate(element => element.scrollIntoView({ block: 'start', behavior: 'instant' }));
    await page.screenshot({ path: testInfo.outputPath(`guide-${email ? 'email' : 'no-email'}.png`) });
    await testInfo.attach(`guide-${email ? 'email' : 'no-email'}-outline`, { contentType: 'application/json',
      body: JSON.stringify(await page.locator('main h1, main h2, main h3').evaluateAll(headings => headings.map(heading => {
        const style = getComputedStyle(heading);
        return { tag: heading.tagName, text: heading.textContent, family: style.fontFamily, size: style.fontSize,
          weight: style.fontWeight, lineHeight: style.lineHeight, marginTop: style.marginTop, marginBottom: style.marginBottom };
      }))) });
    await expect(guide.getByRole('heading', { level: 2 })).toHaveText(['ePUAP', 'e-Doręczenia']);
    await expect(guide.getByRole('heading', { level: 3 })).toHaveCount(0);
    await expect(page.locator('main .badge')).toHaveCount(0);
    await expect(guide.getByRole('link', { name: t('Otwórz instrukcję ePUAP') })).toHaveAttribute('href', 'https://www.gov.pl/web/gov/wyslij-pismo-ogolne');
    await expect(guide.getByRole('link', { name: t('Otwórz e-Doręczenia'), exact: true })).toHaveAttribute('href', 'https://www.gov.pl/web/e-doreczenia');
    const download = page.waitForEvent('download');
    await page.getByRole('button', { name: t('Pobierz PDF'), exact: true }).click();
    await download;
    await expect(page.locator('#handoff-question')).toBeFocused();
    await expect(page.locator('#handoff-question')).toHaveText(t('Udało się wysłać?'));
    await expect(guide.getByRole('heading', { level: 2 })).toHaveText(['ePUAP', 'e-Doręczenia']);
    expect(await page.locator('main h1, main h2, main h3').evaluateAll(headings => headings.map(heading => heading.tagName))).toEqual(['H1', 'H2', 'H2', 'H2']);
    await expect(page.locator('main .badge')).toHaveCount(0);
  }
  expect(apiMethods.every(method => method === 'GET')).toBe(true);
});
