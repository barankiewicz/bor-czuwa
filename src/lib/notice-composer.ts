import type { Findings, FindingsResult, ProtectedArea, Report } from './report.js';
import type { RuleSet } from './time-findings.js';
import { protectedAreaBan, polishDatasetName } from './findings-reading.js';
import { incidentLocationSentence, noticeAreaLocation } from './notice-location.js';
import { noticeFragments } from './notice-fragments.js';
import { handoffNotice } from './demo-handoff.js';

export type NoticeLocal = { report: Report; findings: FindingsResult; photos?: { id: string }[]; note?: string };
export type NoticeRecipient = { kind: 'police' | 'psl' | 'nationalPark' | 'rdos' | 'gmina'; id: string; name: string };
export type NoticePlaces = {
  gmina: string | null; powiat: string | null; nadlesnictwo: string | null;
  /** Every gmina the location touches, present only when there is more than one. */
  gminy?: string[];
  gmina_source?: 'reporter';
  gmina_type?: string;
  wojewodztwo?: string;
  proposed_gmina?: string;
};

export type NoticeVariant = 'signed' | 'unsigned';
export type SignedDetails = { name: string; address: string; phone?: string };
export type NoticeRuleSet = RuleSet & {
  dwelling_threshold_m: number;
  citations: RuleSet['citations'] & { dwelling: string };
};
export type NoticeParts = { subject: string; body: string; templateVersion: string; fragmentIds: string[] };

type Input = {
  local: NoticeLocal;
  recipient: NoticeRecipient;
  others: NoticeRecipient[];
  places?: NoticePlaces;
  variant: NoticeVariant;
  signed?: SignedDetails;
  ruleSet: NoticeRuleSet;
  fragments: typeof noticeFragments;
  platform: 'web' | 'android';
};

export function distanceBand(value: number, accuracy: number, threshold: number): 'inside' | 'straddles' | 'outside' {
  if (value + accuracy < threshold) return 'inside';
  if (value - accuracy <= threshold) return 'straddles';
  return 'outside';
}

function polishTime(at: string) {
  return new Intl.DateTimeFormat('pl-PL', { timeZone: 'Europe/Warsaw', dateStyle: 'long', timeStyle: 'short' }).format(new Date(at));
}
function polishDate(at: string) {
  return new Intl.DateTimeFormat('pl-PL', { timeZone: 'Europe/Warsaw', dateStyle: 'long' }).format(new Date(at));
}
function clock(at: string) {
  return new Intl.DateTimeFormat('pl-PL', { timeZone: 'Europe/Warsaw', hour: '2-digit', minute: '2-digit' }).format(new Date(at));
}
function number(value: number) { return Math.round(value).toString(); }

