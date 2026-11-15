import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { areaShare, distance, summarizeFindings } from '../src/lib/findings-summary.ts';
import type { NoticeRuleSet } from '../src/lib/notice-composer.ts';
import type { Findings, ProtectedAreas, Report } from '../src/lib/report.ts';
import rule from '../data/rule-sets/2026-09-24-v2.json' with { type: 'json' };

const rules = rule as NoticeRuleSet;
const fixture = JSON.parse(readFileSync(new URL('browser/computed-findings.json', import.meta.url), 'utf8')) as Findings;
const point: Report = { id: '451ad090-8888-4888-8888-888888888888', event_type: 'person_with_gun', captured_at: '2026-09-25T10:00:00Z',
  occurred_at: { at: '2026-09-25T09:00:00Z', source: 'device_clock', coarseness: 'exact' },
  device_fix: { lat: 52, lon: 21, accuracy_m: 8, at: '2026-09-25T10:00:00Z' },
  incident_location: { lat: 52, lon: 21, source: 'device_fix' }, species: null, photo_sha256: [], has_note: false,
  app_version: '0.1.0', privacy_policy_version: '1', terms_of_use_version: '1', token_sha256: '0'.repeat(64) };
const area: Report = { ...point, event_type: 'shot', photo_sha256: undefined, device_fix: null,
  incident_location: { type: 'area', bounds: [21, 52, 21.006, 52.004], basis: 'estimated_from_hearing', precise_fix_withheld: null, hearing_bearing_deg: 335, hearing_distance_m: 200 } };
// Ticket 29's reviewed shape: the closest distance and the share within the threshold, no farthest distance.
const areaDwelling = (cls: 'beyond_threshold' | 'partly_within_threshold' | 'contains_dwelling', min: number, share: number): Findings['dwelling_distance'] =>
  ({ status: 'area_measured', basis: 'area', class: cls, min_m: min, within_threshold_share: share, contains_dwelling: cls === 'contains_dwelling',
    threshold_m: 150, search_radius_m: 1000 });
const text = (summary: ReturnType<typeof summarizeFindings>) => JSON.stringify(summary);

test('distances switch to kilometres above 1000 m with a Polish decimal comma', () => {
  assert.equal(distance(140.0000004, 'pl'), '140 m');
  assert.equal(distance(999.4, 'pl'), '999 m');
  assert.equal(distance(10774, 'pl'), '10,8 km');
  assert.equal(distance(10774, 'en'), '10.8 km');
  assert.equal(distance(1000, 'pl'), '1 km');
});

test('area share formatting reserves zero and full percentages for exact endpoints', () => {
  for (const language of ['pl', 'en'] as const) {
    assert.equal(areaShare(0, language), '0%');
    assert.equal(areaShare(1, language), '100%');
    assert.equal(areaShare(Number.MIN_VALUE, language), language === 'pl' ? 'poniżej 1%' : 'under 1%');
    assert.equal(areaShare(1 - Number.EPSILON, language), language === 'pl' ? 'ponad 99%' : 'over 99%');
  }
});

test('a point Report lists checked facts in the agreed order with no provenance', () => {
  const summary = summarizeFindings(point, fixture, rules, 'pl');
  assert.deepEqual(summary.facts.map(fact => fact.key), ['dwelling', 'protected', 'noc', 'obwod', 'ambona']);
  assert.deepEqual([summary.facts[0].value, summary.facts[0].margin], ['140 m', '±8 m']);
  assert.match(summary.facts[0].meaning, /^Bliżej niż 150 m/);
  assert.equal(summary.unchecked, 'Nie sprawdzono: okres ochronny (nie podano gatunku).');
  for (const hidden of [fixture.rule_set_id, fixture.geodata_snapshot_id, 'Dz.U.', 'sha256']) assert.ok(!text(summary).includes(hidden), hidden);
  assert.match(summary.facts.at(-1)!.meaning, /OpenStreetMap.*ODbL/);
});

test('outside coverage collapses every spatial fact into one unchecked line', () => {
  const summary = summarizeFindings(point, { ...fixture,
    dwelling_distance: { status: 'not_computed', value_m: null, search_radius_m: null, reason: 'outside_coverage' },
    obwod_lowiecki: { status: 'not_computed', reason: 'outside_coverage' }, protected_areas: { status: 'not_computed', reason: 'outside_coverage' },
    nearest_ambona: { status: 'not_computed', reason: 'outside_coverage' } }, rules, 'pl');
  assert.deepEqual(summary.facts.map(fact => fact.key), ['noc']);
  assert.equal(summary.unchecked, 'Nie sprawdzono: zabudowania, obszary chronione, obwód łowiecki i ambona (miejsce poza zasięgiem danych); okres ochronny (nie podano gatunku).');
});

