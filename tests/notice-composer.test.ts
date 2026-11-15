import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import test from 'node:test';
import type { NoticeLocal as LocalReport, NoticeRecipient as RecipientUnit } from '../src/lib/notice-composer.ts';
import type { Findings, ProtectedAreas, ProtectedArea, IncidentArea } from '../src/lib/report.ts';
import { composeNotice, distanceBand, type NoticePlaces, type NoticeRuleSet } from '../src/lib/notice-composer.ts';
import { incidentLocationSentence, noticeAreaLocation } from '../src/lib/notice-location.ts';
import { noticeFragments } from '../src/lib/notice-fragments.ts';
import { noticeRuleSet } from '../src/lib/notice-rule-set.ts';
import { createRecipientCatalog, noticePlaces, type RecipientUnit as CatalogUnit } from '../src/lib/recipient-resolver.ts';
import rule from '../data/rule-sets/2026-09-24-v2.json' with { type: 'json' };

const rules = rule as NoticeRuleSet;
const kinds = ['police', 'psl', 'nationalPark', 'rdos', 'gmina'] as const;
const events = ['shot', 'person_with_gun', 'remains', 'injured_animal', 'poaching'] as const;
const unit = (kind: typeof kinds[number]): RecipientUnit => ({ kind, id: kind, name: `Jednostka ${kind}` });
const base: LocalReport = {
  report: { id: '351ad090-8888-4888-8888-888888888888', event_type: 'shot', captured_at: '2026-09-25T10:00:00Z',
    occurred_at: { at: '2026-09-25T09:00:00Z', source: 'device_clock', coarseness: 'exact' },
    device_fix: { lat: 52.12345, lon: 21.23456, accuracy_m: 12, at: '2026-09-25T10:00:00Z' },
    incident_location: { lat: 52.12345, lon: 21.23456, source: 'device_fix' },
    species: null, has_note: false, app_version: '0.1.0', privacy_policy_version: '1', terms_of_use_version: '1', token_sha256: '0'.repeat(64) },
  findings: { status: 'pending' }
};
const findings: Findings = { status: 'computed', rule_set_id: rules.id, geodata_snapshot_id: 'snapshot', snapshot_date: '2026-09-01',
  datasets: ['BDOT10k', 'GDOŚ', 'CRFOP', 'BDL', 'PRG'].map(name => ({ name, source_url: '', sha256: '', retrieved_at: '' })),
  dwelling_distance: { status: 'measured', value_m: 97, search_radius_m: 1000 },
  obwod_lowiecki: { status: 'inside', name: 'Obwód łowiecki', number: '142', source_year: 2026, disclaimer: 'Mapa poglądowa.', source_name: 'BDL', source_url: '', retrieved_at: '' },
  accuracy_m: 12, noc: null, okres_ochronny: null };
function compose(local: LocalReport = base, kind: typeof kinds[number] = 'police', variant: 'signed' | 'unsigned' = 'unsigned', platform: 'web' | 'android' = 'web') {
  return composeNotice({ local, recipient: unit(kind), others: [unit('psl')], places: { gmina: 'Tłuszcz', powiat: 'wołomiński', nadlesnictwo: 'Drewnica' }, variant,
    signed: variant === 'signed' ? { name: 'Jan Kowalski', address: 'ul. Leśna 1', phone: '123456789' } : undefined,
    ruleSet: rules, fragments: noticeFragments, platform });
}
const withFindings = (extra: Partial<Findings> = {}): LocalReport => ({ ...base, findings: { ...findings, ...extra } });
const measured = (value_m: number): ProtectedArea['boundary_distance'] => ({ status: 'measured', value_m, search_radius_m: null });
const areaRules: NonNullable<Extract<ProtectedAreas, { status: 'computed' }>['rules']> = {
  treatment: { park_narodowy: 'ban', rezerwat: 'ban_without_documents', otulina: 'context',
    park_krajobrazowy: 'context', natura_2000_oso: 'context', natura_2000_soo: 'context' },
  citation: 'art. 15 ust. 1 pkt 4 ustawy o ochronie przyrody (Dz.U. 2004 poz. 880)'
};
const areas = (extra: Partial<Extract<ProtectedAreas, { status: 'computed' }>> = {}): ProtectedAreas => ({
  status: 'computed', rules: areaRules, park_narodowy: [], rezerwat: [], otulina: [],
  park_krajobrazowy: [], natura_2000_oso: [], natura_2000_soo: [], ...extra
});
const park = (distance: number): ProtectedArea => ({ name: 'Park', inspire_id: 'park', boundary_distance: measured(distance) });
const reserve = (distance: number, document_state: ProtectedArea['document_state'] = 'neither'): ProtectedArea =>
  ({ name: 'Rezerwat', inspire_id: 'reserve', boundary_distance: measured(distance), document_state });


