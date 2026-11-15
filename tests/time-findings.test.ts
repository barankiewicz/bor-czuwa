import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { evaluateTimeFindings, type RuleSet } from '../src/lib/time-findings.ts';

const currentRule = JSON.parse(await readFile(new URL('../data/rule-sets/2026-09-24-v2.json', import.meta.url), 'utf8')) as RuleSet;

const rule: RuleSet = {
  id: 'pl-current',
  effective_from: '2018-04-01',
  published_at: '2026-01-02',
  noc: { starts_after_sunset_minutes: 60, ends_before_sunrise_minutes: 60,
    species: ['dzik', 'lis'] },
  species: {
    sarna: { label: 'Sarna', closed_seasons: [{ from: '01-16', to: '05-10' }], other_dates_need_details: true },
    dzik: { label: 'Dzik', closed_seasons: [] },
    slonka: { label: 'Słonka', closed_seasons: [], delisted_on: '2026-01-02' },
    lis: { label: 'Lis', closed_seasons: [{ from: '04-01', to: '05-31' }] }
  },
  citations: { okres_ochronny: 'Dz.U. 2023 poz. 99', noc: 'Dz.U. 2022 poz. 2323' }
};

const point = { lat: 52.2297, lon: 21.0122 };

test('area date-only and unavailable solar bounds stay unresolved', () => {
  const area = { bounds: [20, 53, 25, 54] as [number, number, number, number] };
  const dateOnly = evaluateTimeFindings({ at: '2026-03-14T12:00:00+01:00', coarseness: 'date_only' }, area, 'sarna', rule);
  assert.deepEqual(dateOnly.noc, { status: 'not_computed', reason: 'date_only' });
  const polar = evaluateTimeFindings({ at: '2026-06-14T23:30:00+02:00', coarseness: 'exact' },
    { bounds: [20, 80, 25, 85] }, 'sarna', rule);
  assert.deepEqual(polar.noc, { status: 'not_computed', reason: 'incident_area' });
  const dateWrap = evaluateTimeFindings({ at: '2026-03-14T12:00:00+01:00', coarseness: 'exact' },
    { bounds: [140, 53, 145, 54] }, 'sarna', rule);
  assert.deepEqual(dateWrap.noc, { status: 'not_computed', reason: 'incident_area' });
});

test('noc uses Europe/Warsaw on DST changeover and in winter', () => {
  const dst = evaluateTimeFindings({ at: '2026-03-29T21:30:00+02:00', coarseness: 'exact' }, point, 'sarna', rule);
  const winter = evaluateTimeFindings({ at: '2026-01-15T20:00:00+01:00', coarseness: 'exact' }, point, 'sarna', rule);

  assert.equal(dst.noc.status, 'computed');
  assert.equal(winter.noc.status, 'computed');
  if (dst.noc.status === 'computed' && winter.noc.status === 'computed') {
    assert.ok('sunset' in dst.noc && 'sunset' in winter.noc);
    assert.equal(dst.noc.at_night, true);
    assert.equal(winter.noc.at_night, true);
    assert.match(dst.noc.sunset, /\+02:00$/);
    assert.match(winter.noc.sunset, /\+01:00$/);
  }
});

test('within-hours reports compute only when whole window stays on one side of noc boundary', () => {
  const daytime = evaluateTimeFindings({ at: '2026-06-15T12:00:00+02:00', window_end: '2026-06-15T14:00:00+02:00', coarseness: 'within_hours' }, point, 'dzik', rule);
  const nighttime = evaluateTimeFindings({ at: '2026-06-15T23:00:00+02:00', window_end: '2026-06-16T01:00:00+02:00', coarseness: 'within_hours' }, point, 'dzik', rule);
  const straddling = evaluateTimeFindings({ at: '2026-06-15T21:00:00+02:00', window_end: '2026-06-15T23:30:00+02:00', coarseness: 'within_hours' }, point, 'dzik', rule);

  assert.equal(daytime.noc.status, 'computed');
  assert.equal(nighttime.noc.status, 'computed');
  assert.equal(straddling.noc.status, 'not_computed');
  if (daytime.noc.status === 'computed' && nighttime.noc.status === 'computed') {
    assert.equal(daytime.noc.at_night, false);
    assert.equal(nighttime.noc.at_night, true);
  }
  if (straddling.noc.status === 'not_computed') assert.equal(straddling.noc.reason, 'time_too_coarse');
});

