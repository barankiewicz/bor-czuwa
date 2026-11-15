import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { expectCurrentConfirmation } from './stages.ts';
import { demoRecipient, pdfConfirmation, pdfSwitch } from './demo.ts';

const findings = JSON.parse(await readFile(new URL('./computed-findings.json', import.meta.url), 'utf8'));
const expected = 'Zapisano Twoje potwierdzenie. To nie jest potwierdzenie doręczenia.';
const oldText = () => demoRecipient ? 'PDF testowy gotowy. Przekaż go tylko do skrzynki testowej.'
  : 'PDF przygotowany. Podpisz i złóż pismo w serwisie urzędowym.';

test.use({ viewport: { width: 320, height: 568 }, serviceWorkers: 'block' });

test('current confirmation stays unique while the previous native outro remains inert', async ({ page }, testInfo) => {
  await page.addInitScript(() => {
    localStorage.setItem('first-launch-seen', '1');
    document.addEventListener('DOMContentLoaded', () => { document.documentElement.style.fontSize = '34px'; });
  });
  await page.route('**/api/**', route => route.fulfill({ status: 503, json: { error: 'disposable_no_server' } }));
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Co się stało?', exact: true })).toBeVisible();
  const reportId = '352ad090-8888-4888-8888-888888888888', noticeId = '552ad090-8888-4888-8888-888888888888', at = '2026-10-05T12:00:00Z';
  await page.evaluate(async ({ findings, reportId, noticeId, at }) => {
    const db = await new Promise<IDBDatabase>(resolve => {
      const request = indexedDB.open('bor-czuwa'); request.onsuccess = () => resolve(request.result);
    });
    const tx = db.transaction(['reports', 'signer'], 'readwrite');
    tx.objectStore('reports').put({ report: { id: reportId, event_type: 'shot', captured_at: at,
      occurred_at: { at, source: 'device_clock', coarseness: 'exact' }, device_fix: null,
      incident_location: { lat: 53.403481, lon: 22.658699, source: 'moved_by_reporter' }, species: null,
      has_note: false, app_version: '0.1.0', privacy_policy_version: '1', terms_of_use_version: '1', token_sha256: '0'.repeat(64) },
    token: '1'.repeat(64), findings, events: [{ kind: 'created', at }, { kind: 'synced', at }],
    notices: [{ id: noticeId, recipient: { kind: 'police', id: 'police.fixture', name: 'Urząd testowy', email: 'synthetic-authority@example.invalid' },
      others: [], variant: 'signed', events: [{ id: '652ad090-8888-4888-8888-888888888888', kind: 'notice_composed',
        notice_id: noticeId, recipient_kind: 'police', unit_id: 'police.fixture', template_version: '1', directory_version: '1', at, synced: true }] }] });
    tx.objectStore('signer').put({ id: 'mine', details: { name: 'Osoba Testowa', address: 'Fikcyjna 1', phone: '' } });
    await new Promise<void>(resolve => { tx.oncomplete = () => resolve(); }); db.close();
  }, { findings, reportId, noticeId, at });
  await page.goto(`/?screen=notice&report=${reportId}&notice=${noticeId}`);
  await expect(page.getByRole('heading', { name: 'Urząd testowy', exact: true })).toBeVisible();
  await page.getByRole('button', { name: pdfSwitch, exact: true }).first().click();
  const download = page.waitForEvent('download');
  await page.locator('.screen-foot').getByRole('button', { name: 'Pobierz PDF', exact: true }).click();
  await download;
  await expect(page.getByRole('heading', { name: 'Udało się wysłać?', exact: true })).toBeVisible();
  await expect(page.locator('.brief-confirmation').filter({ hasText: oldText() })).toBeVisible();
  await page.evaluate(text => {
    const original = Element.prototype.animate;
    const held: Animation[] = [];
    (window as any).confirmationOutro = { held, restore: () => { Element.prototype.animate = original; } };
    Element.prototype.animate = function (this: Element, ...args: Parameters<Element['animate']>) {
      const animation = Reflect.apply(original, this, args) as Animation;
      if (this.matches('.brief-confirmation') && this.textContent?.trim() === text
        && Number(animation.effect?.getComputedTiming().duration) > 0) {
        animation.pause(); held.push(animation);
      }
      return animation;
    };
  }, oldText());
  try {
    await page.getByRole('button', { name: pdfConfirmation, exact: true }).click();
    await expect.poll(() => page.evaluate(() => (window as any).confirmationOutro.held.length)).toBeGreaterThan(0);
    await expect(page.locator('.brief-confirmation')).toHaveCount(2);
    await expect(page.locator('.brief-confirmation[inert]')).toHaveText(oldText());
    await expectCurrentConfirmation(page, expected);
    await expect(page.locator('.sr-only[role="status"][aria-live="polite"]')).toHaveText(expected);
    await testInfo.attach('confirmation-ownership', { body: JSON.stringify(await page.locator('.brief-confirmation').evaluateAll(nodes =>
      nodes.map(node => ({ text: node.textContent, inert: node.hasAttribute('inert'), ariaHidden: node.getAttribute('aria-hidden'),
        animations: node.getAnimations().map(animation => ({ duration: animation.effect?.getComputedTiming().duration, state: animation.playState })) })))), contentType: 'application/json' });
  } finally {
    await page.evaluate(() => { const state = (window as any).confirmationOutro; state.restore(); state.held.forEach((animation: Animation) => animation.finish()); });
  }
});

for (const state of ['outgoing-only', 'two-active'] as const) test(`confirmation assertion rejects ${state}`, async ({ page }) => {
  await page.setContent(state === 'outgoing-only'
    ? `<div inert aria-hidden="true" class="brief-confirmation">${expected}</div>`
    : `<div aria-hidden="true" class="brief-confirmation">${expected}</div><div aria-hidden="true" class="brief-confirmation">Different current text</div>`);
  await expect(expectCurrentConfirmation(page, expected)).rejects.toThrow();
});