export function composeNotice(input: Input): NoticeParts {
  const { local, recipient, others, places, variant, signed, ruleSet, fragments, platform } = input;
  if (variant === 'signed' && (!signed?.name.trim() || !signed.address.trim())) throw new Error('signed_details_required');
  const { report, findings } = local;
  const skeleton = fragments.skeletons[recipient.kind][variant];
  const ids: string[] = [skeleton.id, fragments.events[report.event_type].id];
  const lines = [`Szanowni Państwo,`, skeleton.opening];
  const event = fragments.events[report.event_type].text;
  const species = report.species && report.species !== 'unknown' ? ruleSet.species[report.species]?.label : undefined;
  lines.push(species ? `${event} Wskazany gatunek: ${species}.` : event);
  const time = report.occurred_at;
  if (time.coarseness === 'date_only') {
    lines.push(`Data zdarzenia: ${polishDate(time.at)}. Godzina nieustalona.`); ids.push('D5');
  } else if (time.coarseness === 'within_hours' && time.window_end) {
    lines.push(`Zdarzenie między ${polishTime(time.at)} a ${clock(time.window_end)}. Czas przybliżony.`); ids.push('D4');
  } else lines.push(`Czas zdarzenia: ${polishTime(time.at)}.`);
  const location = report.incident_location;
  if ('type' in location) {
    lines.push(noticeAreaLocation(location, report.event_type)); ids.push('D10');
  } else {
    const lat = location.lat.toFixed(5), lon = location.lon.toFixed(5);
    lines.push(`Miejsce wskazane: ${lat}° N, ${lon}° E (WGS84). Mapa: https://mapy.geoportal.gov.pl/?marker=${lat},${lon}.`);
    lines.push(incidentLocationSentence(location, report.event_type));
    if (location.source === 'moved_by_reporter') ids.push('D3');
    ids.push('D10');
  }
  if (places) lines.push(placesLine(places, 'type' in location));
  if (findings.status !== 'computed') {
    lines.push(findings.status === 'pending' ? 'Ustalenia nie są jeszcze dostępne; pomiary zostaną obliczone po synchronizacji.' : 'Nie udało się obliczyć ustaleń.');
    ids.push('D2');
  } else {
    const findingParts = composeFindings(findings, ruleSet, 'type' in location ? false : location.source === 'device_fix');
    lines.push(...findingParts.lines); ids.push(...findingParts.ids);
  }
  lines.push(findings.status === 'computed'
    ? `Źródła danych: ${findings.datasets.map(dataset => polishDatasetName(dataset.name)).join(', ') || 'brak danych źródłowych'}. Data migawki: ${findings.snapshot_date.slice(0, 10)}.`
    : `Źródła danych i data migawki: niedostępne przed obliczeniem ustaleń.`);
  ids.push('D9');
  if (local.photos?.length) {
    const photos = `${local.photos.length} ${local.photos.length === 1 ? 'zdjęcie' : 'zdjęcia'}`;
    lines.push(platform === 'android' ? `W załączeniu ${photos}.` : `Mam ${photos} i mogę je przekazać na prośbę.`);
    ids.push(platform === 'android' ? 'D6' : 'D7');
  }
  if (local.note?.trim()) { lines.push(`Notatka zgłaszającego (cytat): „${local.note}”`); ids.push('D8'); }
  if (others.length) lines.push(`Pozostali adresaci tego powiadomienia: ${others.map(unit => unit.name).join(', ')}.`);
  lines.push(skeleton.closing);
  if (variant === 'signed' && signed) lines.push(`${signed.name.trim()}\nAdres do korespondencji: ${signed.address.trim()}${signed.phone?.trim() ? `\nTelefon: ${signed.phone.trim()}` : ''}`);
  return handoffNotice({ subject: skeleton.subject, body: lines.join('\n\n'), templateVersion: fragments.version, fragmentIds: ids });
}

function placesLine(places: NoticePlaces, isArea: boolean) {
  let gmina = places.gmina ?? 'nie ustalono';
  if (places.gminy) {
    const span = `${isArea ? 'obszar zdarzenia obejmuje gminy' : 'miejsce zdarzenia leży na granicy gmin'}: ${places.gminy.join(', ')}`;
    gmina = places.gmina_source === 'reporter' && places.gmina
      ? `${places.gmina}, wskazana przez zgłaszającego (${span})` : `nie ustalono (${span})`;
  }
  if (places.gmina_type) gmina += ` (${places.gmina_type})`;
  const correction = places.gmina_type ? ` Województwo: ${places.wojewodztwo ?? 'nie ustalono'}. Gminę wskazał zgłaszający.${places.proposed_gmina ? ` Podpowiedź według zapisanego miejsca: ${places.proposed_gmina}.` : ''} Wskazanie gminy nie zmienia zapisanego miejsca zdarzenia ani pomiarów. Właściwość adresata wymaga sprawdzenia.` : '';
  return `Gmina: ${gmina}. Powiat: ${places.powiat ?? 'nie ustalono'}. Nadleśnictwo: ${places.nadlesnictwo ?? 'nie ustalono'}.${correction}`;
}

const percent = (share: number, partial = false) => share > 0 && share < 0.01 ? 'poniżej 1%'
  : (share < 1 || partial) && share >= 0.995 ? 'ponad 99%' : `${Math.round(share * 100)}%`;