test('okres ochronny distinguishes season, year-round, delisting, unknown and unset', () => {
  assert.equal(evaluateTimeFindings({ at: '2026-03-15T12:00:00+01:00', coarseness: 'date_only' }, point, 'sarna', rule).okres_ochronny.status, 'in_closed_season');
  assert.deepEqual(evaluateTimeFindings({ at: '2026-06-15T12:00:00+02:00', coarseness: 'date_only' }, point, 'sarna', rule).okres_ochronny,
    { status: 'not_computed', reason: 'species_details_required', citation: rule.citations.okres_ochronny });
  assert.equal(evaluateTimeFindings({ at: '2026-06-15T12:00:00+02:00', coarseness: 'date_only' }, point, 'lis', rule).okres_ochronny.status, 'outside_closed_season');
  assert.equal(evaluateTimeFindings({ at: '2026-06-15T12:00:00+02:00', coarseness: 'date_only' }, point, 'dzik', rule).okres_ochronny.status, 'no_closed_season_exists');
  const delisted = evaluateTimeFindings({ at: '2026-06-15T12:00:00+02:00', coarseness: 'date_only' }, point, 'slonka', rule).okres_ochronny;
  assert.equal(delisted.status, 'not_a_game_species');
  if (delisted.status === 'not_a_game_species') assert.equal(delisted.delisted_on, '2026-01-02');
  assert.equal(evaluateTimeFindings({ at: '2026-06-15T12:00:00+02:00', coarseness: 'date_only' }, point, 'unknown', rule).okres_ochronny.status, 'not_applicable_reporter_unknown');
  assert.equal(evaluateTimeFindings({ at: '2026-06-15T12:00:00+02:00', coarseness: 'date_only' }, point, null, rule).okres_ochronny.status, 'not_applicable_species_unset');
});

test('current Rule set covers game list and keeps unresolved cases honest', () => {
  assert.equal(Object.values(currentRule.species).filter(value => !value.delisted_on).length, 23);
  const time = { at: '2026-01-20T12:00:00+01:00', coarseness: 'date_only' as const };
  assert.equal(evaluateTimeFindings(time, point, 'sarna', currentRule).okres_ochronny.status, 'in_closed_season');
  const summer = evaluateTimeFindings({ at: '2026-06-15T12:00:00+02:00', coarseness: 'date_only' }, point, 'sarna', currentRule);
  assert.equal(summer.okres_ochronny.status, 'not_computed');
  if (summer.okres_ochronny.status === 'not_computed') assert.equal(summer.okres_ochronny.reason, 'species_details_required');
  const slonka = evaluateTimeFindings({ at: '2026-06-15T12:00:00+02:00', coarseness: 'date_only' }, point, 'slonka', currentRule);
  assert.equal(slonka.okres_ochronny.status, 'not_a_game_species');
  if (slonka.okres_ochronny.status === 'not_a_game_species') assert.match(slonka.okres_ochronny.citation, /Dz\.U\. 2025 poz\. 1286/);
  const goose = evaluateTimeFindings({ at: '2026-06-15T23:30:00+02:00', coarseness: 'exact' }, point, 'ges-gegawa', currentRule);
  assert.equal(goose.noc.status, 'computed');
  if (goose.noc.status === 'computed') assert.equal(goose.noc.species_huntable_at_night, true);
});

test('Rule set handles calendar shifts, local exceptions and delisted piżmak', () => {
  const dateOnly = (at: string, species: string) => evaluateTimeFindings({ at, coarseness: 'date_only' }, point, species, currentRule).okres_ochronny;
  assert.equal(dateOnly('2026-01-16T12:00:00+01:00', 'sarna').status, 'not_computed');
  assert.equal(evaluateTimeFindings({ at: '2026-01-16T12:00:00+01:00', coarseness: 'exact' }, point, 'sarna', currentRule).okres_ochronny.status, 'in_closed_season');
  assert.equal(dateOnly('2026-01-17T12:00:00+01:00', 'sarna').status, 'in_closed_season');
  assert.equal(dateOnly('2027-05-09T12:00:00+02:00', 'sarna').status, 'in_closed_season');
  assert.equal(dateOnly('2027-01-01T12:00:00+01:00', 'los').status, 'in_closed_season');
  assert.equal(dateOnly('2026-05-15T12:00:00+02:00', 'szakal-zlocisty').status, 'not_computed');
  assert.equal(dateOnly('2026-09-15T12:00:00+02:00', 'szakal-zlocisty').status, 'outside_closed_season');
  const pizmak = evaluateTimeFindings({ at: '2026-09-24T23:30:00+02:00', coarseness: 'exact' }, point, 'pizmak', currentRule);
  assert.equal(pizmak.okres_ochronny.status, 'not_a_game_species');
  assert.equal(pizmak.noc.status, 'computed');
  if (pizmak.noc.status === 'computed') assert.equal(pizmak.noc.species_huntable_at_night, false);
});