test('area Findings read their class and never fall back to "nie ustalono"', () => {
  for (const [cls, min, share, what, value, meaning] of [
    ['beyond_threshold', 212, 0, 'Od obszaru do zabudowań mieszkalnych', '212 m', 'Cały obszar leży dalej niż 150 m od nich.'],
    ['partly_within_threshold', 49, 0.3, 'Część obszaru bliżej niż 150 m od zabudowań', 'ok. 30%', 'Najbliższe zabudowania: 49 m.'],
    ['partly_within_threshold', 149, 0.004, 'Część obszaru bliżej niż 150 m od zabudowań', 'poniżej 1%', 'Najbliższe zabudowania: 149 m.'],
    ['partly_within_threshold', 150, 0, 'Obszar na granicy 150 m od zabudowań', '0%', 'Najbliższe zabudowania: 150 m.'],
    ['partly_within_threshold', 49, 1, 'Cały obszar w zasięgu 150 m od zabudowań', '100%', 'Najbliższe zabudowania: 49 m.'],
    ['partly_within_threshold', 49, 0.999, 'Część obszaru bliżej niż 150 m od zabudowań', 'ponad 99%', 'Najbliższe zabudowania: 49 m.'],
    ['contains_dwelling', 0, 0.62, 'W obszarze są zabudowania mieszkalne', 'ok. 62%', 'Tyle obszaru leży bliżej niż 150 m od zabudowań.'],
    ['contains_dwelling', 0, 1, 'W obszarze są zabudowania mieszkalne', '100%', 'Cały obszar leży w zasięgu 150 m od zabudowań.']] as const) {
    const summary = summarizeFindings(area, { ...fixture, accuracy_m: null, dwelling_distance: areaDwelling(cls, min, share) }, rules, 'pl');
    assert.deepEqual([summary.facts[0].what, summary.facts[0].value, summary.facts[0].meaning], [what, value, meaning]);
    assert.ok(!text(summary).includes('ustalono'));
    assert.ok(!/\d–\d/.test(text(summary)), 'no distance range');
  }
  // Before ticket 29 an area was not measured: it is an unchecked fact, and its centre-based ambona is not shown.
  const old = summarizeFindings(area, { ...fixture, accuracy_m: null,
    dwelling_distance: { status: 'not_computed', value_m: null, search_radius_m: null, reason: 'incident_area' },
    obwod_lowiecki: { status: 'not_computed', reason: 'incident_area' }, protected_areas: { status: 'not_computed', reason: 'incident_area' } }, rules, 'pl');
  assert.ok(!old.facts.some(fact => fact.key === 'ambona'));
  assert.match(old.unchecked, /zabudowania, obszary chronione, obwód łowiecki i ambona \(podano obszar, nie punkt\)/);
});

test('zero and full area shares read literally in English', () => {
  for (const [share, what] of [
    [0, 'Area at the 150 m building-distance threshold'],
    [1, 'Whole area within 150 m of buildings']
  ] as const) {
    const summary = summarizeFindings(area, { ...fixture, accuracy_m: null, dwelling_distance: areaDwelling('partly_within_threshold', share === 0 ? 150 : 49, share) }, rules, 'en');
    assert.equal(summary.facts[0].what, what);
    assert.equal(summary.facts[0].value, share === 0 ? '0%' : '100%');
    assert.ok(!summary.facts[0].what.startsWith('Part of'));
  }
});

test('an area asserts the ban only when it lies wholly inside, never for a partial overlap', () => {
  const park = { name: 'Biebrzański Park Narodowy', inspire_id: 'pn', boundary_distance: { status: 'measured' as const, value_m: 300, search_radius_m: null } };
  const protectedAreas = (coverage: 'wholly_inside' | 'partly_inside') => ({ ...fixture.protected_areas!,
    park_narodowy: [coverage === 'wholly_inside' ? { ...park, coverage, area_share: 1 } : { name: park.name, inspire_id: park.inspire_id, coverage, area_share: 0.4 }] }) as Findings['protected_areas'];
  const measured = { ...fixture, accuracy_m: null, dwelling_distance: areaDwelling('beyond_threshold', 400, 0) };
  const whole = summarizeFindings(area, { ...measured, protected_areas: protectedAreas('wholly_inside') }, rules, 'pl').facts.find(fact => fact.key === 'protected')!;
  assert.deepEqual([whole.value, whole.ban, whole.meaning], ['Zakaz polowania', true, 'Biebrzański Park Narodowy obejmuje cały obszar.']);
  const part = summarizeFindings(area, { ...measured, protected_areas: protectedAreas('partly_inside') }, rules, 'pl').facts.find(fact => fact.key === 'protected')!;
  assert.equal(part.ban, undefined);
  assert.equal(part.value, 'Część w parku narodowym');
  assert.equal(part.meaning, 'Biebrzański Park Narodowy obejmuje ok. 40% obszaru.');
});