test('all ten skeletons have pinned Polish golden texts', () => {
  const actual = Object.fromEntries(kinds.flatMap(kind => (['signed', 'unsigned'] as const).map(variant => {
    const result = compose(base, kind, variant);
    return [`${kind}-${variant}`, `${result.subject}\n\n${result.body}`];
  })));
  const golden = JSON.parse(readFileSync(new URL('golden/notice-skeletons.json', import.meta.url), 'utf8'));
  assert.deepEqual(actual, golden);
});

test('event paragraphs, species, degraded blocks, photo blocks and metadata', () => {
  for (const [i, event] of events.entries()) for (const species of [null, 'sarna'] as const) {
    const local = { ...base, report: { ...base.report, event_type: event, species } };
    const result = compose(local);
    assert.ok(result.fragmentIds.includes(`B${i + 1}`));
    assert.equal(result.body.includes('Wskazany gatunek: Sarna.'), species === 'sarna');
  }
  for (const status of [{ status: 'pending' }, { status: 'failed', reason: 'error' }] as const) {
    assert.ok(compose({ ...base, findings: status }).fragmentIds.includes('D2'));
  }
  assert.ok(compose({ ...base, report: { ...base.report, occurred_at: { ...base.report.occurred_at, coarseness: 'date_only' } } }).fragmentIds.includes('D5'));
  assert.ok(compose({ ...base, report: { ...base.report, occurred_at: { ...base.report.occurred_at, coarseness: 'within_hours', window_end: '2026-09-25T11:00:00Z' } } }).fragmentIds.includes('D4'));
  const photoLocal = { ...base, report: { ...base.report, event_type: 'remains' }, note: 'Cytat dosłowny.', photos: [{ id: 'photo' }] } as LocalReport;
  assert.ok(compose(photoLocal).fragmentIds.includes('D7'));
  assert.ok(compose(photoLocal, 'police', 'unsigned', 'android').fragmentIds.includes('D6'));
  assert.match(compose(photoLocal).body, /Cytat dosłowny/);
  assert.match(compose(withFindings()).body, /Baza Danych Obiektów Topograficznych, obszary chronione Generalnej Dyrekcji Ochrony Środowiska, Centralny Rejestr Form Ochrony Przyrody, Bank Danych o Lasach, Państwowy Rejestr Granic/);
  assert.match(compose().body, /Pozostali adresaci.*Jednostka psl/);
});

test('all Findings fragments and boundary margins', () => {
  assert.equal(distanceBand(97, 12, 150), 'inside');
  assert.equal(distanceBand(145, 12, 150), 'straddles');
  assert.equal(distanceBand(200, 12, 150), 'outside');
  assert.ok(compose(withFindings()).fragmentIds.includes('C1'));
  assert.ok(compose(withFindings({ dwelling_distance: { status: 'measured', value_m: 145, search_radius_m: 1000 } })).fragmentIds.includes('C2'));
  const clear = compose(withFindings({ protected_areas: areas({ park_narodowy: [park(30)], rezerwat: [reserve(30)], otulina: [{ name: 'Otulina', inspire_id: 'buffer' }] }) }));
  for (const id of ['C3', 'C5', 'C9', 'C10']) assert.ok(clear.fragmentIds.includes(id), id);
  const margin = compose(withFindings({ protected_areas: areas({ park_narodowy: [park(10)], rezerwat: [reserve(10)] }) }));
  for (const id of ['C4', 'C6']) assert.ok(margin.fragmentIds.includes(id), id);
  for (const id of ['C3', 'C5']) assert.ok(!margin.fragmentIds.includes(id), id);
  assert.doesNotMatch(margin.body, /polowanie jest tam zakazane/);
  assert.ok(compose(withFindings({ protected_areas: areas({ rezerwat: [reserve(30, 'plan_ochrony')] }) })).fragmentIds.includes('C7'));
  assert.ok(compose(withFindings({ protected_areas: areas({ rezerwat: [reserve(30, 'not_in_crfop_snapshot')] }) })).fragmentIds.includes('C8'));
  const manual = compose({ ...withFindings({ protected_areas: areas({ park_narodowy: [park(30)], rezerwat: [reserve(30)] }) }),
    report: { ...base.report, device_fix: null, incident_location: { lat: 52.12345, lon: 21.23456, source: 'moved_by_reporter' } } });
  assert.ok(manual.fragmentIds.includes('C4') && manual.fragmentIds.includes('C6'));
  assert.ok(manual.fragmentIds.includes('C2'));
  assert.ok(!manual.fragmentIds.includes('C3') && !manual.fragmentIds.includes('C5'));
  assert.match(manual.body, /Brak dokładności GPS/);
  const missingPolicy = compose(withFindings({ protected_areas: areas({ rules: null, park_narodowy: [park(30)] }) }));
  assert.ok(missingPolicy.fragmentIds.includes('C4'));
  assert.match(missingPolicy.body, /Brak potwierdzonej reguły/);
  assert.ok(compose(withFindings({ obwod_lowiecki: { ...findings.obwod_lowiecki, status: 'outside' } as Findings['obwod_lowiecki'] })).fragmentIds.includes('C11'));
  const noc = { status: 'computed', sunrise: '2026-09-25T04:00:00Z', sunset: '2026-09-25T17:00:00Z', at_night: true, species_huntable_at_night: false, citation: 'ignored' } as const;
  assert.ok(compose(withFindings({ noc })).fragmentIds.includes('C12'));
  assert.ok(compose(withFindings({ noc: { ...noc, species_huntable_at_night: null } })).fragmentIds.includes('C13'));
  assert.ok(compose(withFindings({ okres_ochronny: { status: 'in_closed_season', citation: 'ignored' } })).fragmentIds.includes('C14'));
  assert.ok(compose(withFindings({ okres_ochronny: { status: 'not_a_game_species', delisted_on: '2026-01-02', citation: 'ignored' } })).fragmentIds.includes('C15'));
});

