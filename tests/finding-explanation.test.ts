import assert from 'node:assert/strict';
import test from 'node:test';
import { explainDwelling, explainNight, seasonCitation } from '../src/lib/finding-explanation.ts';
import { dwellingAreaClass } from '../src/lib/findings-reading.ts';
import { findingRuleSet } from '../src/lib/notice-rule-set.ts';

test('historical Findings use their named Rule set', () => {
  const old = findingRuleSet('pl-2018-04-01-v2-protected-v1');
  const current = findingRuleSet('pl-2026-09-24-v2-protected-v1');
  assert.equal(old?.id, 'pl-2018-04-01-v2');
  assert.equal(current?.id, 'pl-2026-09-24-v2');
  assert.match(old!.citations.noc, /Dz\.U\. 2017 poz\. 1485/);
  assert.match(current!.citations.noc, /Dz\.U\. 2022 poz\. 2323/);
  assert.match(explainNight(old!, 'en'), /60 minutes after sunset/);
  assert.equal(findingRuleSet('unknown'), undefined);
  assert.match(seasonCitation(current!, 'pizmak', { status: 'not_a_game_species', delisted_on: '2022-04-01', citation: 'ignored' }), /Dz\.U\. 2022 poz\. 696/);
});

test('dwelling explanation preserves uncertainty at threshold', () => {
  const rules = findingRuleSet('pl-2026-09-24-v2-protected-v1')!;
  const measurement = { status: 'measured', value_m: 145, search_radius_m: 1000 } as const;
  const polish = explainDwelling(measurement, 12, rules, 'pl');
  const english = explainDwelling(measurement, 12, rules, 'en');
  assert.match(polish, /150 m/);
  assert.match(polish, /nie pozwala/);
  assert.match(english, /cannot tell/);
  assert.doesNotMatch(polish + english, /zakaz|ban|guilty|wina/i);
  assert.match(explainDwelling(measurement, null, rules, 'en'), /No GPS accuracy/);
  assert.match(explainDwelling({ status: 'not_computed', value_m: null, search_radius_m: null, reason: 'incident_area' }, null, rules, 'en'), /approximate area/);
});

test('coverage failure is not explained as an unmeasurable approximate area', () => {
  const rules = findingRuleSet('pl-2026-09-24-v2-protected-v1')!;
  const missing = { status: 'not_computed', value_m: null, search_radius_m: null, reason: 'outside_coverage' } as const;
  assert.match(explainDwelling(missing, null, rules, 'pl'), /wykracza poza zasięg danych/);
  assert.match(explainDwelling(missing, null, rules, 'en'), /extends beyond the data coverage/);
  assert.doesNotMatch(explainDwelling(missing, null, rules, 'en'), /no point from which to measure/);
});

test('area explanation says the whole area was measured, and classes follow the threshold', () => {
  const rules = findingRuleSet('pl-2026-09-24-v2-protected-v1')!;
  const area = { status: 'area_measured', basis: 'area', min_m: 49, within_threshold_share: 0.11, contains_dwelling: false,
    class: 'partly_within_threshold', threshold_m: 150, search_radius_m: 1000 } as const;
  assert.match(explainDwelling(area, null, rules, 'pl'), /całego wskazanego obszaru.*nie od jego środka.*nie ocena winy/);
  assert.match(explainDwelling(area, null, rules, 'en'), /whole indicated area, not from its centre/);
  // A distance equal to the threshold is still within it; a dwelling inside always wins.
  assert.equal(dwellingAreaClass(150, false, 150), 'partly_within_threshold');
  assert.equal(dwellingAreaClass(150.01, false, 150), 'beyond_threshold');
  assert.equal(dwellingAreaClass(0, true, 150), 'contains_dwelling');
});
