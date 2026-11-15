import { test, expect, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { settled } from './stages.ts';
import { translate, type Language } from '../../src/lib/strings.ts';

// Ticket 30: the Report-ready screen reads top down as confirmation, the next action, the Findings,
// then the details and the ways out. Provenance lives only in "Skąd te wyniki".
const findings = JSON.parse(await readFile(new URL('./computed-findings.json', import.meta.url), 'utf8'));
const at = '2026-10-05T12:00:00Z';
test.use({ serviceWorkers: 'block' });

async function openStored(page: Page, id: string, report: object, stored: object, language: Language = 'pl') {
  await page.addInitScript(value => {
    localStorage.setItem('first-launch-seen', '1');
    localStorage.setItem('interface-language', value);
  }, language);
  await page.route('**/api/**', route => route.fulfill({ status: 503, json: { error: 'disposable_no_server' } }));
  await page.goto('/');
  await expect(page.getByRole('heading', { name: translate(language, 'Co się stało?'), exact: true })).toBeVisible();
  await page.evaluate(async ({ id, at, report, stored }) => {
    const db = await new Promise<IDBDatabase>(resolve => {
      const request = indexedDB.open('bor-czuwa'); request.onsuccess = () => resolve(request.result);
    });
    const tx = db.transaction('reports', 'readwrite');
    tx.objectStore('reports').put({ report: { id, event_type: 'person_with_gun', captured_at: at,
      occurred_at: { at, source: 'device_clock', coarseness: 'exact' }, species: null, photo_sha256: [], has_note: false,
      app_version: '0.1.1', privacy_policy_version: '1', terms_of_use_version: '1', token_sha256: '0'.repeat(64), ...report },
    token: '1'.repeat(64), note: '', events: [{ kind: 'created', at }, { kind: 'synced', at }], notices: [], ...stored });
    await new Promise<void>(resolve => { tx.oncomplete = () => resolve(); }); db.close();
  }, { id, at, report, stored });
  await page.goto(`/?screen=report&report=${id}`);
  await expect(page.getByRole('heading', { name: translate(language, 'Zgłoszenie'), exact: true })).toBeVisible();
  await settled(page);
}

test('Report-ready screen puts the action before open Findings and keeps provenance in one sheet', async ({ page }) => {
  await openStored(page, '352ad090-8888-4888-8888-888888888888', {
    device_fix: { lat: 53.403481, lon: 22.658699, accuracy_m: 8, at }, incident_location: { lat: 53.403481, lon: 22.658699, source: 'device_fix' }
  }, { findings });
  const body = page.locator('.screen-body');
  // Top-down order of the screen's landmarks.
  const order = [
    page.getByRole('heading', { name: 'Zgłoszenie', exact: true }),
    page.getByText('Nr zapisu'),
    page.getByRole('list', { name: 'Stan zgłoszenia' }),
    page.getByRole('button', { name: 'Przygotuj powiadomienie' }),
    page.getByRole('heading', { name: 'Co wynika z pomiarów', level: 2 }),
    page.getByRole('button', { name: 'Skąd te wyniki' }),
    page.locator('summary', { hasText: 'Szczegóły zgłoszenia' }),
    page.getByRole('button', { name: 'Wycofaj zgłoszenie' }),
    page.getByRole('button', { name: 'Gotowe, wróć do początku' })
  ];
  let previous = -Infinity;
  for (const item of order) {
    const top = await item.evaluate(element => element.getBoundingClientRect().top);
    expect(top).toBeGreaterThan(previous);
    previous = top;
  }
  // The result is open and is said once: the status list keeps only the sync state.
  await expect(page.getByRole('list', { name: 'Stan zgłoszenia' })).not.toContainText('Pomiary');
  const facts = page.locator('.facts-list > li');
  await expect(facts).toHaveCount(5);
  expect(await facts.evaluateAll(items => items.map(item => item.getAttribute('data-fact')))).toEqual(['dwelling', 'protected', 'noc', 'obwod', 'ambona']);
  await expect(facts.first()).toContainText('140 m');
  await expect(facts.first()).toContainText('±8 m');
  await expect(facts.first()).toContainText('Bliżej niż 150 m');
  await expect(page.locator('.unchecked')).toHaveText('Nie sprawdzono: okres ochronny (nie podano gatunku).');
  await expect(page.locator('[data-fact="ambona"]')).toContainText('ODbL');
  // No ids, hashes, dates of sources or statute citations on the main screen.
  for (const hidden of [findings.rule_set_id, findings.geodata_snapshot_id, 'Dz.U.', 'Zestaw reguł', 'Migawka', 'Pobrano'])
    await expect(body).not.toContainText(hidden, { useInnerText: true });

  const opener = page.getByRole('button', { name: 'Skąd te wyniki' });
  await opener.click();
  const sheet = page.getByRole('dialog', { name: 'Skąd te wyniki' });
  await expect(sheet).toBeVisible();
  // The sheet rises 16 px over 220 ms. Measured in flight, a 56 px target carries a fractional translation and
  // reads 55.9998 (first frame, translateY 14.03 px). Measure only once nothing animates.
  await page.waitForFunction(() => document.getAnimations().length === 0);
  for (const shown of [findings.rule_set_id, findings.geodata_snapshot_id, 'Dz.U. 2018 poz. 651',
    'Dane o obwodach łowieckich mają charakter poglądowy.', 'Pokrycie OpenStreetMap jest niepełne.'])
    await expect(sheet).toContainText(shown);
  await expect(sheet.locator('[aria-labelledby="sources-protected"]')).toContainText('Granicę porównuje się z dokładnością punktu.');
  for (const [name, href] of [['OpenStreetMap contributors', 'https://www.openstreetmap.org/copyright'],
    ['ODbL', 'https://opendatacommons.org/licenses/odbl/1-0/'],
    ['Pobierz zbiór oznaczonych ambon (ODbL)', `/api/geodata/${findings.geodata_snapshot_id}/ambony`]] as const) {
    const link = sheet.getByRole('link', { name, exact: true });
    await expect(link).toHaveAttribute('href', href);
    const box = await link.boundingBox();
    expect(box!.height).toBeGreaterThanOrEqual(56);
    expect(box!.width).toBeGreaterThanOrEqual(56);
  }
  await page.keyboard.press('Escape');
  await expect(sheet).toBeHidden();
  await expect(opener).toBeFocused();
});

test('an area Report reads its Findings over the whole area and names the hearing distance as the Reporter’s', async ({ page }) => {
  await openStored(page, '353ad090-8888-4888-8888-888888888888', {
    event_type: 'shot', photo_sha256: undefined, device_fix: null,
    incident_location: { type: 'area', bounds: [22.654, 53.403, 22.660, 53.407], basis: 'estimated_from_hearing', precise_fix_withheld: null, hearing_bearing_deg: 335, hearing_distance_m: 200 }
  }, { findings: { ...findings, accuracy_m: null, area_bounds: [22.654, 53.403, 22.660, 53.407],
    dwelling_distance: { status: 'area_measured', basis: 'area', class: 'partly_within_threshold', min_m: 49, within_threshold_share: 0.3, contains_dwelling: false, threshold_m: 150, search_radius_m: 1000 },
    obwod_lowiecki: { status: 'area', outside_share: 0, obwody: [{ name: 'Obwód łowiecki', number: '112', source_year: 2025, share: 0.7 }, { name: 'Obwód łowiecki', number: '113', source_year: 2025, share: 0.3 }],
      disclaimer: findings.obwod_lowiecki.disclaimer, source_name: findings.obwod_lowiecki.source_name, source_url: findings.obwod_lowiecki.source_url, retrieved_at: findings.obwod_lowiecki.retrieved_at },
    nearest_ambona: { status: 'mapped', distance_m: 10774.2, osm_id: 'node/1', measured_from: 'area_edge' } } });
  const dwelling = page.locator('[data-fact="dwelling"]');
  await expect(dwelling.locator('.fact-what')).toHaveText('Część obszaru bliżej niż 150 m od zabudowań');
  await expect(dwelling.locator('.fact-value b')).toHaveText('ok. 30%');
  await expect(dwelling).toContainText('Najbliższe zabudowania: 49 m.');
  await expect(page.locator('[data-fact="obwod"]')).toContainText('2 obwody');
  await expect(page.locator('[data-fact="ambona"]')).toContainText('10,8 km');
  await expect(page.locator('[data-fact="ambona"]')).toContainText('Od krawędzi obszaru');
  await expect(page.locator('.screen-body')).not.toContainText('Nie ustalono odległości');
  await page.locator('summary', { hasText: 'Szczegóły zgłoszenia' }).click();
  await expect(page.locator('.facts')).toContainText('ok. 200 m od Ciebie');
  await expect(page.locator('.facts')).toContainText('Odległość od zabudowań podają pomiary powyżej.');
  await page.getByRole('button', { name: 'Skąd te wyniki' }).click();
  const sheet = page.getByRole('dialog', { name: 'Skąd te wyniki' });
  const protectedSources = sheet.locator('[aria-labelledby="sources-protected"]');
  await expect(protectedSources).toContainText('Podajemy zakaz tylko dla obszaru, który w całości leży w granicach i ich nie dotyka.');
  await expect(protectedSources).not.toContainText('Granicę porównuje się z dokładnością punktu.');
});

test('Escape closes Sources before changing the underlying Withdrawal confirmation', async ({ page }) => {
  await openStored(page, '354ad090-8888-4888-8888-888888888888', {
    device_fix: { lat: 53.403481, lon: 22.658699, accuracy_m: 8, at }, incident_location: { lat: 53.403481, lon: 22.658699, source: 'device_fix' }
  }, { findings });
  await page.getByRole('button', { name: 'Wycofaj zgłoszenie', exact: true }).click();
  const confirmation = page.getByRole('group', { name: 'Wycofać to zgłoszenie?' });
  await expect(confirmation).toBeVisible();
  await page.getByRole('button', { name: 'Skąd te wyniki' }).click();
  const sheet = page.getByRole('dialog', { name: 'Skąd te wyniki' });
  await expect(sheet).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(sheet).toBeHidden();
  await expect(confirmation).toBeVisible();
  await expect(page.getByRole('button', { name: 'Skąd te wyniki' })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(confirmation).toBeHidden();
});

for (const language of ['pl', 'en'] as const) for (const share of [0.004, 0.999]) {
  test(`partial protected shares stay partial in summary and Sources: ${language}, ${share}`, async ({ page }) => {
    const bounds = [22.654, 53.403, 22.660, 53.407];
    await openStored(page, '355ad090-8888-4888-8888-888888888888', {
      device_fix: null, incident_location: { type: 'area', bounds, basis: 'reporter_selected_area', precise_fix_withheld: null }
    }, { findings: { ...findings, accuracy_m: null, area_bounds: bounds,
      dwelling_distance: { status: 'area_measured', basis: 'area', class: 'partly_within_threshold', min_m: 49,
        within_threshold_share: 0.3, contains_dwelling: false, threshold_m: 150, search_radius_m: 1000 },
      protected_areas: { ...findings.protected_areas, park_narodowy: [
        { name: 'Testowy park', inspire_id: 'partial-share', coverage: 'partly_inside', area_share: share }
      ] }
    } }, language);
    const expected = translate(language, share < 0.01 ? 'poniżej 1%' : 'ponad 99%');
    const fact = page.locator('[data-fact="protected"]');
    await expect(fact).toContainText(expected);
    await expect(fact).not.toContainText('100%');
    await page.getByRole('button', { name: translate(language, 'Skąd te wyniki') }).click();
    const sheet = page.getByRole('dialog', { name: translate(language, 'Skąd te wyniki') });
    const protectedSources = sheet.locator('[aria-labelledby="sources-protected"]');
    await expect(protectedSources).toContainText(expected);
    await expect(protectedSources).not.toContainText('100%');
    await expect(protectedSources).not.toContainText('0%.');
  });
}

for (const language of ['pl', 'en'] as const) for (const single of [false, true]) {
  test(`district hero groups vintages while Sources retains years: ${language}, single ${single}`, async ({ page }) => {
    const bounds = [22.654, 53.403, 22.660, 53.407];
    const entries = [
      { name: 'Obwód łowiecki', number: '1', source_year: 2024, share: 0.2 },
      { name: 'Obwód łowiecki', number: '1', source_year: 2025, share: single ? 0.8 : 0.3 },
      ...single ? [] : [{ name: 'Obwód łowiecki', number: '2', source_year: 2026, share: 0.5 }]
    ];
    await openStored(page, '357ad090-8888-4888-8888-888888888888', {
      device_fix: null, incident_location: { type: 'area', bounds, basis: 'reporter_selected_area', precise_fix_withheld: null }
    }, { findings: { ...findings, accuracy_m: null, area_bounds: bounds,
      dwelling_distance: { status: 'area_measured', basis: 'area', class: 'partly_within_threshold', min_m: 49,
        within_threshold_share: 0.3, contains_dwelling: false, threshold_m: 150, search_radius_m: 1000 },
      obwod_lowiecki: { ...findings.obwod_lowiecki, status: 'area', outside_share: 0, obwody: entries }
    } }, language);
    const fact = page.locator('[data-fact="obwod"]');
    const districtHeading = language === 'en' ? 'Hunting district' : 'Obwód łowiecki';
    await expect(fact.locator('.fact-what')).toHaveText(districtHeading);
    await expect(fact.locator('.fact-value b')).toHaveText(single
      ? translate(language, 'nr {number}').replace('{number}', '1')
      : translate(language, '{count} obwody').replace('{count}', '2'));
    if (single) await expect(fact).toContainText(translate(language, 'Cały obszar leży w tym obwodzie.'));
    await page.getByRole('button', { name: translate(language, 'Skąd te wyniki') }).click();
    const sources = page.getByRole('dialog').locator('[aria-labelledby="sources-obwod"]');
    await expect(sources.getByRole('heading', { level: 3 })).toHaveText(districtHeading);
    await expect(sources.getByText(/1 \(2024\)\./)).toBeVisible();
    await expect(sources.getByText(/1 \(2025\)\./)).toBeVisible();
    if (!single) await expect(sources.getByText(/2 \(2026\)\./)).toBeVisible();
    await expect(sources.locator('p').filter({ hasText: /\(\d{4}\)\./ })).toHaveCount(single ? 2 : 3);
  });
}

for (const language of ['pl', 'en'] as const) for (const distance of [0, 299]) {
  test(`area stand origin is truthful in summary and Sources: ${language}, ${distance} m`, async ({ page }) => {
    const bounds = [22.654, 53.403, 22.660, 53.407];
    await openStored(page, '358ad090-8888-4888-8888-888888888888', {
      device_fix: null, incident_location: { type: 'area', bounds, basis: 'reporter_selected_area', precise_fix_withheld: null }
    }, { findings: { ...findings, accuracy_m: null, area_bounds: bounds,
      dwelling_distance: { status: 'area_measured', basis: 'area', class: 'partly_within_threshold', min_m: 49,
        within_threshold_share: 0.3, contains_dwelling: false, threshold_m: 150, search_radius_m: 1000 },
      nearest_ambona: { status: 'mapped', distance_m: distance, osm_id: 'node/1', measured_from: 'area_edge' }
    } }, language);
    const fact = page.locator('[data-fact="ambona"]');
    await expect(fact.locator('.fact-value b')).toHaveText(`${distance} m`);
    await expect(fact.locator('.fact-meaning')).toHaveText(translate(language, distance === 0
      ? 'Ambona oznaczona w OpenStreetMap leży we wskazanym obszarze (© współtwórcy, licencja ODbL).'
      : 'Od krawędzi obszaru. Ambona oznaczona w OpenStreetMap (© współtwórcy, licencja ODbL).'));
    await page.getByRole('button', { name: translate(language, 'Skąd te wyniki') }).click();
    const sources = page.getByRole('dialog').locator('[aria-labelledby="sources-ambona"]');
    await expect(sources).toContainText(translate(language, distance === 0
      ? 'Ambona leży we wskazanym obszarze, więc odległość wynosi 0 m.'
      : 'Odległość mierzy się od krawędzi wskazanego obszaru, a gdy ambona leży w obszarze, wynosi 0 m.'));
    await expect(sources.getByRole('link', { name: 'OpenStreetMap contributors', exact: true })).toBeVisible();
    await expect(sources.getByRole('link', { name: 'ODbL', exact: true })).toBeVisible();
    await expect(sources).toContainText(translate(language, 'Pokrycie OpenStreetMap jest niepełne. Wynik nie potwierdza polowania ani naruszenia prawa; brak oznaczenia nie potwierdza braku ambony.'));
  });
}

for (const language of ['pl', 'en'] as const) {
  test(`protected finding value reflows at 320px with doubled text: ${language}`, async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 640 });
    const bounds = [22.654, 53.403, 22.660, 53.407];
    await openStored(page, '358ad090-8888-4888-8888-888888888888', {
      device_fix: null, incident_location: { type: 'area', bounds, basis: 'reporter_selected_area', precise_fix_withheld: null }
    }, { findings: { ...findings, accuracy_m: null, area_bounds: bounds,
      dwelling_distance: { status: 'area_measured', basis: 'area', class: 'beyond_threshold', min_m: 400,
        within_threshold_share: 0, contains_dwelling: false, threshold_m: 150, search_radius_m: 1000 },
      protected_areas: { ...findings.protected_areas, park_krajobrazowy: [
        { name: 'Testowy park krajobrazowy', inspire_id: 'enlarged-headline', coverage: 'partly_inside', area_share: 0.3 }
      ] }
    } }, language);
    await page.evaluate(() => { document.documentElement.style.fontSize = '34px'; });
    await settled(page);
    const value = page.locator('[data-fact="protected"] .fact-value b');
    await expect(value).toHaveText(translate(language, 'Park krajobrazowy'));
    const layout = await value.evaluate(element => {
      const rect = element.getBoundingClientRect(), range = document.createRange();
      range.selectNodeContents(element);
      const body = document.querySelector('.screen-body')!;
      return { right: rect.right,
        viewportWidth: innerWidth, scrollWidth: body.scrollWidth, clientWidth: body.clientWidth,
        lines: [...range.getClientRects()].map(line => ({ left: line.left, right: line.right })) };
    });
    expect(layout.scrollWidth).toBeLessThanOrEqual(layout.clientWidth + 1);
    expect(layout.right).toBeLessThanOrEqual(layout.viewportWidth + 0.5);
    expect(layout.lines.length).toBeGreaterThan(1);
    for (const line of layout.lines) {
      expect(line.left).toBeGreaterThanOrEqual(-0.5);
      expect(line.right).toBeLessThanOrEqual(layout.viewportWidth + 0.5);
    }
  });
}