test('whole-area night statements contain no point solar times', () => {
  const noc = { status: 'computed', spatial_basis: 'incident_area', sunrise_range: { earliest: '2026-03-14T05:39:00+01:00', latest: '2026-03-14T06:00:00+01:00' },
    sunset_range: { earliest: '2026-03-14T17:20:00+01:00', latest: '2026-03-14T17:41:00+01:00' },
    at_night: true, species_huntable_at_night: false, citation: 'ignored' } as const;
  const result = compose(withFindings({ noc }));
  assert.ok(result.fragmentIds.includes('C12'));
  assert.match(result.body, /Zdarzenie przypada w porze nocnej w całym wskazanym obszarze;/);
  assert.doesNotMatch(result.body, /zachód|wschód|05:39|06:00|17:20|17:41/);
  const unknown = compose(withFindings({ noc: { ...noc, species_huntable_at_night: null } }));
  assert.ok(unknown.fragmentIds.includes('C13'));
  assert.match(unknown.body, /Zdarzenie przypada w porze nocnej w całym wskazanym obszarze; gatunku nie ustalono\./);
});

test('heard-shot area and negative states reveal no private fix or negative Finding', () => {
  const local: LocalReport = { ...base, report: { ...base.report, device_fix: null, incident_location: { type: 'area', bounds: [21, 52, 21.05, 52.04], basis: 'estimated_from_hearing', precise_fix_withheld: 'home_privacy', hearing_bearing_deg: 70 } },
    findings: { ...findings, dwelling_distance: { status: 'none_within_radius', value_m: null, search_radius_m: 1000 },
      obwod_lowiecki: { ...findings.obwod_lowiecki, status: 'not_computed', reason: 'incident_area' } as Findings['obwod_lowiecki'] } };
  const result = compose(local);
  assert.match(result.body, /Obszar oszacowano ze słuchu \(kierunek ok\. 70° \(wschód\)\)/);
  for (const secret of ['50.123456', '20.123456', '±7', local.report.id, 'bor-czuwa', 'Zgłoś myśliwego', 'Bór widzi', 'Bór czuwa', 'nie znaleziono', 'termowiz', 'noktowiz']) assert.ok(!result.body.includes(secret), secret);
  assert.ok(!result.fragmentIds.some(id => /^C[0-9]+$/.test(id)));
});