test('partial protected-area shares never round to zero or whole-area coverage', () => {
  for (const language of ['pl', 'en'] as const) for (const share of [0.004, 0.999]) {
    const entry = { name: 'Testowy obszar', inspire_id: 'protected-share', coverage: 'partly_inside' as const, area_share: share };
    const protectedAreas: ProtectedAreas = { status: 'computed', rules: null, park_narodowy: [entry],
      rezerwat: [], otulina: [], park_krajobrazowy: [], natura_2000_oso: [], natura_2000_soo: [] };
    const measured = { ...fixture, accuracy_m: null, dwelling_distance: areaDwelling('beyond_threshold', 400, 0) };
    const strong = summarizeFindings(area, { ...measured, protected_areas: protectedAreas }, rules, language).facts.find(fact => fact.key === 'protected')!;
    const context = summarizeFindings(area, { ...measured, protected_areas: { ...protectedAreas, park_narodowy: [], natura_2000_oso: [entry] } }, rules, language).facts.find(fact => fact.key === 'protected')!;
    for (const fact of [strong, context]) {
      assert.ok(fact.meaning.includes(areaShare(share, language)));
      assert.ok(!/(?:^|\s)(?:0|100)%/.test(fact.meaning));
      assert.equal(fact.ban, undefined);
    }
  }
});

test('district summaries keep fractional coverage and every positive outside share', () => {
  for (const language of ['pl', 'en'] as const) {
    const obwod: Findings['obwod_lowiecki'] = { status: 'area', obwody: [{ name: 'Testowy obwód', number: '112', source_year: 2025, share: 0.999 }],
      outside_share: 0.001, disclaimer: 'Dane o obwodach łowieckich mają charakter poglądowy.', source_name: 'Bank Danych o Lasach',
      source_url: 'https://example.invalid/district', retrieved_at: '2026-09-24T12:00:00Z' };
    const measured = { ...fixture, accuracy_m: null, dwelling_distance: areaDwelling('beyond_threshold', 400, 0) };
    const fact = summarizeFindings(area, { ...measured, obwod_lowiecki: obwod }, rules, language).facts.find(fact => fact.key === 'obwod')!;
    assert.ok(fact.meaning.includes(areaShare(0.999, language)));
    assert.ok(fact.meaning.includes(areaShare(0.001, language)));
    assert.ok(!fact.meaning.includes('100%'));
    assert.ok(!fact.meaning.includes(language === 'pl' ? 'Cały obszar' : 'The whole area'));
    const whole = summarizeFindings(area, { ...measured, obwod_lowiecki: { ...obwod, outside_share: 0,
      obwody: [{ ...obwod.obwody[0], share: 1 }] } }, rules, language).facts.find(fact => fact.key === 'obwod')!;
    assert.equal(whole.meaning, language === 'pl' ? 'Cały obszar leży w tym obwodzie.' : 'The whole area lies in this hunting district.');
    const multiple = summarizeFindings(area, { ...measured, obwod_lowiecki: { ...obwod, outside_share: 0.0005,
      obwody: [obwod.obwody[0], { ...obwod.obwody[0], number: '113', share: 0.0005 }] } }, rules, language).facts.find(fact => fact.key === 'obwod')!;
    assert.ok(multiple.meaning.includes(areaShare(0.999, language)));
    assert.ok(multiple.meaning.includes(language === 'pl' ? 'poza obwodami' : 'outside districts'));
    assert.equal(multiple.meaning.split(areaShare(0.0005, language)).length - 1, 2);
  }
});

