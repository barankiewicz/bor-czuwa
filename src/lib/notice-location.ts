import { compassPoint } from './compass.js';
import type { Report } from './report.ts';
import { asksDirection, choosesPoint, defaultPointRadiusM, hearingDistance, outgoingArea, placeOrigin, type AreaDraft } from './home-area.js';

type IncidentArea = Extract<Report['incident_location'], { type: 'area' }>;

const distances = { under_500m: 'do 500 m', '500m_to_1km': 'od 500 m do 1 km', over_1km: 'ponad 1 km' };
type Translate = (text: string) => string;
const polish: Translate = text => text;
const fill = (text: string, values: Record<string, string>) => text.replace(/\{(\w+)\}/g, (_, key: string) => values[key] ?? '');
const metres = (value: number) => value < 1000 ? `${value} m` : `${String(value / 1000).replace('.', ',')} km`;

/** One sentence shared by the review, saved Report and Polish Notice. */
export function incidentLocationSentence(location: Report['incident_location'], eventType: Report['event_type'], t: Translate = polish) {
  if (!('type' in location)) return t(location.source === 'moved_by_reporter'
    ? 'Miejsce wskazano ręcznie; brak dokładności GPS dla tego punktu.'
    : 'Miejsce zapisano na podstawie pozycji telefonu.');
  if (location.precise_fix_withheld === 'home_privacy') return t(eventType === 'shot'
    ? 'Dokładne miejsce, z którego słychać było strzał, pominięto dla ochrony miejsca zamieszkania.'
    : 'Dokładne miejsce pominięto dla ochrony miejsca zamieszkania.');
  return areaBasis(location, eventType, t);
}

function areaBasis(area: IncidentArea, eventType: Report['event_type'], t: Translate) {
  const estimate = [area.hearing_bearing_deg !== undefined &&
    fill(t('kierunek ok. {bearing}° ({direction})'), { bearing: String(area.hearing_bearing_deg), direction: t(compassPoint(area.hearing_bearing_deg)) }),
    area.hearing_distance_m !== undefined && fill(t('odległość ok. {distance}'), { distance: metres(area.hearing_distance_m) }),
    area.hearing_distance_band && fill(t('odległość {distance}'), { distance: t(distances[area.hearing_distance_band]) })].filter(Boolean).join(', ');
  if (area.basis === 'estimated_from_hearing') return estimate
    ? fill(t('Obszar oszacowano ze słuchu ({estimate}).'), { estimate }) : t('Obszar oszacowano ze słuchu.');
  if (area.basis === 'estimated_from_sighting') return estimate
    ? fill(t('Obszar oszacowano z obserwacji ({estimate}).'), { estimate }) : t('Obszar oszacowano z obserwacji.');
  return t(eventType === 'shot' ? 'Obszar wskazano bez oszacowania kierunku i odległości.' : 'Obszar wskazano w przybliżeniu.');
}

/** Coordinates stay in the Notice; this explanation is also safe to show on the Report screen. */
export function incidentAreaDescription(area: IncidentArea, eventType: Report['event_type'], t: Translate = polish) {
  const remainder = area.basis === 'estimated_from_hearing' ? 'Nie jest to pomiar GPS miejsca oddania strzału.'
    : area.basis === 'estimated_from_sighting' ? 'Nie jest to pomiar GPS miejsca zdarzenia.'
      : eventType === 'shot' ? 'Nie znam dokładnego miejsca strzału.' : 'Nie jest to dokładny punkt zdarzenia.';
  const privacy = area.precise_fix_withheld === 'home_privacy' ? incidentLocationSentence(area, eventType, t) : '';
  return [areaBasis(area, eventType, t), t(remainder), privacy].filter(Boolean).join(' ');
}

export function noticeAreaLocation(area: IncidentArea, eventType: Report['event_type']) {
  const [west, south, east, north] = area.bounds;
  const bounds = `Przybliżony obszar zdarzenia: ${south.toFixed(3)}–${north.toFixed(3)}° N, ${west.toFixed(3)}–${east.toFixed(3)}° E.`;
  return `${bounds} ${incidentAreaDescription(area, eventType)}`;
}

