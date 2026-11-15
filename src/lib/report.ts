import { z } from 'zod';
import { eventTypes } from './event-types.js';
import { homeBoundsOnGrid } from './home-area.js';
import { inputLimits } from './input-limits.js';
import { appVersionShape, policyVersionShape, speciesKeyShape } from './version-shapes.js';

const instant = z.iso.datetime({ offset: true });
const latitude = z.number().min(-90).max(90);
const longitude = z.number().min(-180).max(180);
// A key of the Rule set catalogue's shape, or 'unknown'; one the Rule set lacks ends as the designed unknown_species outcome.
const speciesCode = z.string().refine(value => value === 'unknown' || speciesKeyShape.test(value));
const occurredAt = z.strictObject({
  at: instant,
  source: z.enum(['device_clock', 'entered_by_reporter']),
  coarseness: z.enum(['exact', 'within_hours', 'date_only']),
  window_end: instant.optional()
}).superRefine((value, context) => {
  if (value.coarseness === 'exact' && value.window_end) context.addIssue({ code: 'custom', message: 'exact_time_has_no_window' });
  if (value.coarseness === 'within_hours' && (!value.window_end || new Date(value.window_end) <= new Date(value.at) ||
    new Date(value.window_end).getTime() - new Date(value.at).getTime() > 24 * 3_600_000)) {
    context.addIssue({ code: 'custom', message: 'within_hours_needs_later_window_end' });
  }
  if (value.coarseness === 'date_only' && value.window_end) context.addIssue({ code: 'custom', message: 'date_only_has_no_window' });
});

const deviceFix = z.strictObject({
  lat: latitude, lon: longitude, accuracy_m: z.number().nonnegative().max(inputLimits.maxAccuracyM), at: instant
});
const point = z.strictObject({ lat: latitude, lon: longitude, source: z.enum(['device_fix', 'moved_by_reporter']) });
// Metres along each side of an area at its middle latitude.
const sideMetres = ([west, south, east, north]: [number, number, number, number]) =>
  [(east - west) * 111_320 * Math.cos((south + north) / 2 * Math.PI / 180), (north - south) * 111_320];
export const incidentAreaSchema = z.strictObject({
  type: z.literal('area'),
  bounds: z.tuple([longitude, latitude, longitude, latitude]),
  /** How the Reporter estimated it from where they stood: a shot by ear, the other Events by sight. */
  basis: z.enum(['reporter_selected_area', 'estimated_from_hearing', 'estimated_from_sighting']),
  precise_fix_withheld: z.literal('home_privacy').nullable(),
  hearing_bearing_deg: z.number().int().min(0).max(355).multipleOf(5).optional(),
  hearing_distance_m: z.number().int().min(100).max(5000).optional(),
  /** Sent by builds before distances were metres. */
  hearing_distance_band: z.enum(['under_500m', '500m_to_1km', 'over_1km']).optional()
}).refine(value => sideMetres(value.bounds).every(side => side >= 150 && side <= inputLimits.maxAreaSideM))
  // A translated box could track the home even while keeping the grid's size.
  .refine(value => value.precise_fix_withheld !== 'home_privacy' ||
    homeBoundsOnGrid(value.bounds))
  .refine(value => {
    const heard = value.hearing_bearing_deg !== undefined || value.hearing_distance_m !== undefined || !!value.hearing_distance_band;
    if (value.hearing_distance_m !== undefined && value.hearing_distance_band) return false;
    // Direction and distance from home would locate the home, so a home area carries neither.
    if (value.precise_fix_withheld === 'home_privacy') return !heard;
    return value.basis === 'reporter_selected_area' ? !heard : heard;
  });
export const reportSchema = z.strictObject({
  id: z.uuidv4(),
  event_type: z.enum(eventTypes),
  captured_at: instant,
  occurred_at: occurredAt,
  device_fix: deviceFix.nullable(),
  incident_location: z.union([point, incidentAreaSchema]),

  species: z.union([speciesCode, z.null()]),
  photo_sha256: z.array(z.string().regex(/^[a-f0-9]{64}$/)).max(3).optional(),
  has_note: z.boolean(),
  app_version: z.string().refine(appVersionShape),
  privacy_policy_version: z.string().refine(policyVersionShape),
  terms_of_use_version: z.string().refine(policyVersionShape),
  token_sha256: z.string().regex(/^[a-f0-9]{64}$/)
}).refine(report => report.event_type === 'shot' ? report.photo_sha256 === undefined :
  report.event_type === 'remains' ? !!report.photo_sha256?.length : report.photo_sha256 !== undefined).refine(report =>
  'type' in report.incident_location ? report.device_fix === null && {
    reporter_selected_area: true,
    estimated_from_hearing: report.event_type === 'shot',
    // Remains are photographed where the Reporter stands, so they are never placed from afar.
    estimated_from_sighting: report.event_type !== 'shot' && report.event_type !== 'remains'
  }[report.incident_location.basis] :
  report.incident_location.source === 'moved_by_reporter' ? report.device_fix === null :
  report.device_fix !== null && report.device_fix.lat === report.incident_location.lat &&
  report.device_fix.lon === report.incident_location.lon);


