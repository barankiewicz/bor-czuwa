import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { evaluateTimeFindings, type RuleSet } from '../src/lib/time-findings.ts';

const point = { lat: 52.2297, lon: 21.0122 };
type CitedRuleSet = RuleSet & { sources: string[]; citations: RuleSet['citations'] & { dwelling: string; game_list: string } };

// Dates and expected Findings come from the cited acts. Hashes lock every season, including dates outside these samples.
const cases = [
  ['2018-04-01', '2018-04-15T23:30:00+02:00', 'kuna-lesna', 'not_computed', true, '05:39:51', '19:33:22', '08af423205bb84ed3ececfd7e45f8c4a9b97fed1da2a84f2641914d324f3d406'],
  ['2019-03-01', '2019-08-15T23:30:00+02:00', 'szakal-zlocisty', 'outside_closed_season', true, '05:18:29', '20:01:29', '0eb672db5ef137ebb54ba257c8a4214471bdb6bbf00744b84ace26483696caad'],
  ['2021-07-23', '2021-08-20T23:30:00+02:00', 'krzyzowka', 'in_closed_season', true, '05:26:42', '19:51:05', '8168ea842b806ca1b69f53bd942af0217abb928ef8c4e19dbc00ce90f7151482'],
  ['2022-04-01', '2022-04-15T23:30:00+02:00', 'norka-amerykanska', 'no_closed_season_exists', true, '05:39:51', '19:33:22', '17bcb5bcd9ba7253768d3433f8621caaf1040ad2337545695305ce727657eba5'],
  ['2022-07-02', '2022-07-15T23:30:00+02:00', 'zajac-szarak', 'not_computed', false, '04:32:08', '20:50:57', '74b7182a4aaf35087edaafff61fac0888ab7f44514d8ee749a4a777be8a77dfc'],
  ['2022-11-16', '2022-11-20T23:30:00+01:00', 'kuna-lesna', 'outside_closed_season', false, '07:04:31', '15:37:50', 'f987287b07281cf63f348137dc3b7c7bda95f9e3a31676ad0ba9968f398ff538'],
  ['2026-09-24-v2', '2026-02-15T23:30:00+01:00', 'slonka', 'not_a_game_species', false, '06:52:31', '16:48:46', '3842f855b581b8f664f394fb4d4dce42aa0c80baa3ee13b3a9d353e32797fbee']
] as const;

async function rule(file: string): Promise<CitedRuleSet> {
  return JSON.parse(await readFile(new URL(`../data/rule-sets/${file}.json`, import.meta.url), 'utf8'));
}

function finding(ruleSet: RuleSet, at: string, species: string) {
  return evaluateTimeFindings({ at, coarseness: 'exact' }, point, species, ruleSet);
}

for (const [file, at, species, season, nocSpecies, sunrise, sunset, hash] of cases) {
  test(`${file} pins legal data and Findings`, async () => {
    const ruleSet = await rule(file);
    assert.equal(ruleSet.effective_from, file.slice(0, 10) === '2026-09-24' ? '2026-01-02' : file);
    assert.equal(ruleSet.published_at, file === '2018-04-01' ? '2026-09-24T21:00:00Z' : '2026-09-24T20:30:00Z');
    assert.ok(ruleSet.sources.length >= 4);
    for (const source of ruleSet.sources) assert.match(source, /Dz\.U\. \d{4} poz\. \d+/);
    for (const citation of Object.values(ruleSet.citations)) assert.match(citation, /Dz\.U\. \d{4} poz\. \d+/);
    assert.equal(createHash('sha256').update(JSON.stringify(ruleSet)).digest('hex'), hash);

    const result = finding(ruleSet, at, species);
    assert.equal(result.okres_ochronny.status, season);
    assert.equal(result.noc.status, 'computed');
    if (result.noc.status === 'computed') {
      assert.ok('sunrise' in result.noc && 'sunset' in result.noc);
      assert.equal(result.noc.sunrise, `${at.slice(0, 11)}${sunrise}${at.slice(-6)}`);
      assert.equal(result.noc.sunset, `${at.slice(0, 11)}${sunset}${at.slice(-6)}`);
      assert.equal(result.noc.at_night, true);
      assert.equal(result.noc.species_huntable_at_night, nocSpecies);
    }
  });
}

test('five birds cease to be game species on 2026-01-02', async () => {
  const before = await rule('2022-11-16');
  const after = await rule('2026-09-24-v2');
  for (const species of ['jarzabek', 'glowienka', 'czernica', 'slonka', 'lyska']) {
    assert.notEqual(finding(before, '2025-12-31T12:00:00+01:00', species).okres_ochronny.status, 'not_a_game_species');
    const result = finding(after, '2026-01-02T12:00:00+01:00', species).okres_ochronny;
    assert.equal(result.status, 'not_a_game_species');
    if (result.status === 'not_a_game_species') assert.match(result.citation, /Dz\.U\. 2025 poz\. 1286/);
  }
});

test('four species cease to be game species on 2022-04-01', async () => {
  const before = await rule('2021-07-23');
  const after = await rule('2022-04-01');
  for (const species of ['jelen-sika', 'jenot', 'szop-pracz', 'pizmak']) {
    assert.notEqual(finding(before, '2022-03-31T12:00:00+02:00', species).okres_ochronny.status, 'not_a_game_species');
    const result = finding(after, '2022-04-01T12:00:00+02:00', species).okres_ochronny;
    assert.equal(result.status, 'not_a_game_species');
    if (result.status === 'not_a_game_species') assert.match(result.citation, /Dz\.U\. 2022 poz\. 696/);
  }
});

test('duck season and noc species change on their effective dates', async () => {
  assert.equal(finding(await rule('2018-04-01'), '2018-08-20T12:00:00+02:00', 'krzyzowka').okres_ochronny.status, 'outside_closed_season');
  assert.equal(finding(await rule('2021-07-23'), '2021-08-20T12:00:00+02:00', 'krzyzowka').okres_ochronny.status, 'in_closed_season');
  assert.equal(finding(await rule('2018-04-01'), '2018-04-15T12:00:00+02:00', 'dzik').okres_ochronny.status, 'no_closed_season_exists');
  const before = finding(await rule('2022-07-02'), '2022-07-15T23:30:00+02:00', 'kuna-lesna').noc;
  const after = finding(await rule('2022-11-16'), '2022-11-20T23:30:00+01:00', 'kuna-lesna').noc;
  assert.equal(before.status === 'computed' && before.species_huntable_at_night, true);
  assert.equal(after.status === 'computed' && after.species_huntable_at_night, false);
});
