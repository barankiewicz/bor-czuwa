import manifest from '../../data/authority-directory/manifest.json' with { type: 'json' };
import { apiFetch } from './api-url.js';
import type { IncidentArea } from './report.js';
import type { NoticePlaces } from './notice-composer.js';

export type RecipientKind = 'police' | 'psl' | 'nationalPark' | 'rdos' | 'gmina';
export type RecipientUnit = {
  kind: RecipientKind;
  id: string;
  name: string;
  email: string | null;
  sourceUrl: string | null;
  missingReason?: string;
  /** Gminy only: the locality the office serves, its MSWiA type code, powiat and województwo. */
  place?: string;
  jstType?: 'GW' | 'GMW' | 'GM' | 'MNP';
  powiat?: string;
  voivodeship?: string;
};
export type RecipientLookup = {
  units?: { kind: RecipientKind; id: string }[];
  candidates?: ({ kind: RecipientKind; id: string; name: string; catalog: 'matched' | 'unknown' })[];
  inside?: { nationalPark: boolean; reserve: boolean };
  places?: { gmina: string | null; powiat: string | null; nadlesnictwo: string | null };
  ambiguity?: { ambiguous: boolean; roles: RecipientKind[]; unresolved: RecipientKind[] };
  provenance?: { snapshot_id: string; directory_version: string };
};

export const directoryVersion = manifest.version;

export function preselected(kind: RecipientKind) {
  return kind !== 'gmina';
}

function searchKey(value: string) {
  return value.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLocaleLowerCase('pl').replace(/ł/g, 'l').trim();
}

const searchLimit = 25;
const roleOrder: RecipientKind[] = ['police', 'psl', 'nationalPark', 'rdos', 'gmina'];
export type RecipientCatalog = ReturnType<typeof createRecipientCatalog>;
export type RecipientSuggestion = ReturnType<RecipientCatalog['recipientSuggestions']>;

/** Lookups over the authority directory's units, which the app loads after capture is usable. */
export function createRecipientCatalog(directory: RecipientUnit[]) {
  const byId = new Map(directory.map(unit => [`${unit.kind}:${unit.id}`, unit]));
  const keyed = directory.map(unit => ({ unit, name: searchKey(unit.name), place: unit.place ? searchKey(unit.place) : '' }));

  function unitFor(kind: RecipientKind, id: string) {
    return byId.get(`${kind}:${id}`);
  }

  function candidatesForLookup(lookup: RecipientLookup) {
    return (lookup.candidates ?? []).flatMap(({ kind, id }) => {
      const unit = unitFor(kind, id);
      return unit ? [unit] : [];
    });
  }

  /** Directory units of one kind, exact locality first, then word starts, then loose fragments. */
  function searchUnits(kind: RecipientKind, query: string) {
    const search = searchKey(query);
    if (search.length < 2) return { units: [], total: 0 };
    const startsWord = (text: string) => text.startsWith(search) || text.includes(` ${search}`);
    const ranked = keyed.flatMap(entry => {
      if (entry.unit.kind !== kind) return [];
      const rank = entry.place === search ? 0 : startsWord(entry.place) || startsWord(entry.name) ? 1
        : entry.name.includes(search) || entry.place.includes(search) ? 2 : -1;
      return rank < 0 ? [] : [{ rank, unit: entry.unit }];
    }).sort((a, b) => a.rank - b.rank || a.unit.name.localeCompare(b.unit.name, 'pl'));
    return { units: ranked.slice(0, searchLimit).map(entry => entry.unit), total: ranked.length };
  }

  /**
   * Groups lookup candidates by role. A role with one catalog unit is a proposal, except the gmina,
   * which stays an optional information recipient. Several units in a role are left to the Reporter.
   */
  function recipientSuggestions(lookup: RecipientLookup) {
    const units = candidatesForLookup(lookup);
    const roles = roleOrder.flatMap(kind => {
      const inRole = units.filter(unit => unit.kind === kind);
      // A candidate missing from the catalog still makes its role uncertain.
      const ambiguous = (lookup.candidates ?? []).filter(candidate => candidate.kind === kind).length > 1;
      return inRole.length ? [{ kind, units: inRole, ambiguous }] : [];
    });
    const gminy = units.filter(unit => unit.kind === 'gmina');
    return {
      roles, gminy, places: lookup.places, provenance: lookup.provenance,
      proposed: roles.flatMap(role => !role.ambiguous && preselected(role.kind) ? role.units : []),
      incomplete: !!lookup.ambiguity?.unresolved.length || (lookup.candidates ?? []).some(candidate => candidate.catalog === 'unknown'),
      gminaQuestion: gminy.length > 1
    };
  }

  return { searchUnits, recipientSuggestions };
}

/** Explicit answers override geometry proposals; the catalog snapshot stays on the device. */
export function noticePlaces(suggestion: RecipientSuggestion | undefined, gminaId: string | null | undefined,
  correction?: RecipientUnit): NoticePlaces | undefined {
  if (gminaId === undefined && suggestion?.places) return suggestion.places;
  const gminy = suggestion?.gminy ?? [];
  if (gminaId === undefined && (!gminy.length || suggestion?.gminaQuestion)) return undefined;
  const chosen = gminaId === null ? undefined : correction && correction.id === gminaId ? correction
    : gminaId === undefined && gminy.length === 1 ? gminy[0] : gminy.find(unit => unit.id === gminaId);
  const powiaty = [...new Set((chosen ? [chosen] : gminy).map(unit => unit.powiat))];
  const powiat = powiaty.length === 1 && powiaty[0] ? `powiat ${powiaty[0]}` : null;
  const place: NoticePlaces = { gmina: chosen?.place ?? null, powiat,
    nadlesnictwo: suggestion?.places?.nadlesnictwo ?? null };
  if (gminy.length > 1) place.gminy = gminy.map(unit => unit.place ?? unit.name);
  if (chosen && gminaId !== undefined) place.gmina_source = 'reporter';
  if (correction && chosen === correction) {
    const types = { GW: 'gmina wiejska', GMW: 'gmina miejsko-wiejska', GM: 'gmina miejska', MNP: 'miasto na prawach powiatu' };
    place.gmina_type = chosen.jstType && types[chosen.jstType];
    place.wojewodztwo = chosen.voivodeship;
    place.proposed_gmina = suggestion?.places?.gmina ?? (gminy.length === 1 ? gminy[0].place : undefined);
  }
  return place;
}

export async function lookupRecipients(location: { lat: number; lon: number } | IncidentArea) {
  const response = await apiFetch('/api/recipients', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify('type' in location ? location : { lat: location.lat, lon: location.lon }), signal: AbortSignal.timeout(8000)
  });
  if (!response.ok) throw new Error('recipients_unavailable');
  const lookup = await response.json() as RecipientLookup;
  if (!Array.isArray(lookup.candidates)) throw new Error('invalid_recipients');
  return lookup;
}
