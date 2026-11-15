import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { settled } from './stages.ts';
import { expectedEnglish } from '../dataset-names-expected.ts';

const base = JSON.parse(await readFile(new URL('./computed-findings.json', import.meta.url), 'utf8'));
const reportId = '252ad090-6666-4666-8666-666666666666';
const at = '2026-10-05T12:00:00Z';
// Every identifier the sheet can list, the fallback included, and the Polish line each one would show.
const listed = Object.keys(expectedEnglish);
// The sheet lists datasets by prefix (BDOT10k, GDOS, GDOŚ, CRFOP, OpenStreetMap). BDL, PRG and the OpenStreetMap stands are never listed as names:
// the Bank Danych o Lasach shows as the hunting-district link instead, and the unit test covers all 15 names.
const notListed = ['BDL', 'Bank Danych o Lasach', 'PRG', 'OpenStreetMap hunting stands'];
const polish = ['Baza Danych Obiektów Topograficznych, ', 'zabudowania', 'obszary chronione', 'parki narodowe', 'rezerwaty przyrody',
  'parki krajobrazowe', 'obszary specjalnej ochrony ptaków', 'specjalne obszary ochrony', 'Centralny Rejestr', 'Bank Danych o Lasach, ',
  'Państwowy Rejestr', 'ambony z OpenStreetMap', 'zbiór danych przestrzennych'];
const findings = { ...base, datasets: listed.map(name => ({ name, retrieved_at: at, publisher_date: '2026-09-24' })) };
test.use({ serviceWorkers: 'block' });

test('the English sources sheet names every dataset in English', async ({ page }, testInfo) => {
  await page.addInitScript(() => {
    localStorage.setItem('first-launch-seen', '1'); localStorage.setItem('interface-language', 'en');
    // From the first frame of every document: the text of each source line and link, every frame.
    const samples: { ms: number; text: string }[] = [];
    (window as unknown as { __sources: typeof samples }).__sources = samples;
    const sample = () => {
      const text = [...document.querySelectorAll('dialog .sheet-sources li, dialog .source-link')].map(node => node.textContent).join('|');
      samples.push({ ms: Math.round(performance.now()), text }); requestAnimationFrame(sample);
    };
    requestAnimationFrame(sample);
  });
  await page.route('**/api/**', route => route.fulfill({ status: 503, json: { error: 'disposable_no_server' } }));
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'What happened?', exact: true })).toBeVisible();
  await page.evaluate(async ({ reportId, at, findings }) => {
    const db = await new Promise<IDBDatabase>(resolve => {
      const request = indexedDB.open('bor-czuwa'); request.onsuccess = () => resolve(request.result);
    });
    const tx = db.transaction('reports', 'readwrite');
    tx.objectStore('reports').put({ report: { id: reportId, event_type: 'shot', captured_at: at,
      occurred_at: { at, source: 'device_clock', coarseness: 'exact' }, device_fix: null,
      incident_location: { lat: 53.403481, lon: 22.658699, source: 'moved_by_reporter' }, species: null, has_note: false,
      app_version: '0.1.3', privacy_policy_version: '1', terms_of_use_version: '1', token_sha256: '0'.repeat(64) },
    token: '1'.repeat(64), findings, events: [{ kind: 'created', at }, { kind: 'synced', at }], notices: [] });
    await new Promise<void>(resolve => { tx.oncomplete = () => resolve(); }); db.close();
  }, { reportId, at, findings });
  await page.goto(`/?screen=report&report=${reportId}`);
  await page.getByRole('button', { name: 'Where these results come from', exact: true }).click();
  const sheet = page.getByRole('dialog');
  await expect(sheet).toBeVisible();
  await settled(page);
  await page.waitForFunction(() => document.getAnimations().length === 0);
  const items = await sheet.locator('.sheet-sources li').allInnerTexts();
  expect(items.length, items.join('\n')).toBeGreaterThanOrEqual(listed.length - notListed.length);
  // Some English names keep the Polish proper name in brackets, so compare where each line begins.
  for (const name of listed.filter(name => !notListed.includes(name))) expect(items.some(item => item.startsWith(`${expectedEnglish[name]}, as of`)), name).toBe(true);
  for (const line of polish) expect(items.some(item => item.startsWith(line)), line).toBe(false);
  // The hunting-district link names its source in English too, and no link keeps the Polish name.
  const links = await sheet.locator('.source-link').allInnerTexts();
  expect(links).toContain(expectedEnglish['Bank Danych o Lasach']);
  expect(links.some(link => link.trim() === 'Bank Danych o Lasach')).toBe(false);
  // The text is final from the first frame it exists in: every sample taken since page start that holds source
  // text holds the same text. The samples stay with the test run.
  await page.waitForFunction(() => (window as unknown as { __sources: { text: string }[] }).__sources.filter(sample => sample.text).length >= 6);
  const samples = await page.evaluate(() => (window as unknown as { __sources: { ms: number; text: string }[] }).__sources);
  await testInfo.attach('sources-samples.json', { body: JSON.stringify(samples), contentType: 'application/json' });
  const filled = samples.filter(sample => sample.text);
  expect(filled.length).toBeGreaterThan(5);
  expect(new Set(filled.map(sample => sample.text)).size).toBe(1);
});