test('every Incident location sentence has a pinned Notice location golden', () => {
  const area: IncidentArea = { type: 'area', bounds: [21, 52, 21.05, 52.04], basis: 'reporter_selected_area', precise_fix_withheld: null };
  const cases: Record<string, LocalReport['report']> = {};
  const add = (name: string, incident_location: LocalReport['report']['incident_location'], event_type: LocalReport['report']['event_type']) => {
    cases[name] = { ...base.report, event_type, device_fix: 'type' in incident_location || incident_location.source === 'moved_by_reporter' ? null : base.report.device_fix, incident_location };
  };
  for (const [event, basis] of [['shot', 'estimated_from_hearing'], ['person_with_gun', 'estimated_from_sighting']] as const) {
    add(`${event}_skipped`, area, event);
    for (const [name, estimate] of Object.entries({ both: { hearing_bearing_deg: 180, hearing_distance_m: 500 },
      direction: { hearing_bearing_deg: 180 }, distance: { hearing_distance_m: 500 }, legacy: { hearing_distance_band: 'over_1km' as const } })) {
      add(`${event}_${name}`, { ...area, basis, ...estimate }, event);
    }
    for (const homeBasis of ['reporter_selected_area', basis] as const) {
      add(`${event}_home_${homeBasis}`, { ...area, basis: homeBasis, precise_fix_withheld: 'home_privacy' }, event);
    }
  }
  add('manual_point', { lat: 52, lon: 21, source: 'moved_by_reporter' }, 'shot');
  add('device_point', { lat: 52, lon: 21, source: 'device_fix' }, 'person_with_gun');
  const golden = JSON.parse(readFileSync(new URL('golden/incident-locations.json', import.meta.url), 'utf8'));
  const actual = Object.fromEntries(Object.entries(cases).map(([name, report]) => {
    const sentence = incidentLocationSentence(report.incident_location, report.event_type);
    const notice = compose({ ...base, report }).body;
    assert.ok(notice.includes(sentence), name);
    return [name, { sentence, noticeLocation: 'type' in report.incident_location ? noticeAreaLocation(report.incident_location, report.event_type) : sentence }];
  }));
  assert.deepEqual(actual, golden);
});

test('area wording follows what the Reporter gave and never names a hearing place from home', () => {
  const at = (incident_location: object, event_type = base.report.event_type, extra: object = {}) =>
    compose({ ...base, report: { ...base.report, event_type, device_fix: null, incident_location, ...extra } as LocalReport['report'] }).body;
  const away = at({ type: 'area', bounds: [21, 52, 21.015, 52.009], basis: 'estimated_from_hearing', precise_fix_withheld: null,
    hearing_bearing_deg: 90, hearing_distance_m: 1500 });
  assert.match(away, /Obszar oszacowano ze słuchu \(kierunek ok\. 90° \(wschód\), odległość ok\. 1,5 km\)\. Nie jest to pomiar GPS/);
  assert.ok(!away.includes('ochrony miejsca zamieszkania'));
  const home = at({ type: 'area', bounds: [21, 52, 21.057143, 52.036036], basis: 'estimated_from_hearing', precise_fix_withheld: 'home_privacy' });
  assert.match(home, /Obszar oszacowano ze słuchu\. Nie jest to pomiar GPS miejsca oddania strzału\. Dokładne miejsce, z którego słychać było strzał, pominięto/);
  const drawn = at({ type: 'area', bounds: [21, 52, 21.015, 52.009], basis: 'reporter_selected_area', precise_fix_withheld: null },
    'person_with_gun', { photo_sha256: [] });
  assert.match(drawn, /Obszar wskazano w przybliżeniu\. Nie jest to dokładny punkt zdarzenia\./);
  assert.ok(!drawn.includes('strzał'), 'a non-shot area says nothing about a shot');
});

