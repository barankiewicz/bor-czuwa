import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRecipientCatalog, noticePlaces, type RecipientLookup, type RecipientUnit } from '../src/lib/recipient-resolver.ts';

const files = ['police', 'regional', 'parks', 'gminy'].map(name => new URL(`../data/authority-directory/${name}.json`, import.meta.url));
const units = (await Promise.all(files.map(async file => JSON.parse(await readFile(file, 'utf8')).units as RecipientUnit[]))).flat();
const { recipientSuggestions, searchUnits } = createRecipientCatalog(units);

const names = (query: string, kind: Parameters<typeof searchUnits>[0] = 'gmina') =>
  searchUnits(kind, query).units.map(unit => unit.name);

test('lodz and łódź find Łódź first, ahead of loose fragments', () => {
  for (const query of ['lodz', 'łódź', 'ŁÓDŹ', ' Lodz ']) {
    assert.equal(names(query)[0], 'Urząd Miasta Łodzi', query);
    assert.ok(names(query).includes('Urząd Miejski w Konstantynowie Łódzkim'), query);
  }
  assert.match(names('lodz', 'police')[0], /Łodzi/);
});

test('Warszawa finds its official unit despite Warszawy in the name', () => {
  assert.equal(names('Warszawa')[0], 'Urząd Miasta Stołecznego Warszawy');
  assert.equal(names('warszawy')[0], 'Urząd Miasta Stołecznego Warszawy');
});

test('duplicate locality names are all returned, exact matches first, with disambiguating context', () => {
  const result = searchUnits('gmina', 'Bolesławiec');
  const exact = result.units.filter(unit => unit.place === 'Bolesławiec');
  assert.deepEqual(exact.map(unit => unit.name),
    ['Urząd Gminy Bolesławiec', 'Urząd Miasta Bolesławiec', 'Urząd Miasta i Gminy w Bolesławcu']);
  assert.deepEqual(result.units.slice(0, 3), exact);
  assert.deepEqual(exact.map(unit => [unit.jstType, unit.powiat, unit.voivodeship]),
    [['GW', 'bolesławiecki', 'dolnośląskie'], ['GM', 'bolesławiecki', 'dolnośląskie'], ['GMW', 'wieruszowski', 'łódzkie']]);
  assert.equal(result.units[3].name, 'Urząd Gminy Warta Bolesławiecka');
});

test('results are capped with the full count kept, and short or empty searches return nothing', () => {
  const many = searchUnits('gmina', 'urząd');
  assert.equal(many.units.length, 25);
  assert.ok(many.total > 2000);
  assert.deepEqual(searchUnits('gmina', 'x'), { units: [], total: 0 });
  assert.deepEqual(searchUnits('gmina', 'zzqq'), { units: [], total: 0 });
});

const moniekiPoint: RecipientLookup = {
  candidates: [
    { kind: 'gmina', id: '2008063', name: 'Urząd Miejski w Mońkach', catalog: 'matched' },
    { kind: 'police', id: 'c753fb0c-78e2-419d-ad48-d7bf3b5218ac', name: 'KPP', catalog: 'matched' },
    { kind: 'psl', id: '20', name: 'PSŁ', catalog: 'matched' }
  ],
  units: [{ kind: 'gmina', id: '2008063' }, { kind: 'police', id: 'c753fb0c-78e2-419d-ad48-d7bf3b5218ac' }, { kind: 'psl', id: '20' }],
  places: { gmina: 'Mońki', powiat: 'powiat moniecki', nadlesnictwo: 'NADLEŚNICTWO KNYSZYN' },
  ambiguity: { ambiguous: false, roles: [], unresolved: [] }
};
const crossingArea: RecipientLookup = {
  candidates: [
    { kind: 'gmina', id: '2008032', name: 'Urząd Gminy Jaświły', catalog: 'matched' },
    { kind: 'gmina', id: '2008063', name: 'Urząd Miejski w Mońkach', catalog: 'matched' },
    { kind: 'police', id: 'c753fb0c-78e2-419d-ad48-d7bf3b5218ac', name: 'KPP', catalog: 'matched' },
    { kind: 'psl', id: '20', name: 'PSŁ', catalog: 'matched' },
    { kind: 'police', id: 'not-in-catalog', name: 'Unknown', catalog: 'unknown' }
  ],
  ambiguity: { ambiguous: true, roles: ['gmina'], unresolved: [] }
};