export type Report = z.infer<typeof reportSchema>;
export type IncidentArea = z.infer<typeof incidentAreaSchema>;
export type DeviceFix = NonNullable<Report['device_fix']>;
export type Measurement =
  | { status: 'measured'; value_m: number; search_radius_m: number }
  | { status: 'none_within_radius'; value_m: null; search_radius_m: number }
  | { status: 'not_computed'; value_m: null; search_radius_m: null; reason: 'incident_area' | 'outside_coverage' }
  // Shape 2 (ticket 29): nearest distance and the whole area's share within the Rule set's threshold.
  | { status: 'area_measured'; basis: 'area'; min_m: number; within_threshold_share: number; contains_dwelling: boolean;
      class: DwellingAreaClass; threshold_m: number; search_radius_m: number }
  | { status: 'area_none_within_radius'; basis: 'area'; min_m: null; within_threshold_share: 0; contains_dwelling: false;
      class: 'beyond_threshold'; threshold_m: number; search_radius_m: number };
/** Exactly one per area: all farther than the Rule set's threshold, some within it, or a dwelling inside. */
export type DwellingAreaClass = 'beyond_threshold' | 'partly_within_threshold' | 'contains_dwelling';
export type ObwodLowiecki =
  | { status: 'inside'; name: string; number: string; source_year: number; disclaimer: string;
      source_name: string; source_url: string; retrieved_at: string }
  | { status: 'outside'; disclaimer: string; source_name: string; source_url: string; retrieved_at: string }
  | { status: 'area'; obwody: { name: string; number: string; source_year: number; share: number }[];
      outside_share: number; disclaimer: string; source_name: string; source_url: string; retrieved_at: string }
  | { status: 'not_computed'; reason: string };

export type ProtectedAreaKind = 'park_narodowy' | 'rezerwat' | 'otulina' | 'park_krajobrazowy' | 'natura_2000_oso' | 'natura_2000_soo';
export type ProtectedAreaRules = {
  treatment: Record<ProtectedAreaKind, 'ban' | 'ban_without_documents' | 'context'>;
  citation: string;
};
export type ProtectedArea = {
  name: string;
  inspire_id: string;
  boundary_distance?: { status: 'measured'; value_m: number; search_radius_m: null };
  /** Only for an Incident area: the whole area lies inside, or only part of it does (then no boundary_distance). */
  coverage?: 'wholly_inside' | 'partly_inside';
  /** Only for an Incident area: the share of the area, 0 to 1, that lies inside this protected area. */
  area_share?: number;
  parent_kind?: 'park_narodowy' | 'rezerwat';
  document_state?: 'plan_ochrony' | 'zadania_ochronne' | 'neither' | 'not_in_crfop_snapshot';
  documents?: { kind: 'plan_ochrony' | 'zadania_ochronne'; url: string }[];
};
export type ProtectedAreas =
  | { status: 'not_computed'; reason: 'snapshot_without_protected_areas' | 'incident_area' | 'outside_coverage' }
  | { status: 'computed'; rules: ProtectedAreaRules | null; park_narodowy: ProtectedArea[]; rezerwat: ProtectedArea[];
      otulina: ProtectedArea[]; park_krajobrazowy: ProtectedArea[];
      natura_2000_oso: ProtectedArea[]; natura_2000_soo: ProtectedArea[] };

export type Findings = {
  status: 'computed';
  rule_set_id: string;
  geodata_snapshot_id: string;
  snapshot_date: string;
  datasets: { name: string; source_url: string; sha256: string; retrieved_at: string;
    publisher_date?: string; source_files?: { source_url: string; sha256: string }[] }[];
  dwelling_distance: Measurement;
  nearest_ambona?: { status: 'mapped'; distance_m: number; osm_id: string; measured_from?: 'area_edge' } |
    { status: 'none_mapped' } | { status: 'not_computed'; reason?: 'outside_coverage' };
  obwod_lowiecki: ObwodLowiecki;
  accuracy_m: number | null;
  area_bounds?: [number, number, number, number];
  protected_areas?: ProtectedAreas | null;
  noc: import('./time-findings.ts').NocFinding | null;
  okres_ochronny: import('./time-findings.ts').OkresOchronnyFinding | null;
};
export type FindingsResult = Findings | { status: 'pending' } | { status: 'failed'; reason: string };