test('Findings and degraded states match golden bodies', () => {
  const cases: Record<string, LocalReport> = {
    C1: withFindings(),
    C2: withFindings({ dwelling_distance: { status: 'measured', value_m: 145, search_radius_m: 1000 } }),
    C3: withFindings({ protected_areas: areas({ park_narodowy: [park(30)] }) }),
    C4: withFindings({ protected_areas: areas({ park_narodowy: [park(10)] }) }),
    C5: withFindings({ protected_areas: areas({ rezerwat: [reserve(30)] }) }),
    C6: withFindings({ protected_areas: areas({ rezerwat: [reserve(10)] }) }),
    C7: withFindings({ protected_areas: areas({ rezerwat: [{ ...reserve(30, 'plan_ochrony'), documents: [{ kind: 'plan_ochrony', url: 'https://example.org/plan' }] }] }) }),
    C8: withFindings({ protected_areas: areas({ rezerwat: [reserve(30, 'not_in_crfop_snapshot')] }) }),
    C9: withFindings({ protected_areas: areas({ otulina: [{ name: 'Otulina', inspire_id: 'buffer' }] }) }),
    C10: withFindings(),
    C4_C6_manual: { ...withFindings({ protected_areas: areas({ park_narodowy: [park(30)], rezerwat: [reserve(30)] }) }),
      report: { ...base.report, device_fix: null, incident_location: { lat: 52.12345, lon: 21.23456, source: 'moved_by_reporter' } },
      findings: { ...findings, accuracy_m: null, protected_areas: areas({ park_narodowy: [park(30)], rezerwat: [reserve(30)] }) } },
    C4_policy_missing: withFindings({ protected_areas: areas({ rules: null, park_narodowy: [park(30)] }) }),
    C11: withFindings({ obwod_lowiecki: { status: 'outside', disclaimer: 'Mapa poglądowa.', source_name: 'BDL', source_url: '', retrieved_at: '' } }),
    C12: withFindings({ noc: { status: 'computed', sunrise: '2026-09-25T04:00:00Z', sunset: '2026-09-25T17:00:00Z', at_night: true, species_huntable_at_night: false, citation: 'ignored' } }),
    C13: withFindings({ noc: { status: 'computed', sunrise: '2026-09-25T04:00:00Z', sunset: '2026-09-25T17:00:00Z', at_night: true, species_huntable_at_night: null, citation: 'ignored' } }),
    C14: withFindings({ okres_ochronny: { status: 'in_closed_season', citation: 'ignored' } }),
    C15: withFindings({ okres_ochronny: { status: 'not_a_game_species', delisted_on: '2026-01-02', citation: 'ignored' } }),
    D2_pending: base,
    D2_failed: { ...base, findings: { status: 'failed', reason: 'computation_failed' } },
    D3_D4: { ...base, report: { ...base.report, device_fix: null, incident_location: { lat: 52.12345, lon: 21.23456, source: 'moved_by_reporter' }, occurred_at: { ...base.report.occurred_at, coarseness: 'within_hours', window_end: '2026-09-25T11:00:00Z' } } },
    D5: { ...base, report: { ...base.report, occurred_at: { ...base.report.occurred_at, coarseness: 'date_only' } } },
    D7_D8: { ...base, report: { ...base.report, event_type: 'remains' }, photos: [{ id: 'photo' }], note: 'Cytat dosłowny.' },
    // Seen Events placed by direction and distance say "seen", never "heard".
    E1_seen: { ...base, report: { ...base.report, event_type: 'person_with_gun', device_fix: null, incident_location: { type: 'area',
      bounds: [21.230, 52.119, 21.238, 52.124], basis: 'estimated_from_sighting', precise_fix_withheld: null,
      hearing_bearing_deg: 180, hearing_distance_m: 500 } } },
    E2_seen_direction: { ...base, report: { ...base.report, event_type: 'poaching', device_fix: null, incident_location: { type: 'area',
      bounds: [21.220, 52.110, 21.250, 52.130], basis: 'estimated_from_sighting', precise_fix_withheld: null, hearing_bearing_deg: 45 } } },
    E3_seen_home: { ...base, report: { ...base.report, event_type: 'injured_animal', device_fix: null, incident_location: { type: 'area',
      bounds: [21.200, 52.090, 21.257, 52.126], basis: 'estimated_from_sighting', precise_fix_withheld: 'home_privacy' } } },
    E4_drawn: { ...base, report: { ...base.report, event_type: 'injured_animal', device_fix: null, incident_location: { type: 'area',
      bounds: [21.230, 52.119, 21.238, 52.124], basis: 'reporter_selected_area', precise_fix_withheld: null } } }
  };
  const actual = Object.fromEntries([
    ...Object.entries(cases).map(([name, local]) => [name, compose(local).body]),
    ...events.flatMap((event, i) => ([null, 'sarna'] as const).map(species => [
      `B${i + 1}_${species ?? 'unset'}`, compose({ ...base, report: { ...base.report, event_type: event, species } }).body
    ])),
    ['D6_android', compose(cases.D7_D8, 'police', 'unsigned', 'android').body]
  ]);
  assert.deepEqual(actual, JSON.parse(readFileSync(new URL('golden/notice-cases.json', import.meta.url), 'utf8')));
});

test('place names follow the gmina the Reporter chose and keep border uncertainty', () => {
  const area: LocalReport = { ...base, report: { ...base.report, device_fix: null, incident_location: { type: 'area',
    bounds: [22.902, 53.401, 22.952, 53.436], basis: 'reporter_selected_area', precise_fix_withheld: 'home_privacy' } } };
  const cases: [string, LocalReport, NoticePlaces][] = [
    ['area_unknown', area, { gmina: null, powiat: 'powiat moniecki', nadlesnictwo: null, gminy: ['Jaświły', 'Mońki'] }],
    ['area_reporter', area, { gmina: 'Jaświły', powiat: 'powiat moniecki', nadlesnictwo: null, gminy: ['Jaświły', 'Mońki'], gmina_source: 'reporter' }],
    ['area_single', area, { gmina: 'Trzcianne', powiat: 'powiat moniecki', nadlesnictwo: null }],
    ['point_border', base, { gmina: null, powiat: null, nadlesnictwo: null, gminy: ['Jaświły', 'Mońki'] }]
  ];
  const actual = Object.fromEntries(cases.map(([name, local, places]) => [name, composeNotice({ local, recipient: unit('police'),
    others: [], places, variant: 'unsigned', ruleSet: rules, fragments: noticeFragments, platform: 'web' }).body]));
  assert.deepEqual(actual, JSON.parse(readFileSync(new URL('golden/notice-places.json', import.meta.url), 'utf8')));
});