/** What the Notice says about the dwellings, obwody and protected areas of an Incident area, as measurements. */
function composeAreaFindings(findings: Findings, rule: NoticeRuleSet, add: (id: string, line: string) => void) {
  let measured = false;
  const dwelling = findings.dwelling_distance;
  const approximate = (share: number) => share > 0 && share < 0.01 ? 'poniżej 1%'
    : share < 1 && share >= 0.995 ? 'ponad 99%' : share >= 1 ? '100%' : `ok. ${Math.round(share * 100)}%`;
  if (dwelling.status === 'area_none_within_radius') {
    add('A1', `Wskazany obszar leży w całości dalej niż ${dwelling.threshold_m} m od zabudowań mieszkalnych. W danych nie ma zabudowań mieszkalnych w promieniu ${dwelling.search_radius_m} m od obszaru.`);
  } else if (dwelling.status === 'area_measured') {
    measured = true;
    const nearest = `Najbliższe zabudowania są oddalone o ${number(dwelling.min_m)} m.`;
    if (dwelling.class === 'beyond_threshold') add('A1', `Wskazany obszar leży w całości dalej niż ${dwelling.threshold_m} m od zabudowań mieszkalnych. ${nearest}`);
    else if (dwelling.class === 'partly_within_threshold') {
      if (dwelling.within_threshold_share === 0) add('A2', `${nearest} Obszar styka się z granicą strefy ${dwelling.threshold_m} m od zabudowań mieszkalnych. ${rule.citations.dwelling}`);
      else if (dwelling.within_threshold_share >= 1) add('A2', `Cały wskazany obszar leży w odległości do ${dwelling.threshold_m} m od zabudowań mieszkalnych. ${nearest} ${rule.citations.dwelling}`);
      else add('A2', `Część wskazanego obszaru (${approximate(dwelling.within_threshold_share)}) leży bliżej niż ${dwelling.threshold_m} m od zabudowań mieszkalnych. ${nearest} ${rule.citations.dwelling}`);
    }
    else add('A3', `W obszarze znajdują się zabudowania mieszkalne. Bliżej niż ${dwelling.threshold_m} m od zabudowań leży ${approximate(dwelling.within_threshold_share)} obszaru. ${rule.citations.dwelling}`);
  }
  const areas = findings.protected_areas;
  if (areas?.status === 'computed') {
    const where = (item: ProtectedArea, locative: string) => item.coverage === 'wholly_inside'
      ? `Wskazany obszar leży w całości w ${locative} ${item.name}` : `Część wskazanego obszaru (${percent(item.area_share ?? 0, true)}) leży w ${locative} ${item.name}`;
    const margin = (item: ProtectedArea) => item.coverage === 'wholly_inside' && item.boundary_distance ? `, ${number(item.boundary_distance.value_m)} m od granicy` : '';
    for (const park of areas.park_narodowy.filter(item => item.coverage)) {
      if (park.coverage === 'wholly_inside') measured = true;
      const ban = protectedAreaBan('park_narodowy', park, areas.rules, 'area', null);
      add(ban ? 'A4' : 'A5', `${where(park, 'parku narodowym')}${margin(park)}${ban ? `; polowanie jest tam zakazane. ${areas.rules!.citation}` : '.'}`);
    }
    for (const reserve of areas.rezerwat.filter(item => item.coverage)) {
      if (reserve.coverage === 'wholly_inside') measured = true;
      const prefix = `${where(reserve, 'rezerwacie')}${margin(reserve)}`;
      if (reserve.document_state === 'neither') {
        const ban = protectedAreaBan('rezerwat', reserve, areas.rules, 'area', null);
        add(ban ? 'A6' : 'A7', `${prefix}. Rezerwat nie ma planu ochrony ani zadań ochronnych${ban ? `; polowanie jest tam zakazane. ${areas.rules!.citation}` : '.'}`);
      } else if (reserve.document_state === 'plan_ochrony' || reserve.document_state === 'zadania_ochronne') {
        const document = reserve.documents?.find(item => item.kind === reserve.document_state);
        add('A8', `${prefix}. Dokument ochronny: ${reserve.document_state.replace('_', ' ')}${document ? ` (${document.url})` : ''}.`);
      } else if (reserve.document_state === 'not_in_crfop_snapshot') {
        add('A9', `${prefix}; brak rezerwatu w dostępnej migawce Centralnego Rejestru Form Ochrony Przyrody. Dokumentów ochronnych nie ustalono.`);
      }
    }
    for (const buffer of areas.otulina.filter(item => item.coverage)) add('A10', `${where(buffer, 'otulinie:')}.`);
  }
  if (measured) add('A11', 'Pomiar liczony od całego wskazanego obszaru, nie od jednego punktu.');
  const obwod = findings.obwod_lowiecki;
  if (obwod.status === 'area') {
    const counts = new Map<string, number>();
    for (const item of obwod.obwody) counts.set(item.number, (counts.get(item.number) ?? 0) + 1);
    if (!obwod.obwody.length) add('A12', `Wskazany obszar leży poza obwodami łowieckimi. ${obwod.disclaimer}`);
    else add('A13', `Wskazany obszar obejmuje obwody łowieckie: ${obwod.obwody.map(item => `nr ${item.number} (${counts.get(item.number)! > 1 ? `dane z ${item.source_year} r.; ` : ''}${percent(item.share)})`).join(', ')}.${obwod.outside_share > 0 ? ` Poza obwodami łowieckimi leży ${percent(obwod.outside_share)} obszaru.` : ''} ${obwod.disclaimer}`);
  }
}

