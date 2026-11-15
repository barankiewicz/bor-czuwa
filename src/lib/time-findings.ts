export type RuleSet = {
  id: string;
  effective_from: string;
  published_at: string;
  protected_areas?: import('./report.ts').ProtectedAreaRules;
  noc: {
    starts_after_sunset_minutes: number;
    ends_before_sunrise_minutes: number;
    species: string[];
  };
  species: Record<string, {
    label: string;
    closed_seasons: { from: string; to: string }[] | null;
    other_dates_need_details?: boolean;
    common_closed_window?: 'sarna';
    local_exception?: boolean;
    delisted_on?: string;
    delisting_citation?: string;
  }>;
  citations: { okres_ochronny: string; noc: string; delisting?: string };
};

export type OccurrenceTime = {
  at: string;
  coarseness: 'exact' | 'within_hours' | 'date_only';
  window_end?: string;
};

type SolarRange = { earliest: string; latest: string };
type ComputedNoc = { status: 'computed'; at_night: boolean; species_huntable_at_night: boolean | null; citation: string };
export type NocFinding =
  | (ComputedNoc & { spatial_basis?: 'incident_point'; sunrise: string; sunset: string })
  | (ComputedNoc & { spatial_basis: 'incident_area'; sunrise_range: SolarRange; sunset_range: SolarRange })
  | { status: 'not_computed'; reason: 'time_too_coarse' | 'date_only' | 'historical_rules_unavailable' | 'incident_area' | 'sun_unavailable' };

export type OkresOchronnyFinding =
  | { status: 'not_applicable_species_unset' | 'not_applicable_reporter_unknown' | 'no_closed_season_exists' | 'in_closed_season' | 'outside_closed_season'; citation: string }
  | { status: 'not_a_game_species'; delisted_on: string; citation: string }
  | { status: 'not_computed'; reason: 'time_too_coarse' | 'species_details_required' | 'historical_rules_unavailable' | 'species_not_in_rule_set'; citation?: string };

const zone = 'Europe/Warsaw';
const dateFormatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit'
});
const dateTimeFormatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23'
});
const offsetFormatter = new Intl.DateTimeFormat('en-US', { timeZone: zone, timeZoneName: 'longOffset' });

function parts(formatter: Intl.DateTimeFormat, at: Date) {
  return Object.fromEntries(formatter.formatToParts(at)
    .filter(part => part.type !== 'literal')
    .map(part => [part.type, part.value]));
}

export function warsawDate(at: Date) {
  const value = parts(dateFormatter, at);
  return `${value.year}-${value.month}-${value.day}`;
}

export function warsawDateAtNoon(value: string) {
  const offset = parts(offsetFormatter, new Date(`${value}T12:00:00Z`)).timeZoneName.replace('GMT', '');
  return `${value}T12:00:00${offset}`;
}

function localDateTime(at: Date) {
  const value = parts(dateTimeFormatter, at);
  const offset = parts(offsetFormatter, at).timeZoneName.replace('GMT', '');
  return `${value.year}-${value.month}-${value.day}T${value.hour}:${value.minute}:${value.second}${offset}`;
}

function addDays(date: string, days: number) {
  const [year, month, day] = date.split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, day + days)).toISOString().slice(0, 10);
}

function normalize(value: number) { return ((value % 360) + 360) % 360; }
function radians(value: number) { return value * Math.PI / 180; }
function degrees(value: number) { return value * 180 / Math.PI; }

// Williams sunrise equation, evaluated for a Warsaw calendar day rather than UTC's day.
function solarPosition(date: string, lon: number, sunrise: boolean) {
  const [year, month, day] = date.split('-').map(Number);
  const start = Date.UTC(year, 0, 0);
  const ordinal = Math.round((Date.UTC(year, month - 1, day) - start) / 86_400_000);
  const longitudeHour = lon / 15;
  const approximate = ordinal + ((sunrise ? 6 : 18) - longitudeHour) / 24;
  const anomaly = 0.9856 * approximate - 3.289;
  const eclipticLongitude = normalize(anomaly + 1.916 * Math.sin(radians(anomaly)) +
    0.020 * Math.sin(radians(2 * anomaly)) + 282.634);
  let rightAscension = degrees(Math.atan(0.91764 * Math.tan(radians(eclipticLongitude))));
  rightAscension = normalize(rightAscension);
  rightAscension += Math.floor(eclipticLongitude / 90) * 90 - Math.floor(rightAscension / 90) * 90;
  rightAscension /= 15;
  const sinDeclination = 0.39782 * Math.sin(radians(eclipticLongitude));
  const cosDeclination = Math.cos(Math.asin(sinDeclination));
  return { approximate, rightAscension, sinDeclination, cosDeclination, eclipticLongitude };
}

