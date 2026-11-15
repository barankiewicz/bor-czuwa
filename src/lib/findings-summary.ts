import { distanceBand } from './notice-composer.js';
import type { NoticeRuleSet } from './notice-composer.js';
import { protectedAreaBan } from './findings-reading.js';
import type { Findings, ProtectedArea, ProtectedAreaKind, ProtectedAreas, Report } from './report.js';
import { translate, type Language } from './strings.js';

/** One checked fact on the Report screen: what was measured, its value, and one line of meaning. */
export type Fact = {
  key: 'dwelling' | 'protected' | 'noc' | 'season' | 'obwod' | 'ambona';
  what: string;
  value: string;
  /** The Accuracy beside a point measurement, e.g. "±8 m". */
  margin?: string;
  meaning: string;
  /** Only the two cases ADR-0007 lets the app assert as a ban. */
  ban?: true;
};
export type FindingsSummary = { facts: Fact[]; unchecked: string };

export const isArea = (location: Report['incident_location']) => 'type' in location;
/** The catalogue lookup and its `{name}` filler for one language. */
const words = (language: Language) => {
  const t = (value: string) => translate(language, value);
  return { t, fill: (text: string, values: Record<string, string>) => t(text).replace(/\{(\w+)\}/g, (_, key: string) => values[key] ?? '') };
};
/** Ticket 29's shape: an Incident area measured as a whole. Records computed before it left area facts uncomputed. */
export const measuredOverArea = (findings: Findings) => findings.dwelling_distance.status === 'area_measured'
  || findings.dwelling_distance.status === 'area_none_within_radius' || findings.obwod_lowiecki.status === 'area';

/** Distances as a Reporter reads them: whole metres below a kilometre, then kilometres to one decimal. */
export function distance(metres: number, language: Language) {
  const locale = language === 'en' ? 'en-GB' : 'pl-PL';
  if (metres < 1000) return `${Math.round(metres)} m`;
  return `${new Intl.NumberFormat(locale, { maximumFractionDigits: 1 }).format(Math.round(metres / 100) / 10)} km`;
}
/** An area share: "ok. 30%", "poniżej 1%" for a sliver, never a rounded false "0%" or "100%". */
export function areaShare(share: number, language: Language) {
  const { t, fill } = words(language);
  if (share === 0) return '0%';
  if (share > 0 && share < 0.01) return t('poniżej 1%');
  if (share < 1 && share >= 0.995) return t('ponad 99%');
  return share === 1 ? '100%' : fill('ok. {share}', { share: percent(share, language) });
}

const protectedLabels: Record<ProtectedAreaKind, string> = {
  park_narodowy: 'Park narodowy', rezerwat: 'Rezerwat przyrody', otulina: 'Otulina',
  park_krajobrazowy: 'Park krajobrazowy', natura_2000_oso: 'Natura 2000, obszar ptasi',
  natura_2000_soo: 'Natura 2000, obszar siedliskowy'
};
export const protectedKinds = Object.keys(protectedLabels) as ProtectedAreaKind[];
export const protectedLabel = (kind: ProtectedAreaKind, language: Language) => translate(language, protectedLabels[kind]);