test('a unique point proposes each authority, keeps gmina optional and names the place', () => {
  const suggestion = recipientSuggestions(moniekiPoint);
  assert.deepEqual(suggestion.roles.map(role => [role.kind, role.ambiguous, role.units.map(unit => unit.id)]), [
    ['police', false, ['c753fb0c-78e2-419d-ad48-d7bf3b5218ac']], ['psl', false, ['20']], ['gmina', false, ['2008063']]
  ]);
  assert.deepEqual(suggestion.proposed.map(unit => unit.kind), ['police', 'psl']);
  assert.equal(suggestion.incomplete, false);
  assert.deepEqual(noticePlaces(suggestion, undefined), moniekiPoint.places);
});

test('an area crossing gminy proposes unique roles but leaves the gmina to the Reporter', () => {
  const suggestion = recipientSuggestions(crossingArea);
  assert.deepEqual(suggestion.roles.find(role => role.kind === 'gmina')?.ambiguous, true);
  assert.deepEqual(suggestion.proposed.map(unit => unit.kind), ['psl']);
  assert.equal(suggestion.roles.find(role => role.kind === 'police')?.units.length, 1);
  assert.equal(suggestion.incomplete, true);
  assert.equal(suggestion.gminaQuestion, true);
  assert.deepEqual(noticePlaces(suggestion, undefined), undefined);
  assert.deepEqual(noticePlaces(suggestion, null), { gmina: null, powiat: 'powiat moniecki', nadlesnictwo: null,
    gminy: ['Jaświły', 'Mońki'] });
  assert.deepEqual(noticePlaces(suggestion, '2008032'), { gmina: 'Jaświły', powiat: 'powiat moniecki', nadlesnictwo: null,
    gminy: ['Jaświły', 'Mońki'], gmina_source: 'reporter' });
});

test('an area inside one gmina names it from the directory without asking', () => {
  const suggestion = recipientSuggestions({
    candidates: [{ kind: 'gmina', id: '2008072', name: 'Urząd Gminy Trzcianne', catalog: 'matched' },
      { kind: 'police', id: 'c753fb0c-78e2-419d-ad48-d7bf3b5218ac', name: 'KPP', catalog: 'matched' }],
    ambiguity: { ambiguous: false, roles: [], unresolved: [] }
  });
  assert.equal(suggestion.gminaQuestion, false);
  assert.deepEqual(suggestion.proposed.map(unit => unit.kind), ['police']);
  assert.deepEqual(noticePlaces(suggestion, undefined), { gmina: 'Trzcianne', powiat: 'powiat moniecki', nadlesnictwo: null });
});

test('unresolved roles keep a partial suggestion incomplete without losing matched candidates', () => {
  const suggestion = recipientSuggestions({
    candidates: moniekiPoint.candidates!.filter(candidate => candidate.kind === 'police'),
    ambiguity: { ambiguous: false, roles: [], unresolved: ['gmina', 'psl'] }
  });
  assert.equal(suggestion.incomplete, true);
  assert.deepEqual(suggestion.proposed.map(unit => unit.kind), ['police']);
});

test('explicit unknown overrides a single point proposal and restoring leaves the proposal intact', () => {
  const suggestion = recipientSuggestions(moniekiPoint);
  assert.equal(noticePlaces(suggestion, null)?.gmina, null);
  assert.deepEqual(noticePlaces(suggestion, undefined), moniekiPoint.places);
});

test('catalog correction overrides geometry without changing recipients or measured place context', () => {
  const suggestion = recipientSuggestions(moniekiPoint);
  const before = structuredClone(suggestion);
  const rural = searchUnits('gmina', 'Bolesławiec').units.find(unit => unit.jstType === 'GW')!;
  const corrected = noticePlaces(suggestion, rural.id, rural);
  assert.equal(corrected?.gmina, 'Bolesławiec');
  assert.equal(corrected?.gmina_type, 'gmina wiejska');
  assert.equal(corrected?.wojewodztwo, 'dolnośląskie');
  assert.equal(corrected?.powiat, 'powiat bolesławiecki');
  assert.equal(corrected?.nadlesnictwo, moniekiPoint.places?.nadlesnictwo);
  assert.equal(corrected?.gmina_source, 'reporter');
  assert.equal(corrected?.proposed_gmina, 'Mońki');
  assert.deepEqual(suggestion, before);
  assert.equal(noticePlaces(undefined, rural.id, rural)?.gmina, 'Bolesławiec');
});