/** Draft-only context can include estimates that remain on the phone when reporting from home. */
export function draftPlaceWords(item: AreaDraft, t: Translate = polish, distanceText = metres) {
  const home = item.fromHome;
  if (!placeOrigin(item)) return t('Jeszcze nie wskazano');
  if (choosesPoint(item) && item.manualReference) {
    const reference = item.manualReference;
    const place = fill(t('około {distance} na {direction} od: {place}'), {
      distance: distanceText(reference.distanceM), direction: t(compassPoint(reference.bearing)), place: reference.name
    });
    const uncertainty = item.pointRadiusM === 0 ? t('dokładnie w tym miejscu')
      : fill(t('w promieniu około {distance}'), { distance: distanceText(item.pointRadiusM ?? defaultPointRadiusM) });
    return `${place}; ${uncertainty}`;
  }
  if (choosesPoint(item)) return item.pointRadiusM === 0 ? t('miejsce wskazane na mapie')
    : fill(t('w promieniu około {distance} od wskazanego miejsca'), { distance: distanceText(item.pointRadiusM ?? defaultPointRadiusM) });
  const distance = hearingDistance(item);
  if (!asksDirection(item) || (item.eventType !== 0 && item.hearingBearing === undefined && distance === undefined)) {
    return t(home ? 'u Ciebie w domu lub na podwórku' : 'tam, gdzie jesteś');
  }
  const values = { distance: distance === undefined ? '' : distanceText(distance), direction: item.hearingBearing === undefined ? '' : t(compassPoint(item.hearingBearing)) };
  if (item.hearingBearing !== undefined && distance !== undefined) return fill(t(home ? 'około {distance} na {direction} od domu' : 'około {distance} na {direction} od Ciebie'), values);
  if (item.hearingBearing !== undefined) return fill(t(home ? 'na {direction} od domu, odległość nieznana' : 'na {direction} od Ciebie, odległość nieznana'), values);
  if (distance !== undefined) return fill(t(home ? 'około {distance} od domu, kierunek nieznany' : 'około {distance} od Ciebie, kierunek nieznany'), values);
  return t(home ? 'w okolicy domu' : 'w okolicy, w której jesteś');
}

export function draftLocationSentence(item: AreaDraft, eventType: Report['event_type'], t: Translate = polish) {
  const origin = placeOrigin(item);
  if (!origin) return '';
  return incidentLocationSentence(outgoingArea(item) ?? { ...origin, source: choosesPoint(item) ? 'moved_by_reporter' : 'device_fix' }, eventType, t);
}

export function draftPrivacyLine(item: AreaDraft, t: Translate = polish) {
  if (item.fromHome) return t('Twój dom nie będzie widoczny. W zgłoszeniu zapiszemy tylko okolicę.');
  if (!outgoingArea(item)) return t('W zgłoszeniu zapiszemy to miejsce.');
  return t(item.eventType === 0 && !choosesPoint(item) ? 'W zgłoszeniu zapiszemy przybliżoną okolicę strzału.' : 'W zgłoszeniu zapiszemy tę okolicę.');
}

export function reportPlaceDetail(report: Report, t: Translate = polish) {
  const location = report.incident_location;
  if (!('type' in location)) return location.source === 'moved_by_reporter' ? t('Bez dokładności GPS. Pozycja zapisu pozostaje na urządzeniu.')
    : `${t('Dokładność ')}${Math.round(report.device_fix!.accuracy_m)} m`;
  return t({ estimated_from_hearing: 'Podstawa: oszacowanie ze słuchu.', estimated_from_sighting: 'Podstawa: oszacowanie z obserwacji.',
    reporter_selected_area: 'Podstawa: obszar wybrany przez zgłaszającego.' }[location.basis]);
}

/** An area estimated by ear or by sight away from home, the one place that carries a distance from the Reporter. */
export const estimatedPlace = (location: Report['incident_location']): location is IncidentArea =>
  'type' in location && location.basis !== 'reporter_selected_area' && location.precise_fix_withheld !== 'home_privacy';

/**
 * The saved Report's place as the Report screen says it, never in a Notice. An estimate names its
 * distance as one from the Reporter, so it cannot be read as the distance from homes in the Findings.
 */
export function reportPlaceSentence(location: Report['incident_location'], eventType: Report['event_type'], t: Translate = polish) {
  if (!estimatedPlace(location)) return incidentLocationSentence(location, eventType, t);
  const estimate = [
    location.hearing_distance_m !== undefined && fill(t('ok. {distance} od Ciebie'), { distance: metres(location.hearing_distance_m) }),
    location.hearing_distance_band && fill(t('{distance} od Ciebie'), { distance: t(distances[location.hearing_distance_band]) }),
    location.hearing_bearing_deg !== undefined &&
      fill(t('kierunek ok. {bearing}° ({direction})'), { bearing: String(location.hearing_bearing_deg), direction: t(compassPoint(location.hearing_bearing_deg)) })
  ].filter(Boolean).join(', ');
  if (!estimate) return incidentLocationSentence(location, eventType, t);
  return fill(t(location.basis === 'estimated_from_hearing' ? 'Obszar oszacowano ze słuchu: {estimate}.' : 'Obszar oszacowano z obserwacji: {estimate}.'), { estimate });
}