test('Rule set selection follows Findings ID or occurrence date', () => {
  assert.equal(noticeRuleSet(base.report, { status: 'pending' }).id, rules.id);
  assert.equal(noticeRuleSet(base.report, findings).id, rules.id);
  assert.equal(noticeRuleSet({ ...base.report, occurred_at: { ...base.report.occurred_at, at: '2019-05-01T12:00:00Z' } }, { status: 'pending' }).effective_from, '2019-03-01');
});


test('corrected, unknown and restored administrative places keep independent Notice measurements', () => {
  const units = JSON.parse(readFileSync(new URL('../data/authority-directory/gminy.json', import.meta.url), 'utf8')).units as CatalogUnit[];
  const catalog = createRecipientCatalog(units);
  const suggestion = catalog.recipientSuggestions({ candidates: [{ kind: 'gmina', id: '2008063', name: 'Mońki', catalog: 'matched' }],
    places: { gmina: 'Mońki', powiat: 'powiat moniecki', nadlesnictwo: 'Knyszyn' } });
  const results = catalog.searchUnits('gmina', 'Bolesławiec').units;
  const rural = results.find(unit => unit.jstType === 'GW')!;
  const municipal = results.find(unit => unit.jstType === 'GM')!;
  const cases = { rural: noticePlaces(suggestion, rural.id, rural), municipal: noticePlaces(suggestion, municipal.id, municipal),
    unknown: noticePlaces(suggestion, null), restored: noticePlaces(suggestion, undefined) };
  const actual = Object.fromEntries(Object.entries(cases).map(([key, places]) => [key, composeNotice({ local: withFindings(),
    recipient: unit('police'), others: [], places, variant: 'unsigned', ruleSet: rules, fragments: noticeFragments, platform: 'web' }).body]));
  const expected = JSON.parse(readFileSync(new URL('golden/notice-place-correction.json', import.meta.url), 'utf8'));
  assert.deepEqual(actual, expected);
  for (const body of Object.values(actual)) {
    assert.ok(body.includes('Odległość od najbliższych zabudowań mieszkalnych: 97 m'));
    assert.ok(body.includes('52.12345° N, 21.23456° E'));
  }
});

// Ticket 29: an Incident area is stated as measurements over the whole area. The sentences below
// are written by hand, not read back from the composer.
const areaLocation: IncidentArea = { type: 'area', bounds: [21, 52, 21.05, 52.04], basis: 'reporter_selected_area', precise_fix_withheld: null };
const areaLocal = (extra: Partial<Findings>): LocalReport => ({ ...base,
  report: { ...base.report, device_fix: null, incident_location: areaLocation },
  findings: { ...findings, accuracy_m: null, dwelling_distance: { status: 'not_computed', value_m: null, search_radius_m: null, reason: 'incident_area' },
    obwod_lowiecki: { ...findings.obwod_lowiecki, status: 'not_computed', reason: 'x' } as Findings['obwod_lowiecki'], ...extra } });
const dwellingArea = (cls: 'beyond_threshold' | 'partly_within_threshold' | 'contains_dwelling', min: number, share: number): Findings['dwelling_distance'] =>
  ({ status: 'area_measured', basis: 'area', min_m: min, within_threshold_share: share, contains_dwelling: cls === 'contains_dwelling', class: cls, threshold_m: 150, search_radius_m: 1000 });
const obwodArea = (obwody: [string, number][], outside = 0): Findings['obwod_lowiecki'] => ({ status: 'area',
  obwody: obwody.map(([number, share]) => ({ name: 'Obwód łowiecki', number, source_year: 2025, share })), outside_share: outside,
  disclaimer: 'Mapa poglądowa.', source_name: 'BDL', source_url: '', retrieved_at: '' });
const wholly = (item: ProtectedArea, margin: number): ProtectedArea => ({ ...item, coverage: 'wholly_inside', area_share: 1, boundary_distance: measured(margin) });
const partly = (item: ProtectedArea, share: number): ProtectedArea => ({ ...item, coverage: 'partly_inside', area_share: share });
const bare = (name: string, extra: Partial<ProtectedArea> = {}): ProtectedArea => ({ name, inspire_id: name, ...extra });