test('district heroes group disjoint source years by number without changing provenance entries', () => {
  for (const language of ['pl', 'en'] as const) {
    const obwod: Findings['obwod_lowiecki'] = { status: 'area', obwody: [
      { name: 'Obwód łowiecki', number: '1', source_year: 2024, share: 0.2 },
      { name: 'Obwód łowiecki', number: '1', source_year: 2025, share: 0.3 },
      { name: 'Obwód łowiecki', number: '2', source_year: 2026, share: 0.5 }
    ], outside_share: 0, disclaimer: 'Dane o obwodach łowieckich mają charakter poglądowy.', source_name: 'Bank Danych o Lasach',
      source_url: 'https://example.invalid/district', retrieved_at: '2026-09-24T12:00:00Z' };
    const originalEntries = structuredClone(obwod.obwody);
    const measured = { ...fixture, accuracy_m: null, dwelling_distance: areaDwelling('beyond_threshold', 400, 0) };
    const mixed = summarizeFindings(area, { ...measured, obwod_lowiecki: obwod }, rules, language).facts.find(fact => fact.key === 'obwod')!;
    assert.equal(mixed.value, language === 'pl' ? '2 obwody' : '2 districts');
    assert.equal(mixed.meaning, language === 'pl' ? 'nr 1 (ok. 50%), nr 2 (ok. 50%)' : 'no. 1 (about 50%), no. 2 (about 50%)');
    assert.deepEqual(obwod.obwody, originalEntries);
    const whole = summarizeFindings(area, { ...measured, obwod_lowiecki: { ...obwod,
      obwody: [obwod.obwody[0], { ...obwod.obwody[1], share: 0.8 }]
    } }, rules, language).facts.find(fact => fact.key === 'obwod')!;
    assert.equal(whole.value, language === 'pl' ? 'nr 1' : 'no. 1');
    assert.equal(whole.meaning, language === 'pl' ? 'Cały obszar leży w tym obwodzie.' : 'The whole area lies in this hunting district.');
    const partial = summarizeFindings(area, { ...measured, obwod_lowiecki: { ...obwod, outside_share: 0.001,
      obwody: [obwod.obwody[0], { ...obwod.obwody[1], share: 0.799 }]
    } }, rules, language).facts.find(fact => fact.key === 'obwod')!;
    assert.equal(partial.value, language === 'pl' ? 'nr 1' : 'no. 1');
    assert.ok(partial.meaning.includes(areaShare(0.999, language)));
    assert.ok(partial.meaning.includes(areaShare(0.001, language)));
    assert.ok(!partial.meaning.includes(language === 'pl' ? 'Cały obszar' : 'The whole area'));
  }
});

test('zero area-to-stand distance means within the area, not at its edge', () => {
  for (const language of ['pl', 'en'] as const) {
    const measured = { ...fixture, accuracy_m: null, dwelling_distance: areaDwelling('beyond_threshold', 400, 0) };
    const zero = summarizeFindings(area, { ...measured,
      nearest_ambona: { status: 'mapped', distance_m: 0, osm_id: 'node/1', measured_from: 'area_edge' }
    }, rules, language).facts.find(fact => fact.key === 'ambona')!;
    assert.equal(zero.value, '0 m');
    assert.ok(zero.meaning.includes(language === 'pl' ? 'we wskazanym obszarze' : 'within the indicated area'));
    assert.ok(!zero.meaning.includes(language === 'pl' ? 'Od krawędzi' : 'From the edge'));
    for (const attribution of ['OpenStreetMap', '©', 'ODbL']) assert.ok(zero.meaning.includes(attribution));
    const outside = summarizeFindings(area, { ...measured,
      nearest_ambona: { status: 'mapped', distance_m: 299, osm_id: 'node/1', measured_from: 'area_edge' }
    }, rules, language).facts.find(fact => fact.key === 'ambona')!;
    assert.equal(outside.value, '299 m');
    assert.ok(outside.meaning.startsWith(language === 'pl' ? 'Od krawędzi obszaru.' : 'From the edge of the area.'));
    const pointZero = summarizeFindings(point, { ...fixture,
      nearest_ambona: { status: 'mapped', distance_m: 0, osm_id: 'node/1' }
    }, rules, language).facts.find(fact => fact.key === 'ambona')!;
    assert.equal(pointZero.value, '0 m');
    assert.ok(!pointZero.meaning.includes(language === 'pl' ? 'we wskazanym obszarze' : 'within the indicated area'));
  }
});

test('district count uses Polish few and many forms while English remains plural', () => {
  for (const [count, noun] of [[2, 'obwody'], [4, 'obwody'], [5, 'obwodów'], [11, 'obwodów'],
    [12, 'obwodów'], [14, 'obwodów'], [21, 'obwodów'], [22, 'obwody'], [24, 'obwody'],
    [25, 'obwodów'], [112, 'obwodów'], [122, 'obwody']] as const) {
    const obwod: Findings['obwod_lowiecki'] = { status: 'area', outside_share: 0,
      obwody: Array.from({ length: count }, (_, index) => ({ name: 'Obwód łowiecki', number: String(index + 1), source_year: 2025, share: 1 / count })),
      disclaimer: 'Dane o obwodach łowieckich mają charakter poglądowy.', source_name: 'Bank Danych o Lasach',
      source_url: 'https://example.invalid/district', retrieved_at: '2026-09-24T12:00:00Z' };
    for (const language of ['pl', 'en'] as const) {
      const summary = summarizeFindings(area, { ...fixture, accuracy_m: null,
        dwelling_distance: areaDwelling('beyond_threshold', 400, 0), obwod_lowiecki: obwod }, rules, language);
      assert.equal(summary.facts.find(fact => fact.key === 'obwod')!.value, `${count} ${language === 'pl' ? noun : 'districts'}`);
    }
  }
});