export function summarizeFindings(report: Report, findings: Findings, rule: NoticeRuleSet | undefined, language: Language): FindingsSummary {
  const { t, fill } = words(language);
  const area = isArea(report.incident_location);
  const facts: Fact[] = [];
  const unchecked: [string, string][] = [];
  const skip = (what: string, why: string) => unchecked.push([t(what), t(why)]);
  const outside = findings.dwelling_distance.status === 'not_computed' && findings.dwelling_distance.reason === 'outside_coverage';
  const threshold = 'threshold_m' in findings.dwelling_distance ? findings.dwelling_distance.threshold_m : rule?.dwelling_threshold_m ?? 150;
  const near = String(threshold);

  if (outside) {
    for (const what of ['zabudowania', 'obszary chronione', 'obwód łowiecki', 'ambona']) skip(what, 'miejsce poza zasięgiem danych');
  } else {
    // Zabudowania mieszkalne
    const dwelling = findings.dwelling_distance;
    // Named from where it is measured, so it never reads as the Reporter's own distance in Szczegóły.
    const what = t(area ? 'Od obszaru do zabudowań mieszkalnych' : 'Od miejsca zdarzenia do zabudowań mieszkalnych');
    if (dwelling.status === 'measured') {
      const accuracy = findings.accuracy_m;
      const band = accuracy === null ? null : distanceBand(dwelling.value_m, accuracy, threshold);
      facts.push({ key: 'dwelling', what, value: distance(dwelling.value_m, language),
        margin: accuracy === null ? undefined : `±${Math.round(accuracy)} m`,
        meaning: band === null ? t('Punkt wskazano ręcznie, więc nie wiadomo, jak dokładny jest pomiar.')
          : band === 'inside' ? fill('Bliżej niż {near} m, także z marginesem dokładności.', { near })
          : band === 'outside' ? fill('Dalej niż {near} m, także z marginesem dokładności.', { near })
          : fill('Około {near} m. Przy tej dokładności nie wiadomo, po której stronie progu.', { near }) });
    } else if (dwelling.status === 'area_measured') {
      // Ticket 29's shape: the closest distance, and for an area reaching the threshold the share of it within.
      const share = dwelling.within_threshold_share;
      const closest = fill('Najbliższe zabudowania: {distance}.', { distance: distance(dwelling.min_m, language) });
      if (dwelling.class === 'beyond_threshold') facts.push({ key: 'dwelling', what, value: distance(dwelling.min_m, language),
        meaning: fill('Cały obszar leży dalej niż {near} m od nich.', { near }) });
      else facts.push({ key: 'dwelling', value: areaShare(share, language),
        what: dwelling.class === 'contains_dwelling' ? t('W obszarze są zabudowania mieszkalne')
          : fill(share === 0 ? 'Obszar na granicy {near} m od zabudowań'
            : share === 1 ? 'Cały obszar w zasięgu {near} m od zabudowań' : 'Część obszaru bliżej niż {near} m od zabudowań', { near }),
        meaning: dwelling.class === 'contains_dwelling'
          ? fill(share === 1 ? 'Cały obszar leży w zasięgu {near} m od zabudowań.' : 'Tyle obszaru leży bliżej niż {near} m od zabudowań.', { near })
          : closest });
    } else if (dwelling.status === 'none_within_radius' || dwelling.status === 'area_none_within_radius') {
      const radius = distance(dwelling.search_radius_m, language);
      facts.push({ key: 'dwelling', what, value: fill('ponad {radius}', { radius }),
        meaning: fill('W promieniu {radius} w danych nie ma zabudowań mieszkalnych.', { radius }) });
    } else skip('zabudowania', 'podano obszar, nie punkt');

    // Obszary chronione
    const protectedFact = protectedAreasFact(findings.protected_areas, findings.accuracy_m,
      area ? 'area' : (report.incident_location as { source: 'device_fix' | 'moved_by_reporter' }).source, language);
    if (protectedFact) facts.push(protectedFact);
    else skip('obszary chronione', findings.protected_areas?.status === 'not_computed' && findings.protected_areas.reason === 'incident_area'
      ? 'podano obszar, nie punkt' : 'brak danych w tej wersji');
  }

  // Noc
  const noc = findings.noc;
  if (noc?.status === 'computed') {
    const clock = (at: string) => new Date(at).toLocaleTimeString(language === 'en' ? 'en-GB' : 'pl-PL', { timeZone: 'Europe/Warsaw', hour: '2-digit', minute: '2-digit' });
    const species = noc.at_night && noc.species_huntable_at_night !== null && !(findings.okres_ochronny?.status === 'not_computed' && findings.okres_ochronny.reason === 'species_not_in_rule_set')
      ? ` ${t(noc.species_huntable_at_night ? 'Wskazany gatunek jest na liście polowań w nocy.' : 'Wskazany gatunek nie jest na liście polowań w nocy.')}` : '';
    facts.push({ key: 'noc', what: t('Pora zdarzenia'), value: t(noc.at_night ? 'Noc' : 'Poza nocą'),
      meaning: (noc.spatial_basis === 'incident_area' ? t('W całym wskazanym obszarze.')
        : fill('Wschód słońca {sunrise}, zachód {sunset}.', { sunrise: clock(noc.sunrise), sunset: clock(noc.sunset) })) + species });
  } else skip('noc', !noc ? 'brak wyniku' : noc.reason === 'historical_rules_unavailable' ? 'brak reguł z tego okresu'
    : noc.reason === 'incident_area' ? 'obszar obejmuje i noc, i dzień' : 'zbyt ogólny czas');

  // Okres ochronny
  const season = findings.okres_ochronny;
  const label = report.species && report.species !== 'unknown' ? rule?.species[report.species]?.label : undefined;
  const speciesName = label ? t(label) : t('wskazany gatunek');
  const seasonWhat = label ? fill('Okres ochronny: {species}', { species: speciesName.toLowerCase() }) : t('Okres ochronny');
  if (season?.status === 'in_closed_season') facts.push({ key: 'season', what: seasonWhat, value: t('Tak'), meaning: t('Data zdarzenia przypada w okresie ochronnym.') });
  else if (season?.status === 'outside_closed_season') facts.push({ key: 'season', what: seasonWhat, value: t('Nie'), meaning: t('Data zdarzenia nie przypada w okresie ochronnym.') });
  else if (season?.status === 'no_closed_season_exists') facts.push({ key: 'season', what: seasonWhat, value: t('Brak'), meaning: t('Ten gatunek nie ma okresu ochronnego.') });
  else if (season?.status === 'not_a_game_species') facts.push({ key: 'season', what: seasonWhat, value: t('Nie dotyczy'),
    meaning: fill('Gatunek nie jest zwierzęciem łownym od {date}.', { date: new Date(`${season.delisted_on}T12:00:00Z`).toLocaleDateString(language === 'en' ? 'en-GB' : 'pl-PL', { timeZone: 'Europe/Warsaw' }) }) });
  else skip('okres ochronny', !season ? 'brak wyniku'
    : season.status === 'not_applicable_species_unset' ? 'nie podano gatunku'
    : season.status === 'not_applicable_reporter_unknown' ? 'gatunek nieznany'
    : season.status !== 'not_computed' ? 'brak wyniku'
    : season.reason === 'species_details_required' ? 'potrzeba dokładniejszych danych o zwierzęciu'
    : season.reason === 'historical_rules_unavailable' ? 'brak reguł z tego okresu'
    : season.reason === 'species_not_in_rule_set' ? 'reguły z tego okresu nie obejmują gatunku' : 'zbyt ogólny czas');

  if (!outside) {
    // Obwód łowiecki
    const obwod = findings.obwod_lowiecki;
    const what = t('Obwód łowiecki');
    if (obwod.status === 'inside') facts.push({ key: 'obwod', what, value: fill('nr {number}', { number: obwod.number }),
      meaning: t('Według Banku Danych o Lasach.') });
    else if (obwod.status === 'outside') facts.push({ key: 'obwod', what, value: t('Poza'), meaning: t('Miejsce leży poza obwodami łowieckimi.') });
    else if (obwod.status === 'area') {
      // Per-location vintages can split one district number into disjoint source-year entries.
      const districts = new Map<string, { number: string; share: number }>();
      for (const item of obwod.obwody) {
        const district = districts.get(item.number);
        if (district) district.share += item.share;
        else districts.set(item.number, { number: item.number, share: item.share });
      }
      const list = [...districts.values()].sort((a, b) => b.share - a.share);
      if (!list.length) facts.push({ key: 'obwod', what, value: t('Poza'), meaning: t('Obszar leży poza obwodami łowieckimi.') });
      else if (list.length === 1) facts.push({ key: 'obwod', what, value: fill('nr {number}', { number: list[0].number }),
        meaning: list[0].share === 1 && obwod.outside_share === 0 ? t('Cały obszar leży w tym obwodzie.')
          : fill('W tym obwodzie leży {share} obszaru.', { share: areaShare(list[0].share, language) })
            + (obwod.outside_share > 0 ? ` ${fill('Poza obwodami: {share} obszaru.', { share: areaShare(obwod.outside_share, language) })}` : '') });
      else {
        const count = list.length, lastDigit = count % 10, lastTwo = count % 100;
        facts.push({ key: 'obwod', what,
          value: fill(lastDigit >= 2 && lastDigit <= 4 && (lastTwo < 12 || lastTwo > 14)
            ? '{count} obwody' : '{count} obwodów', { count: String(count) }),
          meaning: [...list.map(item => `${fill('nr {number}', { number: item.number })} (${areaShare(item.share, language)})`),
            ...obwod.outside_share > 0 ? [`${t('poza obwodami')} (${areaShare(obwod.outside_share, language)})`] : []].join(', ') });
      }
    } else skip('obwód łowiecki', area ? 'podano obszar, nie punkt' : 'brak danych');

    // An area distance is 0 for a stand within it, otherwise measured from its edge, never its centre.
    const ambona = findings.nearest_ambona;
    if (ambona?.status === 'mapped' && (!area || ambona.measured_from === 'area_edge')) facts.push({ key: 'ambona', what: t('Do najbliższej ambony'), value: distance(ambona.distance_m, language),
      meaning: t(area ? ambona.distance_m === 0
        ? 'Ambona oznaczona w OpenStreetMap leży we wskazanym obszarze (© współtwórcy, licencja ODbL).'
        : 'Od krawędzi obszaru. Ambona oznaczona w OpenStreetMap (© współtwórcy, licencja ODbL).'
        : 'Ambona oznaczona w OpenStreetMap (© współtwórcy, licencja ODbL).') });
    else if (ambona?.status === 'none_mapped') facts.push({ key: 'ambona', what: t('Do najbliższej ambony'), value: t('Brak'),
      meaning: t('W OpenStreetMap nie ma tu oznaczonej ambony, a jego pokrycie bywa niepełne (© współtwórcy, licencja ODbL).') });
    else if (ambona?.status === 'mapped') skip('ambona', 'podano obszar, nie punkt');
    else if (ambona) skip('ambona', 'brak danych');
  }

  return { facts, unchecked: uncheckedLine(unchecked, language) };
}