function composeFindings(findings: Findings, rule: NoticeRuleSet, hasGpsPoint: boolean) {
  const lines: string[] = [], ids: string[] = [];
  let includesDistance = false;
  const add = (id: string, line: string) => { ids.push(id); lines.push(line); };
  composeAreaFindings(findings, rule, add);
  const dwellingDistance = findings.dwelling_distance;
  if (dwellingDistance.status === 'measured' && findings.accuracy_m !== null && hasGpsPoint) {
    const band = distanceBand(dwellingDistance.value_m, findings.accuracy_m, rule.dwelling_threshold_m);
    if (band !== 'outside') {
      includesDistance = true;
      add(band === 'inside' ? 'C1' : 'C2', `Odległość od najbliższych zabudowań mieszkalnych: ${number(dwellingDistance.value_m)} m; dokładność punktu ±${number(findings.accuracy_m)} m; próg ${rule.dwelling_threshold_m} m. ${rule.citations.dwelling}`);
    }
  } else if (dwellingDistance.status === 'measured' && dwellingDistance.value_m < rule.dwelling_threshold_m) {
    includesDistance = true;
    add('C2', `Odległość od najbliższych zabudowań mieszkalnych: ${number(dwellingDistance.value_m)} m; próg ${rule.dwelling_threshold_m} m. Brak dokładności GPS dla punktu; porównanie z progiem jest niepewne. ${rule.citations.dwelling}`);
  }
  const areas = findings.protected_areas;
  if (areas?.status === 'computed') {
    for (const park of areas.park_narodowy.filter(item => !item.coverage)) {
      const distance = park.boundary_distance?.value_m;
      if (distance !== undefined) includesDistance = true;
      const clear = distance !== undefined && findings.accuracy_m !== null && hasGpsPoint && distance > findings.accuracy_m;
      const ban = protectedAreaBan('park_narodowy', park, areas.rules, hasGpsPoint ? 'device_fix' : 'area', findings.accuracy_m);
      add(ban ? 'C3' : 'C4', ban
        ? `Punkt leży w parku narodowym ${park.name}, ${number(distance!)} m od granicy; polowanie jest tam zakazane. ${areas.rules!.citation}`
        : `Punkt wskazano w parku narodowym ${park.name}${distance === undefined ? '' : `, ${number(distance)} m od granicy`}. ${distance === undefined ? 'Odległości od granicy nie obliczono.' : !hasGpsPoint || findings.accuracy_m === null ? 'Brak dokładności GPS dla tego punktu; położenia względem granicy nie można potwierdzić.' : !clear ? `Dokładność ±${number(findings.accuracy_m)} m obejmuje granicę.` : 'Brak potwierdzonej reguły do stwierdzenia zakazu.'}`);
    }
    for (const reserve of areas.rezerwat.filter(item => !item.coverage)) {
      const distance = reserve.boundary_distance?.value_m;
      if (reserve.document_state === 'neither') {
        if (distance !== undefined) includesDistance = true;
        const clear = distance !== undefined && findings.accuracy_m !== null && hasGpsPoint && distance > findings.accuracy_m;
        const ban = protectedAreaBan('rezerwat', reserve, areas.rules, hasGpsPoint ? 'device_fix' : 'area', findings.accuracy_m);
        add(ban ? 'C5' : 'C6', ban
          ? `Punkt leży w rezerwacie ${reserve.name}, ${number(distance!)} m od granicy. Rezerwat nie ma planu ochrony ani zadań ochronnych; polowanie jest tam zakazane. ${areas.rules!.citation}`
          : `Punkt wskazano w rezerwacie ${reserve.name}${distance === undefined ? '' : `, ${number(distance)} m od granicy`}. ${distance === undefined ? 'Odległości od granicy nie obliczono.' : !hasGpsPoint || findings.accuracy_m === null ? 'Brak dokładności GPS dla tego punktu; położenia względem granicy nie można potwierdzić.' : !clear ? `Dokładność ±${number(findings.accuracy_m)} m obejmuje granicę.` : 'Brak potwierdzonej reguły do stwierdzenia zakazu.'}`);
      } else if (reserve.document_state === 'plan_ochrony' || reserve.document_state === 'zadania_ochronne') {
        const document = reserve.documents?.find(item => item.kind === reserve.document_state);
        add('C7', `Punkt wskazano w rezerwacie ${reserve.name}. Dokument ochronny: ${reserve.document_state.replace('_', ' ')}${document ? ` (${document.url})` : ''}.`);
      } else if (reserve.document_state === 'not_in_crfop_snapshot') {
        add('C8', `Punkt wskazano w rezerwacie ${reserve.name}; brak rezerwatu w dostępnej migawce Centralnego Rejestru Form Ochrony Przyrody. Dokumentów ochronnych nie ustalono.`);
      }
    }
    for (const buffer of areas.otulina.filter(item => !item.coverage)) add('C9', `Punkt wskazano w otulinie: ${buffer.name}.`);
  }
  if (includesDistance) add('D1', 'Pomiar liczony od punktu wskazanego przez zgłaszającego.');
  const obwod = findings.obwod_lowiecki;
  if (obwod.status === 'inside') add('C10', `${obwod.name}, nr ${obwod.number}. ${obwod.disclaimer}`);
  if (obwod.status === 'outside') add('C11', `Punkt wskazano poza obwodami łowieckimi. ${obwod.disclaimer}`);
  const noc = findings.noc;
  if (noc?.status === 'computed' && noc.at_night) {
    const nightPlace = noc.spatial_basis === 'incident_area' ? ' w całym wskazanym obszarze' : '';
    const solarTimes = noc.spatial_basis === 'incident_area' ? '' : ` (zachód ${clock(noc.sunset)}, wschód ${clock(noc.sunrise)})`;
    if (noc.species_huntable_at_night === false) add('C12', `Zdarzenie przypada w porze nocnej${nightPlace}${solarTimes}; wskazanego gatunku nie ma na liście gatunków dopuszczonych do polowania w nocy. ${rule.citations.noc}`);
    if (noc.species_huntable_at_night === null) add('C13', `Zdarzenie przypada w porze nocnej${nightPlace}; gatunku nie ustalono. ${rule.citations.noc}`);
  }
  const season = findings.okres_ochronny;
  if (season?.status === 'in_closed_season') add('C14', `Data przypada w okresie ochronnym wskazanego gatunku. ${rule.citations.okres_ochronny}`);
  if (season?.status === 'not_a_game_species') add('C15', `Wskazany gatunek nie jest zwierzęciem łownym od ${season.delisted_on}. ${rule.citations.delisting ?? rule.citations.okres_ochronny}`);
  return { lines, ids };
}