// Faza 7/28: at 320 px with doubled text the details list stacks its label over its value and breaks
// only between words. Before, the value sat right-aligned in a 130 px column and read "wskazan / o".
async function detailsLayout(page: Page) {
  await page.locator('summary', { hasText: /Szczegóły zgłoszenia|Report details/ }).click();
  await page.waitForFunction(() => document.getAnimations().every(animation => animation.playState !== 'running'));
  return page.evaluate(() => {
    const dt = document.querySelector('.facts dt')!;
    const dd = document.querySelector('.facts dd')!;
    const text = dd.firstChild as Text;
    // A word whose letters land on two lines has two client rects.
    const split: string[] = [];
    for (const match of text.data.matchAll(/\S+/g)) {
      const range = document.createRange();
      range.setStart(text, match.index!);
      range.setEnd(text, match.index! + match[0].length);
      const lines = new Set([...range.getClientRects()].filter(rect => rect.width > 0).map(rect => Math.round(rect.top)));
      if (lines.size > 1) split.push(match[0]);
    }
    const label = dt.getBoundingClientRect(), value = dd.getBoundingClientRect();
    return { split, stacked: value.top >= label.bottom - 0.5, align: getComputedStyle(dd).textAlign, ddWidth: Math.round(value.width), ddHeight: Math.round(value.height) };
  });
}
const movedPlace = { device_fix: null, incident_location: { lat: 53.403481, lon: 22.658699, source: 'moved_by_reporter' } };
for (const language of ['pl', 'en'] as const) {
  test(`at 320 px with doubled text the Report details read in whole words (${language})`, async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 640 });
    await page.addInitScript(() => document.addEventListener('DOMContentLoaded', () => { document.documentElement.style.fontSize = '34px'; }));
    await openStored(page, `352ad090-2828-4828-8828-82828282828${language === 'pl' ? '1' : '2'}`, movedPlace, { findings }, language);
    const layout = await detailsLayout(page);
    test.info().annotations.push({ type: 'details', description: JSON.stringify(layout) });
    expect(layout.split).toEqual([]);
    expect(layout.stacked).toBe(true);
    expect(['left', 'start']).toContain(layout.align);
  });
}
for (const width of [390, 1280]) {
  test(`at ${width} px the Report details keep label and value side by side`, async ({ page }) => {
    await page.setViewportSize({ width, height: 844 });
    await openStored(page, `352ad090-2828-4828-8828-82828282${String(width).padStart(4, '0')}`, movedPlace, { findings });
    const layout = await detailsLayout(page);
    expect(layout.stacked).toBe(false);
    expect(layout.split).toEqual([]);
  });
}