/** "Nie sprawdzono: noc (zbyt ogólny czas); okres ochronny (nie podano gatunku)." with shared reasons grouped. */
function uncheckedLine(items: [string, string][], language: Language) {
  if (!items.length) return '';
  const groups = new Map<string, string[]>();
  for (const [what, why] of items) groups.set(why, [...groups.get(why) ?? [], what]);
  const and = language === 'en' ? ' and ' : ' i ';
  const list = (names: string[]) => names.length === 1 ? names[0] : `${names.slice(0, -1).join(', ')}${and}${names.at(-1)}`;
  return `${translate(language, 'Nie sprawdzono:')} ${[...groups].map(([why, names]) => `${list(names)} (${why})`).join('; ')}.`;
}

const percent = (share: number, language: Language) =>
  new Intl.NumberFormat(language === 'en' ? 'en-GB' : 'pl-PL', { style: 'percent', maximumFractionDigits: 0 }).format(share);

function protectedAreasFact(areas: ProtectedAreas | null | undefined, accuracy: number | null,
  source: 'device_fix' | 'moved_by_reporter' | 'area', language: Language): Fact | undefined {
  const { t, fill } = words(language);
  if (!areas || areas.status !== 'computed') return undefined;
  const what = t('Obszary chronione');
  const partly = (area: ProtectedArea) => area.coverage === 'partly_inside';
  for (const kind of ['park_narodowy', 'rezerwat'] as const) {
    for (const area of areas[kind]) {
      if (protectedAreaBan(kind, area, areas.rules, source, accuracy)) return { key: 'protected', what, value: t('Zakaz polowania'), ban: true,
        meaning: source === 'area' ? fill('{name} obejmuje cały obszar.', { name: area.name })
          : area.boundary_distance ? fill('{name}, {distance} od granicy.', { name: area.name, distance: distance(area.boundary_distance.value_m, language) })
          : area.name };
    }
  }
  const strong = [...areas.park_narodowy.map(area => ['park_narodowy', area] as const), ...areas.rezerwat.map(area => ['rezerwat', area] as const)];
  if (strong.length) {
    const [kind, area] = strong[0];
    // Inside by the data, but the boundary lies within the Accuracy: the value says so, not that the place is in the park.
    const margin = source === 'device_fix' && accuracy !== null && area.boundary_distance !== undefined && area.boundary_distance.value_m <= accuracy;
    const value = source === 'area' && partly(area) ? t(kind === 'park_narodowy' ? 'Część w parku narodowym' : 'Część w rezerwacie')
      : margin ? t('Przy granicy') : t(kind === 'park_narodowy' ? 'Park narodowy' : 'Rezerwat');
    const where = source === 'area' ? (partly(area)
      ? area.area_share === undefined ? `${area.name}.` : fill('{name} obejmuje {share} obszaru.', { name: area.name, share: areaShare(area.area_share, language) })
      : fill('{name} obejmuje cały obszar.', { name: area.name }))
      : `${area.name}.`;
    const why = kind === 'rezerwat' && area.document_state === 'not_in_crfop_snapshot' ? t('Rejestr CRFOP go nie obejmuje, więc nie ustalono dokumentów ochronnych.')
      : kind === 'rezerwat' && area.document_state !== 'neither' ? t('Polowanie zależy od dokumentów ochronnych.')
      : source === 'area' ? ''
      : source !== 'device_fix' || accuracy === null ? t('Bez dokładności GPS nie da się potwierdzić położenia względem granicy.')
      : margin ? t('Granica mieści się w marginesie dokładności.') : '';
    return { key: 'protected', what, value, meaning: why ? `${where} ${why}` : where };
  }
  const context = (['otulina', 'park_krajobrazowy', 'natura_2000_oso', 'natura_2000_soo'] as const)
    .flatMap(kind => areas[kind].map(area => ({ kind, area })));
  if (context.length) {
    const first = context[0].kind;
    const names = context.map(({ area }) => `${area.name}${source === 'area' && partly(area) && area.area_share !== undefined ? ` (${fill('{share} obszaru', { share: areaShare(area.area_share, language) })})` : ''}`);
    return { key: 'protected', what, value: first.startsWith('natura') ? 'Natura 2000' : protectedLabel(first, language),
      meaning: `${names.join(', ')}. ${t(context.length > 1 ? 'Te formy ochrony nie zakazują polowania.' : 'Ta forma ochrony nie zakazuje polowania.')}` };
  }
  return { key: 'protected', what, value: t('Brak'), meaning: t('W danych nie ma tu parku narodowego, rezerwatu ani innego obszaru chronionego.') };
}