class SunUnavailable extends Error {
  constructor() { super('sun_time_unavailable'); }
}

function sunTime(date: string, lat: number, lon: number, sunrise: boolean) {
  const [year, month, day] = date.split('-').map(Number);
  const longitudeHour = lon / 15;
  const { approximate, rightAscension, sinDeclination, cosDeclination } = solarPosition(date, lon, sunrise);
  const hourAngle = (Math.cos(radians(90.833)) - sinDeclination * Math.sin(radians(lat))) /
    (cosDeclination * Math.cos(radians(lat)));
  if (hourAngle < -1 || hourAngle > 1) throw new SunUnavailable();
  const hour = (sunrise ? 360 - degrees(Math.acos(hourAngle)) : degrees(Math.acos(hourAngle))) / 15;
  const universalHours = (hour + rightAscension - 0.06571 * approximate - 6.622 - longitudeHour + 24) % 24;
  return new Date(Date.UTC(year, month - 1, day) + universalHours * 3_600_000);
}

function sineRange(low: number, high: number): [number, number] {
  const values = [Math.sin(radians(low)), Math.sin(radians(high))];
  for (let peak = Math.ceil((low - 90) / 180) * 180 + 90; peak <= high; peak += 180)
    values.push(Math.sin(radians(peak)));
  return [Math.min(...values), Math.max(...values)];
}

// Interval bounds cover every latitude, including interior extrema near the equinox.
// Longitude changes the approximate day; bound its effect on declination and right ascension too.
function areaSunRange(date: string, bounds: [number, number, number, number], sunrise: boolean): [number, number] | null {
  const [west, south, east, north] = bounds;
  if (south <= -90 || north >= 90) return null;
  const lon = (west + east) / 2;
  const lat = (south + north) / 2;
  const position = solarPosition(date, lon, sunrise);
  const approximateDelta = (east - west) / 720;
  // |dL/d(day)| <= 0.9856 * (1 + 1.916*pi/180 + 0.04*pi/180) < 1.0193.
  const longitudeDelta = 1.0193 * approximateDelta;
  const declination = sineRange(position.eclipticLongitude - longitudeDelta, position.eclipticLongitude + longitudeDelta)
    .map(value => value * 0.39782);
  const latitudeSine = sineRange(south, north);
  const products = declination.flatMap(value => latitudeSine.map(sine => value * sine));
  const numerator = [Math.cos(radians(90.833)) - Math.max(...products), Math.cos(radians(90.833)) - Math.min(...products)];
  const latitudeCosine = sineRange(south + 90, north + 90);
  const declinationSquared = declination.map(value => value ** 2);
  const cosineLow = Math.sqrt(1 - Math.max(...declinationSquared));
  const cosineHigh = declination[0] <= 0 && declination[1] >= 0 ? 1 : Math.sqrt(1 - Math.min(...declinationSquared));
  const denominator = [cosineLow * latitudeCosine[0], cosineHigh * latitudeCosine[1]];
  const ratios = numerator.flatMap(value => denominator.map(divisor => value / divisor));
  const low = Math.min(...ratios), high = Math.max(...ratios);
  if (low <= -1 || high >= 1) return null;
  const hours = [degrees(Math.acos(high)) / 15, degrees(Math.acos(low)) / 15];
  const centerAngle = (Math.cos(radians(90.833)) - position.sinDeclination * Math.sin(radians(lat))) /
    (position.cosDeclination * Math.cos(radians(lat)));
  const centerHours = degrees(Math.acos(centerAngle)) / 15;
  // Right ascension's derivative is at most 1/0.91764; all other terms are linear.
  const uncertainty = longitudeDelta / (0.91764 * 15) + 0.06571 * approximateDelta + (east - west) / 30;
  const center = sunTime(date, lat, lon, sunrise).getTime();
  const range: [number, number] = sunrise
    ? [center + (centerHours - hours[1] - uncertainty) * 3_600_000, center + (centerHours - hours[0] + uncertainty) * 3_600_000]
    : [center + (hours[0] - centerHours - uncertainty) * 3_600_000, center + (hours[1] - centerHours + uncertainty) * 3_600_000];
  const midnight = Date.parse(`${date}T00:00:00Z`);
  // A UTC-date wrap or missing polar sunrise cannot establish one whole-area interval.
  if (range[0] < midnight || range[1] >= midnight + 86_400_000) return null;
  return [Math.floor(range[0]) - 1, Math.ceil(range[1]) + 1];
}

