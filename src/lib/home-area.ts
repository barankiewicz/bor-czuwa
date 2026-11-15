import type { DeviceFix, IncidentArea, Report } from './report.ts';

export type PlaceReference = { name: string; lat: number; lon: number; bearing: number; distanceM: number };

export type AreaDraft = {
  eventType: number | null; fix?: DeviceFix; fromHome?: boolean;
  occurredMode?: 'now' | 'within_hours' | 'date_only';
  locationMethod?: 'map' | 'reporter';
  hearingBearing?: number; hearingDistanceM?: number;
  /** Drafts saved before distances were metres; read as the offsets the old areas used. */
  hearingDistanceBand?: 'under_500m' | '500m_to_1km' | 'over_1km';
  manualReference?: PlaceReference;
  manualLat?: string; manualLon?: string; pointRadiusM?: number; confirmedArea?: IncidentArea;
};

/** The direction target's distance stops, in metres. */
export const distanceSteps = [100, 200, 300, 500, 750, 1000, 1500, 2000, 3000, 4000, 5000];
/** The radius slider's stops; its first, "dokładnie", keeps the chosen point itself. A placed point's
 * radius still ends at 3 km, where the hearing distance now reaches 5 km. */
export const radiusSteps = [0, 100, 200, 300, 500, 750, 1000, 1500, 2000, 3000];
export const defaultPointRadiusM = 500;
const legacyDistances = { under_500m: 250, '500m_to_1km': 750, over_1km: 2000 };
const metresPerDegree = 111_320;

// The zone edge plus a float-rounding allowance only: a fix built exactly 150 m away can measure 150.00000000000003.
const homeRadiusM = 150 + 1e-6;

function distanceFromHome(point: { lat: number; lon: number }, home: DeviceFix) {
  const lat = (point.lat - home.lat) * 111_000;
  const lon = (point.lon - home.lon) * 111_000 * Math.cos(home.lat * Math.PI / 180);
  return Math.hypot(lat, lon);
}

export function nearHomePoint(point: { lat: number; lon: number }, home: DeviceFix) {
  return distanceFromHome(point, home) <= homeRadiusM;
}

export function manualPoint(value: { manualLat?: string; manualLon?: string }) {
  if (!value.manualLat?.trim() || !value.manualLon?.trim()) return null;
  const lat = Number(value.manualLat);
  const lon = Number(value.manualLon);
  return Number.isFinite(lat) && Number.isFinite(lon) && lat >= -90 && lat <= 90 && lon >= -180 && lon <= 180
    ? { lat, lon } : null;
}

export function homeArea(fix: { lat: number; lon: number }, size: 4 | 8): Extract<Report['incident_location'], { type: 'area' }> {
  // Fixed cells prevent a cell centre from tracking the device fix.
  const latitudeStep = size / 111;
  const longitudeStep = size / 70;
  const south = Math.floor(fix.lat / latitudeStep) * latitudeStep;
  const west = Math.floor(fix.lon / longitudeStep) * longitudeStep;
  const rounded = (value: number) => Number(value.toFixed(6));
  return {
    type: 'area', bounds: [rounded(west), rounded(south), rounded(west + longitudeStep), rounded(south + latitudeStep)],
    basis: 'reporter_selected_area', precise_fix_withheld: 'home_privacy'
  };
}

export function homeBoundsOnGrid(bounds: [number, number, number, number]): boolean {
  const centre = { lat: (bounds[1] + bounds[3]) / 2, lon: (bounds[0] + bounds[2]) / 2 };
  return ([4, 8] as const).some(size => {
    const expected = homeArea(centre, size).bounds;
    return bounds.every((value, index) => value === expected[index]);
  });
}

/** The distance the Reporter heard, in metres, if they gave one. */
export function hearingDistance(draft: AreaDraft) {
  return draft.hearingDistanceM ?? (draft.hearingDistanceBand ? legacyDistances[draft.hearingDistanceBand] : undefined);
}

/** The place is a point on the map: the Event was earlier, there is no fix, or the Reporter chose one. */
export function choosesPoint(draft: AreaDraft) {
  return !draft.fix || (!!draft.occurredMode && draft.occurredMode !== 'now') ||
    (draft.locationMethod ? draft.locationMethod === 'map' : !!manualPoint(draft));
}