test('area Findings are written as measurements over the whole area', () => {
  const body = (extra: Partial<Findings>) => compose(areaLocal(extra)).body;
  assert.match(body({ dwelling_distance: dwellingArea('beyond_threshold', 583, 0) }),
    /Wskazany obszar leży w całości dalej niż 150 m od zabudowań mieszkalnych\. Najbliższe zabudowania są oddalone o 583 m\./);
  assert.match(body({ dwelling_distance: { status: 'area_none_within_radius', basis: 'area', min_m: null, within_threshold_share: 0, contains_dwelling: false,
    class: 'beyond_threshold', threshold_m: 150, search_radius_m: 1000 } }),
  /Wskazany obszar leży w całości dalej niż 150 m od zabudowań mieszkalnych\. W danych nie ma zabudowań mieszkalnych w promieniu 1000 m od obszaru\./);
  assert.match(body({ dwelling_distance: dwellingArea('partly_within_threshold', 49, 0.1125) }),
    /Część wskazanego obszaru \(ok\. 11%\) leży bliżej niż 150 m od zabudowań mieszkalnych\. Najbliższe zabudowania są oddalone o 49 m\./);
  assert.match(body({ dwelling_distance: dwellingArea('partly_within_threshold', 149, 0.004) }), /Część wskazanego obszaru \(poniżej 1%\) leży bliżej/);
  assert.match(body({ dwelling_distance: dwellingArea('contains_dwelling', 0, 0.5441) }),
    /W obszarze znajdują się zabudowania mieszkalne\. Bliżej niż 150 m od zabudowań leży ok\. 54% obszaru\./);
  assert.match(body({ dwelling_distance: dwellingArea('contains_dwelling', 0, 0.5441) }), /Pomiar liczony od całego wskazanego obszaru, nie od jednego punktu\./);
  assert.match(body({ obwod_lowiecki: obwodArea([['111', 0.956], ['93', 0.004]], 0.04) }),
    /Wskazany obszar obejmuje obwody łowieckie: nr 111 \(96%\), nr 93 \(poniżej 1%\)\. Poza obwodami łowieckimi leży 4% obszaru\. Mapa poglądowa\./);
  assert.match(body({ obwod_lowiecki: obwodArea([]) }), /Wskazany obszar leży poza obwodami łowieckimi\. Mapa poglądowa\./);
  const parkWholly = body({ protected_areas: areas({ park_narodowy: [wholly(bare('Park'), 289.5)] }) });
  assert.match(parkWholly, /Wskazany obszar leży w całości w parku narodowym Park, 290 m od granicy; polowanie jest tam zakazane\. art\. 15 ust\. 1 pkt 4/);
  const parkPartly = body({ protected_areas: areas({ park_narodowy: [partly(bare('Park'), 0.064)] }) });
  assert.match(parkPartly, /Część wskazanego obszaru \(6%\) leży w parku narodowym Park\./);
  assert.doesNotMatch(parkPartly, /zakazane/);
  assert.match(body({ protected_areas: areas({ rezerwat: [wholly(bare('Las', { document_state: 'neither' }), 289)] }) }),
    /Wskazany obszar leży w całości w rezerwacie Las, 289 m od granicy\. Rezerwat nie ma planu ochrony ani zadań ochronnych; polowanie jest tam zakazane\./);
  const reservePartly = body({ protected_areas: areas({ rezerwat: [partly(bare('Las', { document_state: 'neither' }), 0.5)] }) });
  assert.match(reservePartly, /Część wskazanego obszaru \(50%\) leży w rezerwacie Las\. Rezerwat nie ma planu ochrony ani zadań ochronnych\./);
  assert.doesNotMatch(reservePartly, /zakazane/);
  assert.match(body({ protected_areas: areas({ otulina: [partly(bare('Park', { parent_kind: 'park_narodowy' }), 0.3)] }) }), /Część wskazanego obszaru \(30%\) leży w otulinie: Park\./);
  const everything = compose(areaLocal({ dwelling_distance: dwellingArea('contains_dwelling', 0, 0.5441), obwod_lowiecki: obwodArea([['111', 1]]),
    protected_areas: areas({ park_narodowy: [wholly(bare('Park'), 289)], rezerwat: [partly(bare('Las', { document_state: 'neither' }), 0.5)], otulina: [partly(bare('Park'), 0.1)] }) }));
  assert.doesNotMatch(everything.body, /Punkt|punktu wskazanego|Odległość od najbliższych/);
  assert.ok(!everything.fragmentIds.some(id => /^C[0-9]+$/.test(id) || id === 'D1'), everything.fragmentIds.join());
});