function areaNight(start: Date, end: Date, bounds: [number, number, number, number], rule: RuleSet) {
  const intervals = [];
  for (let offset = -1; offset <= 1; offset++) {
    const date = addDays(warsawDate(start), offset);
    const sunset = areaSunRange(date, bounds, false);
    const sunrise = areaSunRange(addDays(date, 1), bounds, true);
    if (!sunset || !sunrise || sunrise[1] - sunset[0] >= 86_400_000) return null;
    intervals.push({ starts: sunset.map(value => value + rule.noc.starts_after_sunset_minutes * 60_000),
      ends: sunrise.map(value => value - rule.noc.ends_before_sunrise_minutes * 60_000) });
  }
  if (intervals.some(interval => start.getTime() >= interval.starts[1] && end.getTime() < interval.ends[0])) return true;
  if (intervals.every(interval => end.getTime() < interval.starts[0] || start.getTime() >= interval.ends[1])) return false;
  return null;
}

function nightBounds(date: string, lat: number, lon: number, rule: RuleSet) {
  const previousSunset = sunTime(addDays(date, -1), lat, lon, false);
  const sunrise = sunTime(date, lat, lon, true);
  const sunset = sunTime(date, lat, lon, false);
  const nextSunrise = sunTime(addDays(date, 1), lat, lon, true);
  return {
    sunrise,
    sunset,
    starts: [
      new Date(previousSunset.getTime() + rule.noc.starts_after_sunset_minutes * 60_000),
      new Date(sunset.getTime() + rule.noc.starts_after_sunset_minutes * 60_000)
    ],
    ends: [
      new Date(sunrise.getTime() - rule.noc.ends_before_sunrise_minutes * 60_000),
      new Date(nextSunrise.getTime() - rule.noc.ends_before_sunrise_minutes * 60_000)
    ]
  };
}

function atNight(at: Date, lat: number, lon: number, rule: RuleSet) {
  const bounds = nightBounds(warsawDate(at), lat, lon, rule);
  const value = at.getTime();
  return bounds.starts.some((start, index) => value >= start.getTime() && value < bounds.ends[index].getTime());
}

function crossesNightBoundary(start: Date, end: Date, lat: number, lon: number, rule: RuleSet) {
  for (let offset = -1; offset <= 2; offset++) {
    const bounds = nightBounds(addDays(warsawDate(start), offset), lat, lon, rule);
    for (const boundary of [...bounds.starts, ...bounds.ends]) {
      if (start < boundary && boundary <= end) return true;
    }
  }
  return false;
}

function mmdd(date: string) { return date.slice(5); }
function withinSeason(value: string, season: { from: string; to: string }) {
  return season.from <= season.to
    ? value >= season.from && value <= season.to
    : value >= season.from || value <= season.to;
}

function sarnaCommonClosed(year: number) {
  const january15 = new Date(Date.UTC(year, 0, 15)).getUTCDay();
  const firstClosed = january15 === 5 ? 18 : january15 === 6 ? 17 : 16;
  const may11 = new Date(Date.UTC(year, 4, 11)).getUTCDay();
  const lastClosed = may11 === 1 ? 8 : 10;
  return { from: `01-${String(firstClosed).padStart(2, '0')}`, to: `05-${String(lastClosed).padStart(2, '0')}` };
}