/** Gdzie asks for direction and distance: an Event happening now, at a fix, that the Reporter is not standing at. */
export function asksDirection(draft: AreaDraft) {
  return draft.eventType !== null && draft.eventType !== 2 && !choosesPoint(draft);
}

/** Where the Reporter says it happened from: the chosen point, else the recording fix. */
export function placeOrigin(draft: AreaDraft) {
  return choosesPoint(draft) ? manualPoint(draft) : draft.fix ? { lat: draft.fix.lat, lon: draft.fix.lon } : null;
}

/**
 * With a saved home the app decides by distance; an explicit answer always wins. A device fix beyond
 * the home zone whose Accuracy circle reaches into it could come from home, so the answer is left open.
 */
export function resolvedHome(draft: AreaDraft, home?: DeviceFix) {
  if (draft.fromHome !== undefined) return draft.fromHome;
  const origin = placeOrigin(draft);
  if (!home || !origin) return undefined;
  const distance = distanceFromHome(origin, home);
  if (distance <= homeRadiusM) return true;
  if (!choosesPoint(draft) && draft.fix && distance - draft.fix.accuracy_m <= homeRadiusM) return undefined;
  return false;
}

export function withResolvedHome<T extends AreaDraft>(draft: T, home?: DeviceFix): T {
  return { ...draft, fromHome: resolvedHome(draft, home) };
}

export function shiftedBy(point: { lat: number; lon: number }, bearing: number, metres: number) {
  const north = metres * Math.cos(bearing * Math.PI / 180);
  const east = metres * Math.sin(bearing * Math.PI / 180);
  return { lat: point.lat + north / metresPerDegree,
    lon: point.lon + east / (metresPerDegree * Math.cos(point.lat * Math.PI / 180)) };
}

/** The likely place and its uncertainty in metres; 0 means the point itself, sent with full precision. */
export function placeEstimate(draft: AreaDraft) {
  const origin = placeOrigin(draft);
  if (!origin) return null;
  if (choosesPoint(draft)) return { ...origin, radiusM: draft.pointRadiusM ?? defaultPointRadiusM };
  if (!asksDirection(draft)) return { ...origin, radiusM: 0 };
  const distance = hearingDistance(draft);
  if (draft.hearingBearing !== undefined && distance !== undefined) {
    return { ...shiftedBy(origin, draft.hearingBearing, distance), radiusM: Math.max(250, distance / 2) };
  }
  // Without an estimate a shot is still somewhere around; what the Reporter sees stays at the phone's position.
  if (draft.eventType !== 0 && draft.hearingBearing === undefined && distance === undefined) return { ...origin, radiusM: 0 };
  return { ...origin, radiusM: distance ?? 1000 };
}

/** The Incident area this Draft would send, or null when it sends a point or lacks a place. Expects a resolved home. */
export function outgoingArea(draft: AreaDraft): IncidentArea | null {
  const estimate = placeEstimate(draft);
  if (!estimate) return null;
  const estimated = asksDirection(draft) && (draft.hearingBearing !== undefined || hearingDistance(draft) !== undefined);
  const basis = !estimated ? 'reporter_selected_area' : draft.eventType === 0 ? 'estimated_from_hearing' : 'estimated_from_sighting';
  if (draft.fromHome) {
    // From home the direction and distance stay on the phone, or the home could be worked back from them.
    return { ...homeArea(estimate, estimate.radiusM <= 1000 ? 4 : 8), basis };
  }
  if (!estimate.radiusM) return null;
  const latitude = estimate.radiusM / metresPerDegree;
  const longitude = estimate.radiusM / (metresPerDegree * Math.cos(estimate.lat * Math.PI / 180));
  const rounded = (value: number) => Number(value.toFixed(6));
  const distance = hearingDistance(draft);
  return {
    type: 'area',
    bounds: [rounded(estimate.lon - longitude), rounded(estimate.lat - latitude),
      rounded(estimate.lon + longitude), rounded(estimate.lat + latitude)],
    basis, precise_fix_withheld: null,
    ...(estimated && draft.hearingBearing !== undefined ? { hearing_bearing_deg: draft.hearingBearing } : {}),
    ...(estimated && distance !== undefined ? { hearing_distance_m: distance } : {})
  };
}

export function areaConfirmed(draft: AreaDraft) {
  const area = outgoingArea(draft);
  return !!area && JSON.stringify(area) === JSON.stringify(draft.confirmedArea);
}