test('area Notice distinguishes threshold contact, full coverage and genuine partial shares', () => {
  const body = (extra: Partial<Findings>) => compose(areaLocal(extra)).body;
  const contact = body({ dwelling_distance: dwellingArea('partly_within_threshold', 150, 0) });
  assert.match(contact, /Obszar styka się z granicą strefy 150 m/);
  assert.doesNotMatch(contact, /Część wskazanego obszaru.*leży bliżej|0%/);
  const full = body({ dwelling_distance: dwellingArea('partly_within_threshold', 100, 1) });
  assert.match(full, /Cały wskazany obszar leży w odległości do 150 m/);
  assert.doesNotMatch(full, /Część wskazanego obszaru.*leży bliżej/);
  assert.match(body({ dwelling_distance: dwellingArea('contains_dwelling', 0, 0.999) }), /leży ponad 99% obszaru/);
  for (const [share, label] of [[0.0000000656, 'poniżej 1%'], [0.999, 'ponad 99%'], [1, 'ponad 99%']] as const) {
    const partial = body({ protected_areas: areas({ park_narodowy: [partly(bare('Park'), share)] }) });
    assert.ok(partial.includes(`Część wskazanego obszaru (${label}) leży w parku narodowym Park.`));
    assert.doesNotMatch(partial, /\(0%\)|\(100%\)|polowanie jest tam zakazane/);
  }
  const sliver = body({ obwod_lowiecki: obwodArea([['1', 0.9999999344]], 0.0000000656) });
  assert.match(sliver, /nr 1 \(ponad 99%\)/);
  assert.match(sliver, /Poza obwodami łowieckimi leży poniżej 1% obszaru/);
});

test('area Notice keeps the actual source year when one district has multiple vintages', () => {
  const districts = obwodArea([['1', 0.25], ['1', 0.5], ['2', 0.25]]);
  assert.equal(districts.status, 'area');
  if (districts.status !== 'area') throw new Error('Expected area fixture');
  districts.obwody[0].source_year = 2024;
  districts.obwody[1].source_year = 2025;
  districts.obwody[2].source_year = 2026;
  const body = compose(areaLocal({ obwod_lowiecki: districts })).body;
  assert.match(body, /nr 1 \(dane z 2024 r\.; 25%\), nr 1 \(dane z 2025 r\.; 50%\), nr 2 \(25%\)/);
});

test('every area class has a pinned Notice golden', () => {
  const cases: Record<string, Partial<Findings>> = {
    dwelling_beyond: { dwelling_distance: dwellingArea('beyond_threshold', 583, 0), obwod_lowiecki: obwodArea([['93', 1]]) },
    dwelling_none_within_radius: { dwelling_distance: { status: 'area_none_within_radius', basis: 'area', min_m: null, within_threshold_share: 0,
      contains_dwelling: false, class: 'beyond_threshold', threshold_m: 150, search_radius_m: 1000 }, obwod_lowiecki: obwodArea([]) },
    dwelling_partly_within: { dwelling_distance: dwellingArea('partly_within_threshold', 49, 0.1125), obwod_lowiecki: obwodArea([['112', 1]]) },
    dwelling_contains: { dwelling_distance: dwellingArea('contains_dwelling', 0, 0.5441) },
    obwody_multiple: { obwod_lowiecki: obwodArea([['111', 0.93], ['112', 0.007], ['93', 0.033]], 0.03) },
    park_wholly: { protected_areas: areas({ park_narodowy: [wholly(bare('Testowy Park Narodowy'), 289.5)] }) },
    park_partly: { protected_areas: areas({ park_narodowy: [partly(bare('Testowy Park Narodowy'), 0.064)], otulina: [partly(bare('Testowy Park Narodowy', { parent_kind: 'park_narodowy' }), 0.044)] }) },
    rezerwat_neither_wholly: { protected_areas: areas({ rezerwat: [wholly(bare('Testowy Las', { document_state: 'neither' }), 289.4)] }) },
    rezerwat_plan_partly: { protected_areas: areas({ rezerwat: [partly({ ...bare('Testowy Plan', { document_state: 'plan_ochrony' }),
      documents: [{ kind: 'plan_ochrony', url: 'https://example.org/plan' }] }, 0.5)] }) }
  };
  const actual = Object.fromEntries(Object.entries(cases).map(([name, extra]) => [name, compose(areaLocal(extra)).body]));
  const path = new URL('golden/notice-area-cases.json', import.meta.url);
  if (process.env.WRITE_GOLDEN) writeFileSync(path, JSON.stringify(actual, null, 2) + '\n');
  assert.deepEqual(actual, JSON.parse(readFileSync(path, 'utf8')));
});