test('coarse time stays unresolved at noc and season boundaries', () => {
  const sunset = evaluateTimeFindings({ at: '2026-06-15T12:00:00+02:00', coarseness: 'exact' }, point, 'dzik', rule).noc;
  assert.equal(sunset.status, 'computed');
  if (sunset.status !== 'computed') return;
  assert.ok('sunset' in sunset);
  const nightStarts = new Date(sunset.sunset).getTime() + 3_601_000;
  const noc = evaluateTimeFindings({ at: new Date(nightStarts - 60_000).toISOString(),
    window_end: new Date(nightStarts).toISOString(), coarseness: 'within_hours' }, point, 'dzik', rule);
  assert.deepEqual(noc.noc, { status: 'not_computed', reason: 'time_too_coarse' });
  const season = evaluateTimeFindings({ at: '2026-05-10T23:00:00+02:00',
    window_end: '2026-05-11T01:00:00+02:00', coarseness: 'within_hours' }, point, 'sarna', rule);
  assert.deepEqual(season.okres_ochronny, { status: 'not_computed', reason: 'time_too_coarse' });
});

test('polar latitudes leave noc not computed instead of throwing', () => {
  // On 2026-06-21 the sun never sets north of the Arctic Circle; at -70 it never rises.
  for (const [lat, at] of [[70, '2026-06-21T12:00:00+02:00'], [89, '2026-06-21T12:00:00+02:00'],
    [-70, '2026-06-21T12:00:00+02:00'], [66.9, '2026-06-21T12:00:00+02:00']] as const) {
    for (const coarseness of ['exact', 'within_hours'] as const) {
      const time = coarseness === 'exact' ? { at, coarseness } : { at, coarseness, window_end: '2026-06-21T14:00:00+02:00' };
      const result = evaluateTimeFindings(time, { lat, lon: 21 }, 'dzik', rule);
      assert.deepEqual(result.noc, { status: 'not_computed', reason: 'sun_unavailable' }, `lat ${lat} ${coarseness}`);
      assert.deepEqual(result.okres_ochronny, evaluateTimeFindings(time, point, 'dzik', rule).okres_ochronny);
    }
  }
  // Warsaw is unchanged.
  assert.equal(evaluateTimeFindings({ at: '2026-06-21T12:00:00+02:00', coarseness: 'exact' }, point, 'dzik', rule).noc.status, 'computed');
});

test('polar areas never throw', () => {
  for (const lat of [70, 89, -70, 66.9]) {
    const result = evaluateTimeFindings({ at: '2026-06-21T12:00:00+02:00', coarseness: 'exact' },
      { bounds: [20, lat - 0.5, 22, Math.min(lat + 0.5, 89.9)] }, 'dzik', rule);
    assert.equal(result.noc.status, 'not_computed', `lat ${lat}`);
  }
});

// Independent NOAA fractional-year calculation for 14 March 2026, 53..54 N / 20..25 E:
// legal night ends between 04:39 and 05:00, starts between 18:20 and 18:41 (Warsaw).
// These literal times have margins beyond the difference from the Williams approximation.
// The 5 by 1 degree area is far beyond what the API takes (ticket 25), so this runs on the function.
for (const [label, at, end, expected] of [
  ['midnight', '2026-03-14T23:30:00+01:00', null, true],
  ['daylight', '2026-03-14T12:00:00+01:00', null, false],
  ['sunrise boundary', '2026-03-14T04:49:00+01:00', null, null],
  ['sunset boundary', '2026-03-14T18:30:00+01:00', null, null],
  ['whole night window', '2026-03-14T23:00:00+01:00', '2026-03-15T01:00:00+01:00', true],
  ['window across sunrise', '2026-03-14T03:00:00+01:00', '2026-03-14T06:00:00+01:00', null]
] as const) test(`area noc: ${label} is determined over the whole area and time window`, () => {
  const result = evaluateTimeFindings({ at, coarseness: end ? 'within_hours' : 'exact', ...(end ? { window_end: end } : {}) },
    { bounds: [20, 53, 25, 54] }, 'sarna', currentRule);
  assert.equal(result.okres_ochronny.status, 'in_closed_season');
  if (expected === null) assert.deepEqual(result.noc, { status: 'not_computed', reason: 'incident_area' });
  else {
    assert.equal(result.noc.status, 'computed');
    if (result.noc.status !== 'computed') return;
    assert.equal(result.noc.at_night, expected);
    assert.equal(result.noc.spatial_basis, 'incident_area');
    assert.ok('sunrise_range' in result.noc);
    assert.ok(new Date(result.noc.sunrise_range.earliest) < new Date(result.noc.sunrise_range.latest));
    assert.ok(new Date(result.noc.sunset_range.earliest) < new Date(result.noc.sunset_range.latest));
    assert.equal('sunrise' in result.noc, false);
  }
});
