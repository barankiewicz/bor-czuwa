import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { translate, type Language } from '../../src/lib/strings.ts';
import { settled } from './stages.ts';

const findings = JSON.parse(await readFile(new URL('./computed-findings.json', import.meta.url), 'utf8'));
const reportId = '252ad090-8888-4888-8888-888888888888';
const at = '2026-10-05T12:00:00Z';
test.use({ serviceWorkers: 'block' });

for (const language of ['pl', 'en'] as Language[]) test(`Findings source targets preserve destinations and local data in ${language}`, async ({ page, context }) => {
  const t = (value: string) => translate(language, value);
  await page.addInitScript(language => {
    localStorage.setItem('first-launch-seen', '1');
    localStorage.setItem('interface-language', language);
  }, language);
  const methods: string[] = [];
  page.on('request', request => { if (new URL(request.url()).pathname.startsWith('/api/')) methods.push(request.method()); });
  await page.route('**/api/**', route => route.fulfill({ status: 503, json: { error: 'disposable_no_server' } }));
  await page.goto('/');
  await expect(page.getByRole('heading', { name: t('Co się stało?'), exact: true })).toBeVisible();
  await page.evaluate(async ({ reportId, at, findings }) => {
    const db = await new Promise<IDBDatabase>(resolve => {
      const request = indexedDB.open('bor-czuwa'); request.onsuccess = () => resolve(request.result);
    });
    const tx = db.transaction('reports', 'readwrite');
    tx.objectStore('reports').put({ report: { id: reportId, event_type: 'shot', captured_at: at,
      occurred_at: { at, source: 'device_clock', coarseness: 'exact' }, device_fix: null,
      incident_location: { lat: 53.403481, lon: 22.658699, source: 'moved_by_reporter' }, species: null, has_note: true,
      app_version: '0.1.1', privacy_policy_version: '1', terms_of_use_version: '1', token_sha256: '0'.repeat(64) },
    token: '1'.repeat(64), findings, note: 'Fikcyjna notatka lokalna.',
    events: [{ kind: 'created', at }, { kind: 'synced', at }], notices: [] });
    await new Promise<void>(resolve => { tx.oncomplete = () => resolve(); }); db.close();
  }, { reportId, at, findings });
  await page.goto(`/?screen=report&report=${reportId}`);
  await expect(page.getByRole('heading', { name: t('Zgłoszenie'), exact: true })).toBeVisible();
  // Ticket 30 moved every source into one sheet, opened from the end of the Findings.
  await page.getByRole('button', { name: t('Skąd te wyniki'), exact: true }).focus();
  await page.keyboard.press('Enter');
  const disclosure = page.getByRole('dialog', { name: t('Skąd te wyniki') });
  await expect(disclosure).toBeVisible();
  await settled(page);
  // The sheet rises 16 px over 220 ms; a box measured mid-flight carries a fractional translation, and Chromium's
  // float32 quads then report 55.99997 for a 56 px target. Measure only once the sheet has landed.
  await page.waitForFunction(() => document.getAnimations().length === 0);
  const links = [
    // Literal names, so a missing English translation fails here instead of being echoed back by translate().
    { name: { pl: 'Bank Danych o Lasach', en: 'Forest Data Bank (Bank Danych o Lasach)' }[language], href: findings.obwod_lowiecki.source_url },
    { name: 'OpenStreetMap contributors', href: 'https://www.openstreetmap.org/copyright' },
    { name: 'ODbL', href: 'https://opendatacommons.org/licenses/odbl/1-0/' },
    { name: t('Pobierz zbiór oznaczonych ambon (ODbL)'), href: `/api/geodata/${findings.geodata_snapshot_id}/ambony` }
  ];
  const bounds = [];
  for (const { name, href } of links) {
    const link = disclosure.getByRole('link', { name, exact: true });
    await expect(link).toHaveAttribute('href', href);
    for (let step = 0; step < 60 && !await link.evaluate(element => element === document.activeElement); step++) await page.keyboard.press('Tab');
    await expect(link).toBeFocused();
    await link.evaluate(element => element.scrollIntoView({ block: 'center', behavior: 'instant' }));
    const box = await link.boundingBox();
    expect(box).not.toBeNull();
    expect(box!.width).toBeGreaterThanOrEqual(56);
    expect(box!.height).toBeGreaterThanOrEqual(56);
    const top = await link.evaluate(element => element.getBoundingClientRect().top + document.querySelector('.sheet-body')!.scrollTop);
    bounds.push({ top, bottom: top + box!.height });
    expect(await link.evaluate(element => getComputedStyle(element).outlineStyle)).toBe('solid');
    if (href.startsWith('https:')) {
      await expect(link).toHaveAttribute('target', '_blank');
      await expect(link).toHaveAttribute('rel', 'noreferrer');
    }
  }
  for (let i = 1; i < bounds.length; i++) expect(bounds[i].top).toBeGreaterThanOrEqual(bounds[i - 1].bottom);
  await expect(disclosure).toContainText(findings.geodata_snapshot_id);
  const osm = findings.datasets.find((dataset: { name: string }) => dataset.name === 'OpenStreetMap hunting stands');
  const day = (at: string) => new Date(at.length === 10 ? `${at}T12:00:00Z` : at).toLocaleDateString(language === 'en' ? 'en-GB' : 'pl-PL',
    { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Europe/Warsaw' });
  await expect(disclosure).toContainText(day(osm.publisher_date ?? osm.retrieved_at));
  await expect(disclosure).toContainText(day(osm.retrieved_at));
  await expect(disclosure).toContainText(t('Dane o obwodach łowieckich mają charakter poglądowy.'));
  await expect(disclosure).toContainText(t('Pokrycie OpenStreetMap jest niepełne. Wynik nie potwierdza polowania ani naruszenia prawa; brak oznaczenia nie potwierdza braku ambony.'));
  await context.route('https://opendatacommons.org/licenses/odbl/1-0/', route => route.fulfill({ contentType: 'text/plain', body: 'Intercepted licence destination.' }));
  const popup = page.waitForEvent('popup');
  await disclosure.getByRole('link', { name: 'ODbL', exact: true }).press('Enter');
  const licence = await popup; await licence.waitForLoadState();
  expect(licence.url()).toBe('https://opendatacommons.org/licenses/odbl/1-0/');
  await licence.close();
  await page.route(`**/api/geodata/${findings.geodata_snapshot_id}/ambony`, route => route.fulfill({
    contentType: 'application/geo+json-seq', headers: { 'content-disposition': 'attachment; filename="synthetic-stands.geojsonseq"' }, body: '\u001e{"type":"Feature","geometry":null,"properties":{}}\n'
  }));
  const download = page.waitForEvent('download');
  await disclosure.getByRole('link', { name: t('Pobierz zbiór oznaczonych ambon (ODbL)'), exact: true }).press('Enter');
  expect((await download).suggestedFilename()).toBe('synthetic-stands.geojsonseq');
  await page.keyboard.press('Escape');
  await expect(disclosure).toBeHidden();
  await expect(page.getByRole('button', { name: t('Skąd te wyniki'), exact: true })).toBeFocused();
  const retained = await page.evaluate(async reportId => {
    const db = await new Promise<IDBDatabase>(resolve => {
      const request = indexedDB.open('bor-czuwa'); request.onsuccess = () => resolve(request.result);
    });
    const request = db.transaction('reports').objectStore('reports').get(reportId);
    const local = await new Promise<{ findings: unknown; note: string; report: { id: string } }>(resolve => { request.onsuccess = () => resolve(request.result); });
    db.close(); return { findings: local.findings, note: local.note, id: local.report.id };
  }, reportId);
  expect(retained).toEqual({ findings, note: 'Fikcyjna notatka lokalna.', id: reportId });
  expect(methods.every(method => method === 'GET')).toBe(true);
});