function evaluateSeason(time: OccurrenceTime, start: Date, end: Date, species: string | 'unknown' | null, rule: RuleSet): OkresOchronnyFinding {
  const citation = rule.citations.okres_ochronny;
  if (species === null) return { status: 'not_applicable_species_unset', citation };
  if (species === 'unknown') return { status: 'not_applicable_reporter_unknown', citation };
  const speciesRule = species && species !== 'unknown' ? rule.species[species] : undefined;
  const date = warsawDate(start);
  if (speciesRule?.delisted_on) {
    if (date >= speciesRule.delisted_on) return { status: 'not_a_game_species', delisted_on: speciesRule.delisted_on,
      citation: speciesRule.delisting_citation ?? rule.citations.delisting ?? citation };
    return { status: 'not_computed', reason: 'historical_rules_unavailable' };
  }
  // An older Rule set may predate a species the app now offers.
  if (!speciesRule) return { status: 'not_computed', reason: 'species_not_in_rule_set' };
  if (speciesRule.closed_seasons === null && !speciesRule.common_closed_window)
    return { status: 'not_computed', reason: 'species_details_required', citation };
  const seasons = speciesRule.common_closed_window === 'sarna'
    ? [sarnaCommonClosed(Number(date.slice(0, 4)))] : speciesRule.closed_seasons!;
  if (seasons.length === 0) return { status: 'no_closed_season_exists', citation };
  if (seasons.length === 1 && seasons[0].from === '01-01' && seasons[0].to === '12-31')
    return { status: 'in_closed_season', citation };
  const boundaryDate = seasons.some(season => [season.from, season.to].includes(mmdd(date)));
  const endDate = warsawDate(end);
  const crossesSeasonDate = time.coarseness === 'within_hours' && date !== endDate &&
    seasons.some(season => [season.from, season.to].some(boundary =>
      boundary === mmdd(date) || boundary === mmdd(endDate)));
  if ((time.coarseness === 'date_only' && boundaryDate) || crossesSeasonDate)
    return { status: 'not_computed', reason: 'time_too_coarse' };
  if (seasons.some(season => withinSeason(mmdd(date), season)))
    return speciesRule.local_exception
      ? { status: 'not_computed', reason: 'species_details_required', citation }
      : { status: 'in_closed_season', citation };
  if (speciesRule.other_dates_need_details) return { status: 'not_computed', reason: 'species_details_required', citation };
  return { status: 'outside_closed_season', citation };
}

/** Near the poles the sun may not rise or set on the day; that leaves noc unresolved, it is not a failure. */
export function evaluateTimeFindings(time: OccurrenceTime, point: { lat: number; lon: number } | { bounds: [number, number, number, number] }, species: string | 'unknown' | null, rule: RuleSet): { noc: NocFinding; okres_ochronny: OkresOchronnyFinding } {
  try { return evaluate(time, point, species, rule); }
  catch (error) {
    if (!(error instanceof SunUnavailable)) throw error;
    return { noc: { status: 'not_computed', reason: 'sun_unavailable' },
      okres_ochronny: evaluateSeason(time, new Date(time.at), new Date(time.window_end ?? time.at), species, rule) };
  }
}

function evaluate(time: OccurrenceTime, point: { lat: number; lon: number } | { bounds: [number, number, number, number] }, species: string | 'unknown' | null, rule: RuleSet): { noc: NocFinding; okres_ochronny: OkresOchronnyFinding } {
  const start = new Date(time.at);
  const end = time.window_end ? new Date(time.window_end) : start;
  const okres_ochronny = evaluateSeason(time, start, end, species, rule);
  const speciesRule = species && species !== 'unknown' ? rule.species[species] : undefined;

  if (time.coarseness === 'date_only') return { noc: { status: 'not_computed', reason: 'date_only' }, okres_ochronny };
  const common: ComputedNoc = {
    status: 'computed', at_night: false, species_huntable_at_night: speciesRule
      ? (!speciesRule.delisted_on || warsawDate(start) < speciesRule.delisted_on) && rule.noc.species.includes(species!)
      : null, citation: rule.citations.noc
  };
  if ('bounds' in point) {
    const night = areaNight(start, end, point.bounds, rule);
    const sunrise = areaSunRange(warsawDate(start), point.bounds, true);
    const sunset = areaSunRange(warsawDate(start), point.bounds, false);
    if (night === null || !sunrise || !sunset) return { noc: { status: 'not_computed', reason: 'incident_area' }, okres_ochronny };
    const range = ([earliest, latest]: [number, number]) => ({ earliest: localDateTime(new Date(earliest)), latest: localDateTime(new Date(latest)) });
    return { noc: { ...common, at_night: night, spatial_basis: 'incident_area', sunrise_range: range(sunrise), sunset_range: range(sunset) }, okres_ochronny };
  }
  if (time.coarseness === 'within_hours' && crossesNightBoundary(start, end, point.lat, point.lon, rule)) {
    return { noc: { status: 'not_computed', reason: 'time_too_coarse' }, okres_ochronny };
  }
  const bounds = nightBounds(warsawDate(start), point.lat, point.lon, rule);
  const night = atNight(start, point.lat, point.lon, rule);
  return {
    noc: {
      ...common, sunrise: localDateTime(bounds.sunrise), sunset: localDateTime(bounds.sunset), at_night: night
    },
    okres_ochronny
  };
}
