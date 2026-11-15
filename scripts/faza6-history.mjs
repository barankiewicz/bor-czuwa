import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { tsImport } from 'tsx/esm/api';

// Disposable source-derived fixture setup only; the parent owns the running API and worker.
const generatorVersion = 'faza6-history-1.2.1';
const day = 86_400_000;
const eventTypes = ['shot', 'person_with_gun', 'remains', 'injured_animal', 'poaching'];
const profileIds = new Set(['H00', 'H05', 'H25', 'H50', 'H250', 'H1000', 'HB250']);
const internals = new WeakMap();
let contractsPromise;
const hash = value => createHash('sha256').update(value).digest('hex');
function canonical(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (value instanceof Date) return JSON.stringify(value.toISOString());
  if (Array.isArray(value)) return `[${value.map(item => canonical(item) ?? 'null').join(',')}]`;
  return `{${Object.keys(value).filter(key => value[key] !== undefined).sort()
    .map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
}
const contentHash = value => hash(canonical(value));
const iso = value => new Date(value).toISOString();
function uuid(namespace, label) {
  const bytes = Buffer.from(hash(`${generatorVersion}\0${namespace}\0${label}`).slice(0, 32), 'hex');
  bytes[6] = (bytes[6] & 15) | 64;
  // Runner's active UUIDs reserve 8xxx; bxxx remains a valid UUID variant and is disjoint.
  bytes[8] = (bytes[8] & 15) | 176;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
function contracts() {
  contractsPromise ??= Promise.all([
    tsImport('../src/lib/report.ts', import.meta.url),
    tsImport('../src/lib/notice-event.ts', import.meta.url),
    tsImport('../src/lib/time-findings.ts', import.meta.url),
    tsImport('../src/lib/notice-fragments.ts', import.meta.url),
    tsImport('../src/lib/home-area.ts', import.meta.url)
  ]).then(([report, notice, time, fragments, area]) => ({ ...report, ...notice, ...time, ...fragments, ...area }));
  return contractsPromise;
}
function stateFor(bundle) {
  const state = internals.get(bundle);
  assert(state, 'History bundle must come from buildHistory in this process');
  return state;
}
function validateProfile(profile) {
  assert(profile && profileIds.has(profile.id), 'Unknown versioned history profile');
  for (const key of ['report_count', 'draft_count', 'queued_report_count', 'synced_report_count',
    'withdrawal_count', 'notice_count', 'notices_with_outcomes']) {
    assert(Number.isSafeInteger(profile[key]) && profile[key] >= 0, `Invalid profile count: ${key}`);
  }
  assert.equal(typeof profile.first_launch_seen, 'boolean');
  assert.equal(profile.report_count, profile.queued_report_count + profile.synced_report_count,
    'Queued/synced Reports must partition the profile');
  const counts = profile.synced_findings;
  assert(counts && Object.keys(counts).sort().join(',') === 'computed,failed,outside_coverage,pending');
  assert(Object.values(counts).every(value => Number.isSafeInteger(value) && value >= 0));
  assert.equal(Object.values(counts).reduce((sum, value) => sum + value, 0), profile.synced_report_count,
    'Findings must partition synced Reports');
  assert(profile.notices_with_outcomes <= profile.notice_count);
  assert(profile.notice_count <= profile.synced_report_count * 2,
    'Fixture allocates at most two distinct recipients per synced Report');
  assert.equal(profile.id === 'H00', profile.report_count === 0);
  if (profile.id === 'H00') for (const key of ['draft_count', 'withdrawal_count', 'notice_count']) {
    assert.equal(profile[key], 0, 'H00 must contain no historical entities');
  }
}

// A baseline, single-component JPEG: every 8x8 block has DC=0 and EOB, hence uniform grey.
// No metadata, real-world subject, external codec, or browser-specific encoding enters its hash.
function syntheticJpeg(width, height) {
  assert(Number.isInteger(width) && width > 0 && width <= 2048);
  assert(Number.isInteger(height) && height > 0 && height <= 2048);
  const segment = (marker, payload) => Buffer.from([255, marker, (payload.length + 2) >> 8,
    (payload.length + 2) & 255, ...payload]);
  const table = kind => [kind, 1, ...Array(15).fill(0), 0];
  const blocks = Math.ceil(width / 8) * Math.ceil(height / 8);
  const entropy = Buffer.alloc(Math.ceil(blocks * 2 / 8));
  const usedBits = blocks * 2 % 8;
  if (usedBits) entropy[entropy.length - 1] = (1 << (8 - usedBits)) - 1;
  return Buffer.concat([Buffer.from([255, 216]), segment(219, [0, ...Array(64).fill(1)]),
    segment(192, [8, height >> 8, height & 255, width >> 8, width & 255, 1, 1, 17, 0]),
    segment(196, [...table(0), ...table(16)]), segment(218, [1, 1, 0, 0, 63, 0]),
    entropy, Buffer.from([255, 217])]);
}
function serverReport(report, receivedAt) {
  const location = report.incident_location;
  const area = location.type === 'area' ? location : null;
  return {
    // Mirror report-domain's area representation; the centroid is not the reporter fix.
    id: report.id, token_sha256: report.token_sha256, event_type: report.event_type,
    captured_at: report.captured_at, occurred_at: report.occurred_at.at,
    occurred_source: report.occurred_at.source, occurred_coarseness: report.occurred_at.coarseness,
    occurred_window_end: report.occurred_at.window_end ?? null,
    device_lat: report.device_fix?.lat ?? null, device_lon: report.device_fix?.lon ?? null,
    accuracy_m: report.device_fix?.accuracy_m ?? null, device_fix_at: report.device_fix?.at ?? null,
    incident_lat: area ? (area.bounds[1] + area.bounds[3]) / 2 : location.lat,
    incident_lon: area ? (area.bounds[0] + area.bounds[2]) / 2 : location.lon,
    incident_source: area ? 'area' : location.source,
    incident_bounds: area?.bounds ?? null, area_basis: area?.basis ?? null,
    precise_fix_withheld: area?.precise_fix_withheld ?? null,
    hearing_bearing_deg: area?.hearing_bearing_deg ?? null,
    hearing_distance_band: area?.hearing_distance_band ?? null,
    hearing_distance_m: area?.hearing_distance_m ?? null,
    has_note: report.has_note, app_version: report.app_version,
    privacy_policy_version: report.privacy_policy_version, terms_of_use_version: report.terms_of_use_version,
    species: report.species, photo_sha256: report.photo_sha256 ?? null, received_at: receivedAt,
    publishable: true
  };
}
function eventRow(reportId, event) {
  const { id, kind, at, synced, refused, ...details } = event;
  return { report_id: reportId, kind, at, details, event_id: id ?? null };
}
function findingClass(local) {
  if (local.findings.status !== 'computed') return local.findings.status;
  return local.findings.dwelling_distance.reason === 'outside_coverage' ? 'outside_coverage' : 'computed';
}
const reportGeometryColumns = ['device_lat', 'device_lon', 'accuracy_m', 'device_fix_at',
  'incident_lat', 'incident_lon', 'incident_source', 'incident_bounds', 'area_basis',
  'precise_fix_withheld', 'hearing_bearing_deg', 'hearing_distance_band', 'hearing_distance_m'];
const findingsGeometryColumns = ['accuracy_m', 'area_bounds', 'dwelling_distance', 'obwod_lowiecki',
  'nearest_ambona', 'protected_areas', 'noc', 'okres_ochronny'];
function assertGeometry(actual, expected, columns) {
  for (const column of columns) {
    const normal = value => column === 'device_fix_at' && value !== null ? iso(value) : value;
    assert.deepEqual(normal(actual[column]), normal(expected[column]), `History geometry mismatch: ${column}`);
  }
}
function assertCurrentSpatial(result, isArea, datasets) {
  const spatialFields = ['dwelling_distance', 'obwod_lowiecki', 'nearest_ambona', 'protected_areas'];
  if (result.dwelling_distance.reason === 'outside_coverage') {
    assert.deepEqual(result.dwelling_distance,
      { status: 'not_computed', value_m: null, search_radius_m: null, reason: 'outside_coverage' });
    for (const field of spatialFields.slice(1)) assert.deepEqual(result[field],
      { status: 'not_computed', reason: 'outside_coverage' },
      'Outside coverage must withhold every spatial Finding');
    return;
  }
  for (const field of spatialFields) assert.notEqual(result[field]?.reason, 'incident_area',
    'New source-derived Findings cannot use the legacy area skip');
  if (!isArea) return;
  const share = value => assert(Number.isFinite(value) && value >= 0 && value <= 1,
    'Area shares must be finite fractions in [0, 1]');
  const dwelling = result.dwelling_distance;
  assert(['area_measured', 'area_none_within_radius'].includes(dwelling.status));
  assert.equal(dwelling.basis, 'area');
  assert(!('max_m' in dwelling), 'Current area Findings do not expose a farthest distance');
  assert(Number.isFinite(dwelling.threshold_m) && dwelling.threshold_m > 0);
  assert.equal(dwelling.search_radius_m, 1000);
  share(dwelling.within_threshold_share);
  assert.equal(typeof dwelling.contains_dwelling, 'boolean');
  assert(['beyond_threshold', 'partly_within_threshold', 'contains_dwelling'].includes(dwelling.class));
  assert.equal(dwelling.class === 'contains_dwelling', dwelling.contains_dwelling);
  if (dwelling.status === 'area_measured') assert(Number.isFinite(dwelling.min_m) && dwelling.min_m >= 0);
  else {
    assert.equal(dwelling.min_m, null);
    assert.equal(dwelling.within_threshold_share, 0);
    assert.equal(dwelling.contains_dwelling, false);
    assert.equal(dwelling.class, 'beyond_threshold');
  }
  const hunting = result.obwod_lowiecki;
  if (datasets.some(dataset => dataset.name === 'Bank Danych o Lasach')) {
    assert.equal(hunting.status, 'area');
    share(hunting.outside_share);
    assert(Array.isArray(hunting.obwody));
    const districts = new Set();
    for (const district of hunting.obwody) {
      share(district.share);
      assert(district.share > 0);
      const key = `${district.source_year}:${district.number}`;
      assert(!districts.has(key), 'One area district entry per number/source year');
      districts.add(key);
    }
  } else assert.deepEqual(hunting, { status: 'not_computed', reason: 'snapshot_without_bdl' });
  if (result.nearest_ambona.status === 'mapped') {
    assert.equal(result.nearest_ambona.measured_from, 'area_edge');
    assert(Number.isFinite(result.nearest_ambona.distance_m) && result.nearest_ambona.distance_m >= 0);
  }
  if (result.protected_areas.status === 'computed') {
    for (const kind of ['park_narodowy', 'rezerwat', 'otulina', 'park_krajobrazowy', 'natura_2000_oso', 'natura_2000_soo']) {
      assert(Array.isArray(result.protected_areas[kind]));
      for (const area of result.protected_areas[kind]) {
        assert(['wholly_inside', 'partly_inside'].includes(area.coverage));
        share(area.area_share);
        assert(area.area_share > 0);
        if (area.coverage === 'partly_inside') assert(!('boundary_distance' in area));
      }
    }
  } else assert.deepEqual(result.protected_areas,
    { status: 'not_computed', reason: 'snapshot_without_protected_areas' });
}
function validateBundle(bundle, profile) {
  const state = stateFor(bundle);
  for (const [id, draft] of state.shotDrafts) {
    const local = state.generatedReports.get(id);
    assert.deepEqual(local.report.incident_location, state.source.outgoingArea(draft),
      'Historical shots must use the current source-derived outgoing area');
    assert.equal(local.report.incident_location.type, 'area', 'Historical shots cannot be precise points');
    assert.equal(local.report.device_fix, null, 'Area Reports cannot transmit the reporter fix');
    assert.deepEqual(local.privateFix, draft.fix, 'Exact area reporter fix belongs only in local privateFix');
    const area = local.report.incident_location;
    if (draft.fromHome) {
      assert.equal(area.precise_fix_withheld, 'home_privacy');
      assert(state.source.homeBoundsOnGrid(area.bounds), 'Home areas must use the fixed privacy grid');
      for (const field of ['hearing_bearing_deg', 'hearing_distance_band', 'hearing_distance_m']) {
        assert(!(field in area), 'Home areas must withhold direction and distance');
      }
    }
  }
  for (const row of bundle.serverReports) {
    const local = state.generatedReports.get(row.id);
    assert(!('privateFix' in row), 'Server fixtures cannot contain local privateFix');
    assertGeometry(row, serverReport(local.report, row.received_at), reportGeometryColumns);
  }
  assert.equal(bundle.reports.length, profile.report_count);
  assert.equal(bundle.drafts.length, profile.draft_count);
  assert.equal(bundle.withdrawals.length, profile.withdrawal_count);
  const synced = bundle.reports.filter(local => local.events.some(event => event.kind === 'synced'));
  assert.equal(synced.length, profile.synced_report_count);
  assert.equal(bundle.reports.length - synced.length, profile.queued_report_count);
  for (const [kind, count] of Object.entries(profile.synced_findings)) {
    assert.equal(synced.filter(local => (state.seeded ? findingClass(local) : state.labels.get(local.report.id)) === kind).length,
      count, `Findings partition ${kind}`);
  }
  const notices = bundle.reports.flatMap(local => local.notices);
  assert.equal(notices.length, profile.notice_count);
  assert.equal(notices.filter(notice => notice.outcomes.length).length, profile.notices_with_outcomes);
  assert.equal(bundle.serverReports.length, profile.synced_report_count + profile.withdrawal_count);
  const localIds = [...bundle.reports.map(local => local.report.id), ...bundle.drafts.map(draft => draft.id),
    ...bundle.withdrawals.map(withdrawal => withdrawal.id)];
  assert.equal(new Set(localIds).size, localIds.length, 'History entity IDs must be disjoint');
  const eventIds = notices.flatMap(notice => [notice.id, ...notice.events.map(event => event.id),
    ...notice.outcomes.map(event => event.id)]);
  assert.equal(new Set(eventIds).size, eventIds.length, 'Notice/event IDs must be unique');
  if (profile.report_count >= 5) assert.equal(new Set(bundle.reports.map(local => local.report.event_type)).size, 5);
  const clock = Date.parse(bundle.identity.clock);
  const past = value => assert(Number.isFinite(Date.parse(value)) && Date.parse(value) <= clock,
    'History chronology must not exceed the declared clock');
  for (const draft of bundle.drafts) { past(draft.capturedAt); past(draft.lastActivityAt); }
  for (const withdrawal of bundle.withdrawals) { past(withdrawal.at); assert(withdrawal.retry_at > clock); }
  for (const event of bundle.serverEvents) past(event.at);
  for (const local of bundle.reports) {
    past(local.report.captured_at);
    assert.deepEqual(state.source.reportSchema.parse(local.report), local.report);
    if (local.findings.status === 'computed' && state.seeded) {
      const row = bundle.serverFindings.find(item => item.report_id === local.report.id);
      assertGeometry(local.findings, row, findingsGeometryColumns);
      const area = local.report.incident_location.type === 'area' ? local.report.incident_location : null;
      assert.deepEqual(local.findings.area_bounds, area?.bounds ?? null);
      assert.equal(local.findings.accuracy_m, area ? null : local.report.device_fix?.accuracy_m ?? null);
      assertCurrentSpatial(local.findings, area !== null, local.findings.datasets);
      assert.equal(row.shape_version, 2, 'New historical Findings must use the current worker shape');
    }
    past(local.report.occurred_at.at);
    past(local.lastActivityAt);
    for (const event of local.events) past(event.at);
    for (const notice of local.notices) {
      for (const event of [...notice.events, ...notice.outcomes]) past(event.at);
      for (const outcome of notice.outcomes) {
        assert(outcome.observed_on <= outcome.at.slice(0, 10), 'A dated outcome cannot precede its observation');
      }
    }
    assert.equal(hash(local.token), local.report.token_sha256);
    assert(local.retry_at > Date.parse(bundle.identity.clock));
    if (!local.events.some(event => event.kind === 'synced')) assert.equal(local.findings.status, 'pending');
    if (local.report.event_type === 'remains') assert(local.photos.length >= 1 && local.photos.length <= 3);
    for (const photo of local.photos) assert(local.report.photo_sha256.includes(photo.sha256));
    for (const notice of local.notices) {
      assert(!('signer' in notice), 'Signed identity belongs only in the device signer store');
      if (notice.outcomes.length) assert(notice.events.some(event => event.kind === 'confirmed_by_reporter'));
      assert(notice.events.every(event => event.synced), 'Seeded Notice events must exist on server');
      assert(notice.outcomes.every(event => event.synced), 'Seeded Notice outcomes must exist on server');
    }
  }
}

export async function buildHistory({ profile, clock, fixtures, namespace }) {
  validateProfile(profile);
  assert(typeof namespace === 'string' && namespace.length && namespace.includes(profile.id),
    'Use a stable, profile-specific history namespace, never an active-case namespace');
  const at = Date.parse(clock);
  assert(Number.isFinite(at), 'History clock must be an ISO instant');
  const source = await contracts();
  assert.deepEqual([...source.reportSchema.shape.event_type.options], eventTypes);
  assert(fixtures.recipients?.length >= 2, 'Two synthetic recipients required for independent recipient histories');
  assert(fixtures.note && fixtures.point && fixtures.outside && fixtures.photo);
  const jpeg = syntheticJpeg(fixtures.photo.width, fixtures.photo.height);
  const jpegHash = hash(jpeg);
  // An artificial frozen-history fixture boundary, not sync.ts's <=30-second failure backoff.
  const retryAt = at + 30 * day;
  const classes = Object.entries(profile.synced_findings).flatMap(([kind, count]) => Array(count).fill(kind));
  const bundle = { reports: [], drafts: [], withdrawals: [], serverReports: [], serverEvents: [], serverFindings: [],
    identity: {}, targets: {} };
  const labels = new Map();
  const shotDrafts = new Map();
  const generatedReports = new Map();
  const base = at - 45 * day;
  const captureSpacingMs = profile.report_count > 1 ? Math.floor(10 * day / (profile.report_count - 1)) : 60_000;
  const tieFirst = Math.floor(profile.report_count / 2) - 1;
  const tieSecond = tieFirst + 1;
  function makeReport(index, label, kind, synced) {
    // A midpoint pair ties; Report dates span ten days and remain at least 35 days old.
    const timeIndex = profile.report_count >= 5 && index === tieSecond ? tieFirst : index;
    const capturedAt = iso(base + (label.startsWith('report:') ? timeIndex * captureSpacingMs : index * 60_000));
    const createdAt = iso(Date.parse(capturedAt) + 60_000);
    const syncedAt = iso(Date.parse(createdAt) + 60_000);
    const id = uuid(namespace, label);
    const token = hash(`${generatorVersion}\0synthetic-disposable-token\0${namespace}\0${label}`);
    const eventType = eventTypes[index % eventTypes.length];
    // The acceptance point sits 820 m from the snapshot's western edge, so a 2 km home-privacy cell around it is only
    // partly covered and the real worker reports outside_coverage. Covered history sits 3 km east and 3 km north instead.
    const point = kind === 'outside_coverage' ? fixtures.outside : { ...fixtures.point, lat: fixtures.point.lat + 0.03, lon: fixtures.point.lon + 0.05 };
    const hasPhoto = eventType === 'remains';
    const fix = { lat: point.lat, lon: point.lon, accuracy_m: point.accuracy_m, at: capturedAt };
    // Cycle unknown direction, heard estimate, and home-private heard estimate per shot.
    // The Draft models the capture-time choice; its date-only occurrence remains unchanged.
    const shotVariant = Math.floor(index / eventTypes.length) % 3;
    const shotDraft = eventType === 'shot' ? { eventType: 0, fix, occurredMode: 'now',
      locationMethod: 'reporter', fromHome: shotVariant === 2,
      ...(shotVariant ? { hearingBearing: 90, hearingDistanceM: 500 } : {}) } : null;
    const area = shotDraft ? source.outgoingArea(shotDraft) : null;
    if (shotDraft) { assert(area, 'A generated shot must have an outgoing area'); shotDrafts.set(id, shotDraft); }
    const report = source.reportSchema.parse({ id, event_type: eventType, captured_at: capturedAt,
      occurred_at: { at: capturedAt, source: 'entered_by_reporter', coarseness: 'date_only' },
      device_fix: area ? null : fix,
      incident_location: area ?? { lat: point.lat, lon: point.lon, source: 'device_fix' },
      species: null, ...(eventType === 'shot' ? {} : { photo_sha256: hasPhoto ? [jpegHash] : [] }),
      has_note: true, app_version: '0.1.0', privacy_policy_version: 'v1', terms_of_use_version: 'v1',
      token_sha256: hash(token) });
    // Terminal results are hydrated from the real worker before any IndexedDB installation.
    // No centre-based measurement or legacy incident_area result stands in for an area.
    const findings = kind === 'failed' ? { status: 'failed', reason: 'computation_failed' } : { status: 'pending' };
    const local = { lastActivityAt: synced ? syncedAt : createdAt, report, token,
      ...(area ? { privateFix: { ...fix } } : {}),
      note: `${fixtures.note} [historia ${profile.id} ${index + 1}]`,
      photos: hasPhoto ? [{ id: uuid(namespace, `${label}:photo`), jpeg: new Blob([jpeg], { type: 'image/jpeg' }), sha256: jpegHash }] : [],
      events: [{ kind: 'created', at: createdAt, details: { privacy_policy_version: 'v1', terms_of_use_version: 'v1' } },
        ...(synced ? [{ kind: 'synced', at: syncedAt }] : [])], findings, notices: [],
      retry_at: retryAt, retry_reason: 'server', retry_stage: synced ? 'findings' : 'report' };
    if (synced) {
      const receivedAt = iso(Math.floor(Date.parse(syncedAt) / 60_000) * 60_000);
      bundle.serverReports.push(serverReport(report, receivedAt));
      bundle.serverEvents.push({ report_id: id, kind: 'created', at: capturedAt,
        details: { privacy_policy_version: 'v1', terms_of_use_version: 'v1' }, event_id: null },
      { report_id: id, kind: 'synced', at: receivedAt, details: {}, event_id: null });
      labels.set(id, kind);
      const diagnosticAt = iso(Math.max(Date.parse(syncedAt) + 60_000, at - 14 * day));
      if (kind === 'computed' || kind === 'outside_coverage') {
        bundle.serverFindings.push({ report_id: id, computed_at: diagnosticAt });
      }
      if (kind === 'computed' || kind === 'outside_coverage' || kind === 'failed') {
        bundle.serverEvents.push({ report_id: id,
          kind: kind === 'failed' ? 'findings_failed' : 'findings_computed',
          at: diagnosticAt,
          details: kind === 'failed' ? { reason: findings.reason } : {}, event_id: null });
      }
    }
    generatedReports.set(id, local);
    return local;
  }
  for (let index = 0; index < profile.report_count; index++) {
    const synced = index < profile.synced_report_count;
    bundle.reports.push(makeReport(index, `report:${index}`, synced ? classes[index] : 'pending', synced));
  }
  for (let index = 0; index < profile.draft_count; index++) {
    const capturedAt = iso(base + (profile.report_count + index + 10) * 60_000);
    bundle.drafts.push({ id: uuid(namespace, `draft:${index}`), eventType: index % 2 ? index % 5 : null,
      capturedAt, lastActivityAt: capturedAt, quickCapture: true, remindersOff: true,
      fix: { ...fixtures.point, at: capturedAt }, note: `${fixtures.note} [szkic ${profile.id} ${index + 1}]` });
  }
  for (let index = 0; index < profile.withdrawal_count; index++) {
    const local = makeReport(profile.report_count + profile.draft_count + index + 20, `withdrawal:${index}`, 'pending', true);
    bundle.withdrawals.push({ id: local.report.id, token: local.token, at: iso(at - 20 * day + index * 60_000), retry_at: retryAt });
  }
  // Each adjacent pair belongs to the same Report but a different recipient. Outcomes append,
  // never overwrite: the second dated statement corrects the first Reporter observation.
  for (let index = 0; index < profile.notice_count; index++) {
    const local = bundle.reports[Math.floor(index / 2)];
    const recipient = structuredClone(fixtures.recipients[index % 2]);
    const other = structuredClone(fixtures.recipients[1 - index % 2]);
    const id = uuid(namespace, `notice:${index}`);
    const start = at - 12 * day + index * 10_000;
    assert(Date.parse(source.noticeFragments.effective_from) <= start, 'Notice template did not exist at the seeded composition time');
    const variant = index % 2 ? 'unsigned' : 'signed';
    const withOutcome = index < profile.notices_with_outcomes;
    const eventKinds = withOutcome ? ['notice_composed', ...(variant === 'unsigned' ? ['handed_to_mail_client'] : []),
      'confirmed_by_reporter'] : ['notice_composed'];
    const events = eventKinds.map((kind, eventIndex) => ({ ...source.noticeEventSchema.parse({
      id: uuid(namespace, `notice:${index}:event:${eventIndex}`), kind, notice_id: id,
      recipient_kind: recipient.kind, unit_id: recipient.id, template_version: source.noticeFragments.version,
      directory_version: fixtures.version, at: iso(start + eventIndex * 60_000) }), synced: true }));
    const outcomeCodes = index % 2 ? ['refusal', 'reply'] : ['reply', 'no_answer_yet'];
    const outcomes = withOutcome ? outcomeCodes.map((outcome, outcomeIndex) => {
      const observedAt = start + (outcomeIndex + 1) * day;
      return { ...source.noticeOutcomeSchema.parse({ id: uuid(namespace, `notice:${index}:outcome:${outcomeIndex}`),
        kind: 'outcome_reported', notice_id: id, recipient_kind: recipient.kind, unit_id: recipient.id,
        outcome, observed_on: iso(observedAt).slice(0, 10), at: iso(observedAt + 60_000) }), synced: true };
    }) : [];
    const notice = { id, recipient, others: [other], variant, askHandoff: false,
      ...(withOutcome ? { handoffRoute: variant === 'signed' ? 'pdf' : 'mail' } : {}),
      places: { gmina: 'FAZA6 Testowo', powiat: 'FAZA6', nadlesnictwo: null }, events, outcomes };
    local.notices.push(notice);
    local.noticePreparation = { choices: [recipient, other].map(unit => ({ unit, selected: true })), variant };
    const noticeActivity = outcomes.at(-1)?.at ?? events.at(-1).at;
    if (noticeActivity > local.lastActivityAt) local.lastActivityAt = noticeActivity;
    bundle.serverEvents.push(...events.map(event => eventRow(local.report.id, event)),
      ...outcomes.map(event => eventRow(local.report.id, event)));
  }
  const ordered = [...bundle.reports].sort((a, b) => a.events[0].at.localeCompare(b.events[0].at) || a.report.id.localeCompare(b.report.id));
  bundle.targets = { oldest: ordered[0]?.report.id ?? null, newest: ordered.at(-1)?.report.id ?? null,
    tied: profile.report_count >= 5 ? [bundle.reports[tieFirst].report.id, bundle.reports[tieSecond].report.id].sort() : [],
    tied_at: profile.report_count >= 5 ? bundle.reports[tieFirst].report.captured_at : null,
    tied_created_at: profile.report_count >= 5 ? bundle.reports[tieFirst].events[0].at : null,
    ordering: 'Library capture time newest first; equal instants retain stable Report-ID order',
    recipients: ordered[0]?.notices.map(notice => ({ notice_id: notice.id, recipient_id: notice.recipient.id, variant: notice.variant })) ?? [] };
  const inputs = { generator: generatorVersion, source_sha256: hash(await readFile(new URL(import.meta.url))),
    profile, clock: iso(at), fixtures_sha256: contentHash(fixtures), namespace,
    photo: { method: 'metadata-free baseline grayscale JPEG, uniform 128', width: fixtures.photo.width,
      height: fixtures.photo.height, byte_length: jpeg.length, sha256: jpegHash },
    chronology: { first_capture: profile.report_count ? iso(base) : null, capture_spacing_ms: captureSpacingMs,
      tied_indices: profile.report_count >= 5 ? [tieFirst, tieSecond] : [],
      report_age_days_minimum: profile.report_count ? (at - (base + (profile.report_count - 1) * captureSpacingMs)) / day : null,
      notice_start_days_before_clock: 12, outcome_offsets_days: [1, 2] },
    retry: { at: iso(retryAt), reason: 'server', artificial_boundary_days: 30,
      boundary: 'artificial-frozen-history',
      source_failure_backoff_max_ms: 30_000,
      policy: 'Artificial 30-day fixture boundary, not natural sync backoff or a global admission cooldown. Frozen inspection retains it; explicit pre-app replay releases only historical queued Reports and pending Withdrawals.' },
    method: 'Bulk SQL fixture setup, not HTTP throughput or legal measurement evidence',
    geometry_policy: {
      shots: 'Current outgoingArea on capture-time reporter-location Drafts; date-only occurrence unchanged. Shot ordinal modulo 3 selects unknown direction, heard estimate, home-private heard estimate.',
      estimate: { hearing_bearing_deg: 90, hearing_distance_m: 500 },
      privacy: 'Every shot sends device_fix=null. Exact reporter fix stays only in local privateFix. Home grid areas withhold all direction/distance fields.',
      server: 'Report-domain bounds, centroid storage, source, basis, withholding and estimate columns. Current worker fixture values require full area coverage, closest dwelling distance and whole-area threshold share, area obwody/protected coverage, edge-based nearest stand, nullable Accuracy and bounds-based time Findings.',
      evidence: 'Source-derived worker fixture setup, not independent legal measurement proof. Replay compares with pre-app fixture values, never application spatial SQL used as an assertion oracle. Active independent geometry fixtures remain unchanged.'
    },
    expected_transitions: 'Frozen inspection preserves every seeded entity. Explicit replay releases only queued Reports and pending Withdrawals; other synchronized history remains frozen except source-derived server integrity refreshes.',
    signed_details_policy: 'Historical signed variant is local; no signer store prefill or identity in server rows. Reopening may request local signer entry.' };
  bundle.identity = { version: generatorVersion, profile: profile.id, namespace, clock: iso(at),
    sha256: contentHash(inputs), inputs, resolved_metadata_sha256: null, actual_seed_sha256: null };
  internals.set(bundle, { profile: structuredClone(profile), fixtures: structuredClone(fixtures), source, jpeg,
    labels, shotDrafts, generatedReports, serverBaseline: null, localBaseline: null, previousShared: null,
    natural: null, seeded: false });
  validateBundle(bundle, profile);
  return bundle;
}

async function ownership(database) {
  assert.equal(process.env.FAZA6_ALLOW_DISPOSABLE, 'YES', 'History SQL requires FAZA6_ALLOW_DISPOSABLE=YES');
  assert(process.env.FAZA6_PROJECT_ID, 'History SQL requires FAZA6_PROJECT_ID');
  const marker = await database.query('SELECT project_id, disposable FROM public.faza6_runner_ownership');
  assert.equal(marker.rowCount, 1, 'Exactly one disposable ownership marker required');
  assert.equal(marker.rows[0].project_id, process.env.FAZA6_PROJECT_ID, 'History database ownership mismatch');
  assert.equal(marker.rows[0].disposable, true, 'History database must be disposable');
}
async function insertRows(database, table, columns, rows, jsonColumns = []) {
  if (!rows.length) return;
  const json = new Set(jsonColumns);
  // Explicit columns preserve defaults and PostgreSQL constraints. Bounded chunks stay below
  // PostgreSQL's parameter ceiling without creating one request/transaction per fixture row.
  const size = Math.max(1, Math.floor(12_000 / columns.length));
  for (let offset = 0; offset < rows.length; offset += size) {
    const values = [];
    const tuples = rows.slice(offset, offset + size).map(row => `(${columns.map(column => {
      const value = row[column] ?? null;
      values.push(json.has(column) && value !== null ? JSON.stringify(value) : value);
      return `$${values.length}`;
    }).join(',')})`);
    await database.query(`INSERT INTO public.${table} (${columns.join(',')}) VALUES ${tuples.join(',')}`, values);
  }
}
const serverTables = [
  ['report', 'id'], ['report_event', 'report_id'], ['findings', 'report_id'], ['findings_job', 'report_id'],
  ['integrity_signal', 'report_id'], ['integrity_refresh', 'report_id'], ['report_withdrawal', 'id']
];
function historyIds(bundle) {
  return [...bundle.reports.map(local => local.report.id), ...bundle.withdrawals.map(item => item.id),
    ...bundle.drafts.map(item => item.id)];
}
async function serverInventory(database, bundle) {
  const ids = historyIds(bundle);
  const tables = {};
  for (const [table, column] of serverTables) {
    const result = await database.query(`SELECT to_jsonb(t) AS row FROM public.${table} t WHERE ${column} = ANY($1::uuid[])`, [ids]);
    const rows = result.rows.map(item => item.row).sort((a, b) => canonical(a).localeCompare(canonical(b)));
    if (table === 'report' || table === 'findings') {
      const expected = new Map((table === 'report' ? bundle.serverReports : bundle.serverFindings)
        .map(row => [table === 'report' ? row.id : row.report_id, row]));
      assert.equal(rows.length, expected.size, `Installed history ${table} geometry row count differs`);
      for (const row of rows) {
        const original = expected.get(table === 'report' ? row.id : row.report_id);
        assert(original, `Unexpected installed history ${table} geometry row`);
        assertGeometry(row, original, table === 'report' ? reportGeometryColumns : findingsGeometryColumns);
      }
    }
    const total = (await database.query(`SELECT count(*)::int AS n FROM public.${table}`)).rows[0].n;
    tables[table] = { count: rows.length, total, content_sha256: contentHash(rows),
      ids_sha256: contentHash(rows.map(row => row.id ?? row.report_id).sort()) };
  }
  const sourceMetadata = {};
  for (const [table, column, references] of [
    ['rule_set', 'id', bundle.serverFindings.map(row => row.rule_set_id)],
    ['geodata_snapshot', 'id', bundle.serverFindings.map(row => row.geodata_snapshot_id)],
    ['geodata_dataset', 'snapshot_id', bundle.serverFindings.map(row => row.geodata_snapshot_id)]
  ]) {
    const result = await database.query(`SELECT to_jsonb(t) AS row FROM public.${table} t WHERE ${column} = ANY($1::text[])`,
      [[...new Set(references)]]);
    const rows = result.rows.map(item => item.row).sort((a, b) => canonical(a).localeCompare(canonical(b)));
    sourceMetadata[table] = { count: rows.length, content_sha256: contentHash(rows) };
  }
  return { tables, source_metadata: sourceMetadata, content_sha256: contentHash({
    tables: Object.fromEntries(Object.entries(tables)
      .map(([table, value]) => [table, { count: value.count, content_sha256: value.content_sha256 }])),
    source_metadata: sourceMetadata }) };
}

const spatialColumns = ['dwelling_distance', 'obwod_lowiecki', 'nearest_ambona', 'protected_areas'];
const reportColumns = ['id', 'token_sha256', 'event_type', 'captured_at', 'occurred_at',
  'occurred_source', 'occurred_coarseness', 'occurred_window_end', 'device_lat', 'device_lon', 'accuracy_m',
  'device_fix_at', 'incident_lat', 'incident_lon', 'incident_source', 'has_note', 'app_version',
  'privacy_policy_version', 'terms_of_use_version', 'species', 'incident_bounds', 'area_basis',
  'precise_fix_withheld', 'hearing_bearing_deg', 'hearing_distance_band', 'hearing_distance_m',
  'photo_sha256', 'received_at', 'publishable'];
const historyQueueLocks = ['findings_job', 'integrity_refresh', 'report'];
function spatialKey(snapshot, row, rule) {
  return contentHash({ snapshot: snapshot.id, rule: rule.id, source: row.incident_source,
    bounds: row.incident_bounds, lon: row.incident_lon, lat: row.incident_lat, accuracy: row.accuracy_m });
}
function spatialFindings(bundle, snapshot, row, rule) {
  const cached = stateFor(bundle).spatialFixtures.get(spatialKey(snapshot, row, rule));
  assert(cached, 'No pre-app worker spatial fixture covers this geometry, Accuracy, source, Rule set and snapshot');
  return structuredClone(cached);
}
async function assertRunnerIsolation(database) {
  await ownership(database);
  const { rows: [lock] } = await database.query(`SELECT EXISTS (
    SELECT 1 FROM pg_locks WHERE locktype = 'advisory' AND pid = pg_backend_pid() AND granted
      AND classid::bigint = ((hashtext('faza6-workflow-runner')::bigint >> 32) & 4294967295)
      AND objid::bigint = (hashtext('faza6-workflow-runner')::bigint & 4294967295)
      AND objsubid = 1) AS held`);
  assert.equal(lock.held, true, 'Pre-app worker fixtures require the parent runner advisory lock on this connection');
}
async function lockHistoryQueues(database) {
  await database.query("SET LOCAL lock_timeout = '5s'");
  for (const table of historyQueueLocks) await database.query(`LOCK TABLE public.${table} IN ACCESS EXCLUSIVE MODE`);
}
async function fixtureMetadata(database) {
  const snapshot = (await database.query(`SELECT s.id, s.created_at, s.datasets, s.storage_schema
    FROM current_geodata c JOIN geodata_snapshot s ON s.id = c.snapshot_id FOR SHARE OF c`)).rows[0];
  const rules = (await database.query(`SELECT id, effective_from::text, published_at, parameters
    FROM rule_set ORDER BY effective_from DESC, published_at DESC`)).rows;
  return { snapshot, rules };
}
// Only the existing, separately running restricted worker computes these fixtures.
// Commit before waiting: a queue lock held across the wait would deadlock that worker.
// These spatial values are source-derived setup, not independent numeric assertions.
async function prepareSpatialFixtures(database, bundle) {
  const state = stateFor(bundle);
  const started = Date.now();
  await assertRunnerIsolation(database);
  const sourceHashes = Object.fromEntries(await Promise.all([
    '../server/findings.ts', '../src/lib/findings-reading.ts'
  ].map(async path => [path, hash(await readFile(new URL(path, import.meta.url)))])));
  let metadata;
  const representatives = new Map();
  await database.query('BEGIN');
  try {
    await lockHistoryQueues(database);
    metadata = await fixtureMetadata(database);
    if (bundle.reports.length) assert(metadata.snapshot, 'Worker fixtures need installed current geodata');
    for (const local of bundle.reports) {
      const row = serverReport(local.report, local.report.captured_at);
      const occurrenceDate = state.source.warsawDate(new Date(row.occurred_at));
      const rule = metadata.rules.find(item => item.effective_from <= occurrenceDate);
      assert(rule, `No historical Rule set covers fixture occurrence ${occurrenceDate}`);
      const key = spatialKey(metadata.snapshot, row, rule);
      if (!representatives.has(key)) {
        const id = uuid(bundle.identity.namespace, `worker-spatial-fixture:${key}`);
        assert(!historyIds(bundle).includes(id), 'Temporary worker fixture IDs must be disjoint from history');
        representatives.set(key, { row: { ...row, id }, rule });
      }
    }
    await insertRows(database, 'report', reportColumns,
      [...representatives.values()].map(item => item.row), ['photo_sha256', 'incident_bounds']);
    await insertRows(database, 'findings_job', ['report_id', 'rule_set_id', 'geodata_snapshot_id'],
      [...representatives.values()].map(({ row, rule }) => ({
        report_id: row.id, rule_set_id: rule.id, geodata_snapshot_id: metadata.snapshot.id
      })));
    await database.query('COMMIT');
  } catch (error) {
    await database.query('ROLLBACK');
    throw error;
  }
  const ids = [...representatives.values()].map(item => item.row.id);
  const byId = new Map([...representatives].map(([key, item]) => [item.row.id, { key, ...item }]));
  const fixtures = new Map();
  const waitStarted = Date.now();
  let computationError, cleanupError, workerWaitMs, cleanupMs;
  const cleanup = { status: 'not-started', before: null, after: null, removed_reports: 0 };
  const describeError = error => ({ name: error?.name ?? typeof error, message: String(error?.message ?? error) });
  async function temporaryCounts() {
    const counts = {};
    for (const [table, column] of serverTables) {
      const { rows: [count] } = await database.query(`SELECT count(*)::int AS n FROM public.${table}
        WHERE ${column} = ANY($1::uuid[])`, [ids]);
      counts[table] = count.n;
    }
    return counts;
  }
  state.spatialFixtures = new Map();
  try {
    while (fixtures.size < representatives.size) {
      const { rows: [observed] } = await database.query(`SELECT
        (SELECT coalesce(jsonb_agg(to_jsonb(f)), '[]'::jsonb) FROM findings f WHERE report_id = ANY($1::uuid[])) AS findings,
        (SELECT coalesce(jsonb_agg(to_jsonb(j)), '[]'::jsonb) FROM findings_job j WHERE report_id = ANY($1::uuid[])) AS jobs`,
      [ids]);
      assert(!observed.jobs.some(job => job.failed_reason),
        `Real worker fixture failed: ${observed.jobs.filter(job => job.failed_reason).map(job => job.failed_reason).join(',')}`);
      for (const result of observed.findings) {
        const representative = byId.get(result.report_id);
        assert.equal(result.shape_version, 2, 'Worker fixture requires integrated current shape-2 worker');
        assert.equal(result.rule_set_id, representative.rule.id);
        assert.equal(result.geodata_snapshot_id, metadata.snapshot.id);
        assert.deepEqual(result.area_bounds, representative.row.incident_bounds);
        assert.equal(result.accuracy_m, representative.row.incident_source === 'device_fix'
          ? representative.row.accuracy_m : null);
        assert(!observed.jobs.some(job => job.report_id === result.report_id),
          'Real worker fixture must retire its job atomically');
        assertCurrentSpatial(result, representative.row.incident_source === 'area', metadata.snapshot.datasets);
        fixtures.set(representative.key, Object.fromEntries(spatialColumns.map(field => [field, result[field]])));
      }
      if (fixtures.size === representatives.size) break;
      assert(Date.now() - waitStarted < 60_000, 'Existing dedicated worker did not complete pre-app fixtures within 60 seconds');
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    const current = await fixtureMetadata(database);
    assert.equal(contentHash(current), contentHash(metadata), 'Geodata/Rule sets changed during worker fixture setup');
  } catch (error) {
    computationError = error;
  } finally {
    workerWaitMs = Date.now() - waitStarted;
    const cleanupStarted = Date.now();
    // No fixture result, timeout or provenance assertion may skip owned-row cleanup.
    // Queue-first locks also serialize deletion with a worker still finishing its job.
    try {
      await database.query('BEGIN');
      await assertRunnerIsolation(database);
      await lockHistoryQueues(database);
      cleanup.before = await temporaryCounts();
      for (const table of ['findings_job', 'integrity_refresh', 'report_event', 'findings', 'integrity_signal']) {
        await database.query(`DELETE FROM public.${table} WHERE report_id = ANY($1::uuid[])`, [ids]);
      }
      const removed = await database.query('DELETE FROM public.report WHERE id = ANY($1::uuid[]) RETURNING id', [ids]);
      cleanup.removed_reports = removed.rowCount;
      cleanup.after = await temporaryCounts();
      for (const [table, count] of Object.entries(cleanup.after)) {
        assert.equal(count, 0, `Temporary worker fixture cleanup left ${table} rows`);
      }
      await database.query('COMMIT');
      cleanup.status = 'complete';
      assert.equal(removed.rowCount, ids.length, 'Temporary worker fixture cleanup lost owned Reports');
    } catch (error) {
      cleanupError = error;
      cleanup.status = 'failed';
      try { await database.query('ROLLBACK'); }
      catch (rollbackError) {
        cleanupError = new AggregateError([error, rollbackError],
          `Fixture cleanup failed: ${error.message}; rollback failed: ${rollbackError.message}`, { cause: error });
      }
      // Counts from an aborted transaction are not proof of cleanup.
      cleanup.after = null;
      try { cleanup.after = await temporaryCounts(); }
      catch (countError) { cleanup.count_error = describeError(countError); }
    }
    cleanupMs = Date.now() - cleanupStarted;
  }
  const receipt = {
    method: 'pre-app-owned-sql-representatives-existing-restricted-worker-not-http-throughput',
    source_sha256: sourceHashes, metadata_sha256: contentHash(metadata), shape_version: 2,
    representative_ids: ids.sort(), representative_count: ids.length,
    spatial_values_sha256: contentHash([...fixtures].sort(([a], [b]) => a.localeCompare(b))),
    computed_shapes: [...fixtures.values()].reduce((counts, result) => {
      const status = result.dwelling_distance.status;
      counts[status] = (counts[status] ?? 0) + 1;
      return counts;
    }, {}),
    elapsed_ms: Date.now() - started, worker_wait_ms: workerWaitMs, cleanup_ms: cleanupMs,
    cleanup, computation_error: computationError ? describeError(computationError) : null,
    cleanup_error: cleanupError ? describeError(cleanupError) : null,
    lock_order: historyQueueLocks, independent_numeric_oracle: false
  };
  state.spatialFixtureReceipt = receipt;
  if (computationError || cleanupError) {
    const error = computationError && cleanupError
      ? new AggregateError([computationError, cleanupError],
        `Worker fixture failed: ${computationError.message}; cleanup failed: ${cleanupError.message}`,
        { cause: computationError })
      : computationError ?? cleanupError;
    error.worker_spatial_fixtures = receipt;
    throw error;
  }
  state.spatialFixtures = fixtures;
  return { metadata, receipt };
}

export async function seedHistoryDatabase(database, bundle) {
  const state = stateFor(bundle);
  await ownership(database);
  validateBundle(bundle, state.profile);
  // Main runner owns draining, queue-first locking and reset. Never reset from this helper.
  const occupied = await database.query(`SELECT (SELECT count(*) FROM report) +
    (SELECT count(*) FROM report_withdrawal) + (SELECT count(*) FROM findings_job) +
    (SELECT count(*) FROM integrity_refresh) AS n`);
  assert.equal(Number(occupied.rows[0].n), 0, 'Close prior contexts and complete the worker-safe reset before history seed');
  state.localBaseline = null;
  state.serverBaseline = null;
  state.previousShared = null;
  state.replay = null;
  state.natural = null;
  state.seeded = false;
  const prepared = await prepareSpatialFixtures(database, bundle);
  state.spatialFixtureReceipt = prepared.receipt;
  const metadata = [{ worker_spatial_fixtures: prepared.receipt }];
  await database.query('BEGIN');
  try {
    await lockHistoryQueues(database);
    const current = await fixtureMetadata(database);
    assert.equal(contentHash(current), contentHash(prepared.metadata), 'Seed metadata differs from worker fixture metadata');
    const { snapshot, rules } = current;
    if (bundle.serverReports.length) assert(snapshot, 'History needs the real installed geodata snapshot');
    const locals = new Map(bundle.reports.map(local => [local.report.id, local]));
    for (const row of bundle.serverReports) {
      const kind = state.labels.get(row.id);
      const occurrenceDate = state.source.warsawDate(new Date(row.occurred_at));
      const rule = rules.find(item => item.effective_from <= occurrenceDate);
      assert(rule, `No installed historical rule set covers history occurrence ${occurrenceDate}`);
      metadata.push({ report_id: row.id, rule_set_id: rule.id, rule_parameters_sha256: contentHash(rule.parameters),
        geodata_snapshot_id: snapshot.id, snapshot_date: iso(snapshot.created_at), datasets_sha256: contentHash(snapshot.datasets) });
      const local = locals.get(row.id);
      if (kind === 'computed' || kind === 'outside_coverage' || kind === 'failed') {
        const availability = [new Date(snapshot.created_at).getTime(), new Date(rule.published_at).getTime(),
          ...snapshot.datasets.map(dataset => Date.parse(dataset.retrieved_at))];
        assert(availability.every(Number.isFinite), 'Installed Findings provenance needs valid availability dates');
        const diagnosticAt = iso(Math.max(...availability, Date.parse(row.received_at) + 60_000,
          Date.parse(bundle.identity.clock) - 14 * day));
        assert(Date.parse(diagnosticAt) <= Date.parse(bundle.identity.clock),
          'Installed Findings metadata was unavailable at the declared history clock');
        const diagnostic = bundle.serverEvents.find(event => event.report_id === row.id &&
          (event.kind === 'findings_computed' || event.kind === 'findings_failed'));
        diagnostic.at = diagnosticAt;
        const finding = bundle.serverFindings.find(item => item.report_id === row.id);
        if (finding) finding.computed_at = diagnosticAt;
      }
      if (kind === 'computed' || kind === 'outside_coverage') {
        const spatial = spatialFindings(bundle, snapshot, row, rule);
        assert.equal(spatial.dwelling_distance.reason === 'outside_coverage', kind === 'outside_coverage',
          `Declared history coverage must match the real installed snapshot: ${JSON.stringify({ report: row.id, declared: kind,
            source: row.incident_source, lat: row.incident_lat, lon: row.incident_lon, bounds: row.incident_bounds,
            accuracy_m: row.accuracy_m, dwelling_distance: spatial.dwelling_distance })}`);
        const time = rule.parameters.noc && rule.parameters.species && rule.parameters.citations
          ? state.source.evaluateTimeFindings(local.report.occurred_at,
            row.incident_bounds ? { bounds: row.incident_bounds } : { lat: row.incident_lat, lon: row.incident_lon },
            local.report.species, rule.parameters)
          : { noc: { status: 'not_computed', reason: 'historical_rules_unavailable' },
            okres_ochronny: { status: 'not_computed', reason: 'historical_rules_unavailable' } };
        const result = { status: 'computed', rule_set_id: rule.id, geodata_snapshot_id: snapshot.id,
          snapshot_date: iso(snapshot.created_at), datasets: structuredClone(snapshot.datasets),
          accuracy_m: row.incident_source === 'device_fix' ? row.accuracy_m : null,
          area_bounds: row.incident_bounds, ...structuredClone(spatial), ...time };
        local.findings = result;
        const finding = bundle.serverFindings.find(item => item.report_id === row.id);
        Object.assign(finding, { rule_set_id: rule.id, geodata_snapshot_id: snapshot.id, shape_version: 2,
          dwelling_distance: result.dwelling_distance, obwod_lowiecki: result.obwod_lowiecki,
          accuracy_m: result.accuracy_m, area_bounds: result.area_bounds, noc: result.noc, okres_ochronny: result.okres_ochronny,
          protected_areas: result.protected_areas, nearest_ambona: result.nearest_ambona });
      }
    }
    await insertRows(database, 'report', reportColumns, bundle.serverReports, ['photo_sha256', 'incident_bounds']);
    await insertRows(database, 'findings', ['report_id', 'rule_set_id', 'geodata_snapshot_id', 'dwelling_distance',
      'obwod_lowiecki', 'accuracy_m', 'area_bounds', 'noc', 'okres_ochronny', 'protected_areas', 'nearest_ambona', 'computed_at', 'shape_version'],
    bundle.serverFindings, ['dwelling_distance', 'obwod_lowiecki', 'area_bounds', 'noc', 'okres_ochronny', 'protected_areas', 'nearest_ambona']);
    const failed = bundle.serverReports.filter(row => state.labels.get(row.id) === 'failed').map(row => ({
      report_id: row.id, attempts: 3, available_at: row.received_at, failed_reason: 'computation_failed' }));
    // Terminal diagnostics are not runnable jobs. Pending history needs no job: the real API
    // returns pending when neither Findings nor a terminal diagnostic exists.
    await insertRows(database, 'findings_job', ['report_id', 'attempts', 'available_at', 'failed_reason'], failed);
    await insertRows(database, 'report_event', ['report_id', 'kind', 'at', 'details', 'event_id'],
      bundle.serverEvents, ['details']);
    if (bundle.serverReports.length) await database.query(`INSERT INTO integrity_signal
      (report_id, duplicate_point_count, burst_count, duplicate_photo_count)
      SELECT r.id, count(*) FILTER (WHERE m.duplicate_point)::int,
        count(*) FILTER (WHERE m.burst)::int, count(*) FILTER (WHERE m.duplicate_photo)::int
      FROM report r LEFT JOIN LATERAL integrity_matches(r.id) m ON true
      WHERE r.id = ANY($1::uuid[]) GROUP BY r.id`, [bundle.serverReports.map(row => row.id)]);
    await database.query('COMMIT');
  } catch (error) {
    await database.query('ROLLBACK');
    throw error;
  }
  bundle.identity.resolved_metadata_sha256 = contentHash(metadata);
  state.serverBaseline = await serverInventory(database, bundle);
  bundle.identity.actual_seed_sha256 = contentHash({ inputs_sha256: bundle.identity.sha256,
    resolved_metadata_sha256: bundle.identity.resolved_metadata_sha256, server: state.serverBaseline.content_sha256 });
  state.seeded = true;
  validateBundle(bundle, state.profile);
  return { method: 'bulk-sql-fixture-not-http-throughput', profile: state.profile.id,
    identity: structuredClone(bundle.identity), server: state.serverBaseline, worker_spatial_fixtures: prepared.receipt };
}

async function localSnapshot(page, bundle) {
  const result = await page.evaluate(async ({ ids }) => {
    const sha = async bytes => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)),
      value => value.toString(16).padStart(2, '0')).join('');
    async function clean(value) {
      if (value instanceof Blob) return { blob_type: value.type, byte_length: value.size,
        content_sha256: await sha(await value.arrayBuffer()) };
      if (Array.isArray(value)) return Promise.all(value.map(clean));
      if (value && typeof value === 'object') return Object.fromEntries(await Promise.all(Object.entries(value)
        .filter(([, item]) => item !== undefined).map(async ([key, item]) => [key, await clean(item)])));
      return value;
    }
    const request = indexedDB.open('bor-czuwa', 6);
    const db = await new Promise((resolve, reject) => { request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error); });
    try {
      const names = Array.from(db.objectStoreNames);
      const tx = db.transaction(names, 'readonly');
      const done = new Promise((resolve, reject) => { tx.oncomplete = resolve; tx.onerror = () => reject(tx.error); tx.onabort = () => reject(tx.error); });
      const entries = await Promise.all(names.map(name => new Promise((resolve, reject) => {
        const get = tx.objectStore(name).getAll();
        get.onsuccess = () => resolve([name, get.result]); get.onerror = () => reject(get.error);
      })));
      await done;
      const stores = {};
      for (const [name, records] of entries) {
        const seeded = ['reports', 'drafts', 'withdrawals'].includes(name);
        stores[name] = { total: records.length, rows: await clean(seeded
          ? records.filter(row => ids.includes(name === 'reports' ? row.report.id : row.id)) : records) };
      }
      return { stores, preferences: Object.fromEntries(Object.keys(localStorage).sort().map(key => [key, localStorage.getItem(key)])),
        observed_at: new Date().toISOString() };
    } finally { db.close(); }
  }, { ids: historyIds(bundle) });
  return result;
}

async function localInventory(page, bundle) {
  const result = await localSnapshot(page, bundle);
  const stores = {};
  for (const [name, value] of Object.entries(result.stores)) {
    const rows = value.rows.sort((a, b) => canonical(a).localeCompare(canonical(b)));
    if (name === 'reports') {
      const expected = new Map(bundle.reports.map(local => [local.report.id, local]));
      assert.equal(rows.length, expected.size, 'Installed local history Report count differs');
      for (const local of rows) {
        const original = expected.get(local.report.id);
        assert(original, 'Unexpected installed local history Report');
        assert.deepEqual(local.report, original.report, 'Installed history must preserve the exact outgoing Report');
        assert.deepEqual(local.privateFix, original.privateFix, 'Installed reporter fix must remain local and exact');
        assert.deepEqual(local.findings, original.findings, 'Installed local Findings must match seeded geometry');
      }
    }
    stores[name] = { count: rows.length, total: value.total, content_sha256: contentHash(rows),
      ids_sha256: contentHash(rows.map(row => name === 'reports' ? row.report.id : row.id).sort()) };
  }
  stateFor(bundle).localSnapshot = result;
  return { stores, preferences: { count: Object.keys(result.preferences).length, content_sha256: contentHash(result.preferences) } };
}

export async function installHistory(page, bundle) {
  const state = stateFor(bundle);
  assert(state.seeded, 'Seed and hydrate database history before installing local history');
  assert.notEqual(new URL(page.url()).origin, 'null', 'Install history in a blank page with the app origin');
  const installed = await page.evaluate(async ({ reports, drafts, withdrawals, jpegBase64, firstLaunchSeen, jpegHash }) => {
    if (document.querySelector('main') || document.querySelector('script[src]')) throw new Error('history_install_requires_pre_app_blank_origin');
    const request = indexedDB.open('bor-czuwa', 6);
    request.onupgradeneeded = () => {
      const db = request.result;
      for (const [name, keyPath] of [['reports', 'report.id'], ['drafts', 'id'], ['home', 'id'], ['signer', 'id'], ['withdrawals', 'id']]) {
        if (!db.objectStoreNames.contains(name)) db.createObjectStore(name, { keyPath });
      }
    };
    const db = await new Promise((resolve, reject) => { request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error); request.onblocked = () => reject(new Error('history_install_blocked_by_prior_context')); });
    try {
      const raw = Uint8Array.from(atob(jpegBase64), character => character.charCodeAt(0));
      const photoHash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', raw)),
        value => value.toString(16).padStart(2, '0')).join('');
      if (photoHash !== jpegHash) throw new Error('history_photo_hash_mismatch');
      const blob = new Blob([raw], { type: 'image/jpeg' });
      const bitmap = await createImageBitmap(blob);
      const decoded = { width: bitmap.width, height: bitmap.height }; bitmap.close();
      const names = Array.from(db.objectStoreNames);
      const check = db.transaction(names, 'readonly');
      const checkDone = new Promise((resolve, reject) => { check.oncomplete = resolve; check.onerror = () => reject(check.error); });
      const counts = await Promise.all(names.map(name => new Promise((resolve, reject) => {
        const count = check.objectStore(name).count(); count.onsuccess = () => resolve(count.result); count.onerror = () => reject(count.error);
      })));
      await checkDone;
      if (counts.some(Boolean)) throw new Error('history_install_requires_fresh_empty_local_database');
      const tx = db.transaction(['reports', 'drafts', 'withdrawals'], 'readwrite');
      const done = new Promise((resolve, reject) => { tx.oncomplete = resolve; tx.onerror = () => reject(tx.error); tx.onabort = () => reject(tx.error); });
      for (const local of reports) {
        for (const photo of local.photos) photo.jpeg = blob;
        tx.objectStore('reports').add(local);
      }
      for (const draft of drafts) tx.objectStore('drafts').add(draft);
      for (const withdrawal of withdrawals) tx.objectStore('withdrawals').add(withdrawal);
      await done;
      if (firstLaunchSeen) localStorage.setItem('first-launch-seen', '1');
      else localStorage.removeItem('first-launch-seen');
      return { photo: { ...decoded, byte_length: blob.size, sha256: photoHash }, records: reports.length + drafts.length + withdrawals.length };
    } finally { db.close(); }
  }, { reports: bundle.reports.map(local => ({ ...local, photos: local.photos.map(({ jpeg, ...photo }) => photo) })),
    drafts: bundle.drafts, withdrawals: bundle.withdrawals, jpegBase64: state.jpeg.toString('base64'),
    jpegHash: hash(state.jpeg), firstLaunchSeen: state.profile.first_launch_seen });
  const inventory = await localInventory(page, bundle);
  assert.equal(inventory.stores.reports.count, state.profile.report_count);
  assert.equal(inventory.stores.drafts.count, state.profile.draft_count);
  assert.equal(inventory.stores.withdrawals.count, state.profile.withdrawal_count);
  state.localBaseline = inventory;
  bundle.identity.actual_seed_sha256 = contentHash({ inputs_sha256: bundle.identity.sha256,
    resolved_metadata_sha256: bundle.identity.resolved_metadata_sha256,
    server: state.serverBaseline.content_sha256,
    local: Object.fromEntries(['reports', 'drafts', 'withdrawals'].map(name => [name, inventory.stores[name].content_sha256])) });
  return { method: 'native-indexeddb-v6-pre-app-install', installed, identity: structuredClone(bundle.identity), local: inventory };
}

export async function inspectHistory(page, bundle, database) {
  const state = stateFor(bundle);
  assert(state.seeded && state.localBaseline && state.serverBaseline, 'Seed and install history before inspection');
  validateBundle(bundle, state.profile);
  const local = await localInventory(page, bundle);
  const server = await serverInventory(database, bundle);
  for (const name of ['reports', 'drafts', 'withdrawals']) {
    const expected = state.localBaseline.stores[name];
    assert.equal(local.stores[name].count, expected.count, `Unrelated history ${name} count changed`);
    assert.equal(local.stores[name].content_sha256, expected.content_sha256, `Unrelated history ${name} content changed`);
  }
  for (const [table] of serverTables) {
    assert.equal(server.tables[table].count, state.serverBaseline.tables[table].count, `Unrelated server ${table} count changed`);
    assert.equal(server.tables[table].content_sha256, state.serverBaseline.tables[table].content_sha256,
      `Unrelated server ${table} content changed`);
  }
  assert.deepEqual(server.source_metadata, state.serverBaseline.source_metadata,
    'History rule/snapshot/dataset provenance changed');
  const shared = { home: local.stores.home, signer: local.stores.signer, preferences: local.preferences,
    policy: 'Observed shared device state, not immutable history entities: active home/signature/settings/first-launch actions may change these stores.' };
  const sharedHash = contentHash(shared);
  const result = { profile: state.profile.id, identity: { sha256: bundle.identity.sha256,
    resolved_metadata_sha256: bundle.identity.resolved_metadata_sha256, actual_seed_sha256: bundle.identity.actual_seed_sha256 },
    worker_spatial_fixtures: structuredClone(state.spatialFixtureReceipt),
    immutable_history: true, local: Object.fromEntries(['reports', 'drafts', 'withdrawals'].map(name => [name, local.stores[name]])),
    server, shared_local_state: { ...shared, content_sha256: sharedHash,
      changed_since_previous_inspection: state.previousShared === null ? null : state.previousShared !== sharedHash },
    targets: structuredClone(bundle.targets),
    retry: bundle.identity.inputs.retry,
    methods: { local: 'All stored fields, ordered arrays, actual Blob bytes/type/size and token bytes hashed; only compact hashes leave helper',
      server: 'Every column from each seeded-ID row in report/report_event/findings/findings_job/integrity_signal/integrity_refresh/report_withdrawal hashed, including token hashes and generated IDs',
      extras: 'Total counts retain active additions; seeded IDs alone must remain immutable. No field is omitted from seeded-record hashes.',
      fixture: 'Bulk synthetic setup; Findings fixture data is not independent legal measurement or backlog-throughput evidence' } };
  state.previousShared = sharedHash;
  return result;
}

const replayTransitions = [
  'Only historical unsynced queued Reports and pending Withdrawals lose the artificial frozen-history retry boundary before app load.',
  'Queued Reports may receive one local synced event, source retry/refusal fields and API-backed Findings; all other local fields remain exact.',
  'Real Report admissions add the exact outgoing payload, proof challenge, source events and a real Findings job or its terminal result.',
  'A pending Withdrawal may retry or retire only after a matching-token tombstone and complete server deletion.',
  'Other synchronized history remains frozen; only source-derived server integrity signals and refresh jobs may change.',
  'Queued uploads, pending Findings and pending Withdrawals may remain; the real 50-per-address daily admission cap is unchanged.'
];
const replayDates = new Set(['captured_at', 'occurred_at', 'occurred_window_end', 'device_fix_at',
  'received_at', 'at', 'computed_at', 'available_at', 'requested_at', 'lease_until', 'withdrawn_at',
  'published_at', 'created_at', 'hour_start', 'expires_at']);
function replayRow(row) {
  return Object.fromEntries(Object.entries(row).map(([key, value]) =>
    [key, replayDates.has(key) && value !== null ? iso(value) : value]));
}
function sameHistory(actual, expected, message) {
  // Assertion failures must not serialize private notes, tokens, correspondence or Blob content.
  assert.equal(contentHash(actual), contentHash(expected), message);
}
function sameHistoryRows(actual, expected, message) {
  const order = rows => [...rows].sort((a, b) => canonical(a).localeCompare(canonical(b)));
  sameHistory(order(actual), order(expected), message);
}
function byId(rows, key = 'report_id') {
  const result = new Map(rows.map(row => [typeof key === 'function' ? key(row) : row[key], row]));
  assert.equal(result.size, rows.length, 'Duplicate history snapshot entity');
  return result;
}
// A tombstone belongs to one (id, token hash), so an id can have several rows (migration 016).
function tombstoneKey(id, tokenHash) { return `${id}:${tokenHash}`; }
function sortedIds(values) { return [...values].sort(); }
function replayIdentity(bundle) {
  return { sha256: bundle.identity.sha256, resolved_metadata_sha256: bundle.identity.resolved_metadata_sha256,
    actual_seed_sha256: bundle.identity.actual_seed_sha256 };
}
function findingsInventory(entries) {
  const ids = { pending: [], computed: [], outside_coverage: [], failed: [] };
  for (const [id, findings] of entries) ids[findingClass({ findings })].push(id);
  for (const list of Object.values(ids)) list.sort();
  return { counts: Object.fromEntries(Object.entries(ids).map(([status, list]) => [status, list.length])), ids };
}
async function replayServerSnapshot(database, bundle, collectIntegrityMatches = true) {
  // One SQL statement gives all tables one MVCC snapshot, including DELETE's atomic cascade
  // and the worker's Findings/event/job commit. Never use BEGIN on the runner's shared client.
  const tables = serverTables.map(([table, column]) =>
    `'${table}', (SELECT coalesce(jsonb_agg(to_jsonb(t)), '[]'::jsonb)
      FROM public.${table} t WHERE ${column} = ANY($1::uuid[]))`).join(',');
  const metadata = ['rule_set', 'geodata_snapshot', 'geodata_dataset', 'current_geodata'].map(table =>
    `'${table}', (SELECT coalesce(jsonb_agg(to_jsonb(t)), '[]'::jsonb) FROM public.${table} t)`).join(',');
  const { rows: [snapshot] } = await database.query(`WITH matches AS MATERIALIZED (
      ${collectIntegrityMatches ? `SELECT r.id AS seed_id, m.* FROM public.report r
      LEFT JOIN LATERAL public.integrity_matches(r.id) m ON true
      WHERE r.id = ANY($1::uuid[])` : `SELECT null::uuid AS seed_id, null::uuid AS report_id,
      false AS duplicate_point, false AS burst, false AS duplicate_photo WHERE false`}
    ) SELECT statement_timestamp() AS observed_at, jsonb_build_object(${tables}) AS tables,
    jsonb_build_object(${metadata}) AS metadata,
    (SELECT coalesce(jsonb_agg(to_jsonb(t)), '[]'::jsonb) FROM public.rate_counter t) AS rates,
    (SELECT count(*)::int FROM public.integrity_refresh) AS integrity_unfinished,
    (SELECT count(*)::int FROM public.integrity_refresh WHERE failed_reason IS NULL) AS integrity_pending,
    (SELECT coalesce(jsonb_agg(to_jsonb(m)), '[]'::jsonb) FROM matches m
      WHERE m.report_id = ANY($2::uuid[])) AS matches,
    (SELECT coalesce(jsonb_agg(to_jsonb(c)), '[]'::jsonb) FROM (
      SELECT seed_id AS report_id, count(*) FILTER (WHERE duplicate_point)::int AS duplicate_point_count,
        count(*) FILTER (WHERE burst)::int AS burst_count,
        count(*) FILTER (WHERE duplicate_photo)::int AS duplicate_photo_count FROM matches GROUP BY seed_id
    ) c) AS integrity_expected`, [historyIds(bundle), [...bundle.withdrawals.map(row => row.id),
    ...bundle.reports.filter(row => !row.events.some(event => event.kind === 'synced')).map(row => row.report.id)]]);
  for (const rows of Object.values(snapshot.tables)) {
    rows.sort((a, b) => canonical(a).localeCompare(canonical(b)));
  }
  for (const rows of Object.values(snapshot.metadata)) {
    rows.sort((a, b) => canonical(a).localeCompare(canonical(b)));
  }
  snapshot.observed_at = iso(snapshot.observed_at);
  return snapshot;
}

/**
 * Releases only the historical upload/delete backlog in a pre-app blank origin.
 * Returns compact baseline hashes, released IDs, separate browser/server times, and the
 * artificial-boundary claim. The generation bundle and frozen inspection baseline stay intact.
 */
export async function beginHistoryReplay(page, bundle, database) {
  const state = stateFor(bundle);
  assert(!state.replay, 'History replay already began for this seed');
  assert(!state.natural, 'Natural history and backlog replay require separate seeds');
  await ownership(database);
  const frozen = await inspectHistory(page, bundle, database);
  const originalLocal = structuredClone(state.localSnapshot);
  const originalServer = await replayServerSnapshot(database, bundle);
  for (const [table] of serverTables) assert.equal(contentHash(originalServer.tables[table]),
    state.serverBaseline.tables[table].content_sha256, `History ${table} changed before replay release`);
  const queued = bundle.reports.filter(local => !local.events.some(event => event.kind === 'synced'));
  const queuedIds = sortedIds(queued.map(local => local.report.id));
  const withdrawalIds = sortedIds(bundle.withdrawals.map(item => item.id));
  const released = await page.evaluate(async ({ queued, withdrawals, boundary }) => {
    if (document.querySelector('main') || document.querySelector('script[src]')) {
      throw new Error('history_replay_requires_pre_app_blank_origin');
    }
    const request = indexedDB.open('bor-czuwa', 6);
    const db = await new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
      request.onblocked = () => reject(new Error('history_replay_blocked_by_prior_context'));
    });
    try {
      const tx = db.transaction(['reports', 'withdrawals'], 'readwrite');
      const done = new Promise((resolve, reject) => {
        tx.oncomplete = resolve; tx.onerror = () => reject(tx.error); tx.onabort = () => reject(tx.error);
      });
      const get = (name, id) => new Promise((resolve, reject) => {
        const read = tx.objectStore(name).get(id);
        read.onsuccess = () => resolve(read.result); read.onerror = () => reject(read.error);
      });
      try {
        const reports = await Promise.all(queued.map(item => get('reports', item.id)));
        const pending = await Promise.all(withdrawals.map(item => get('withdrawals', item.id)));
        for (const [index, row] of reports.entries()) {
          const expected = queued[index];
          if (!row || row.token !== expected.token || row.report.token_sha256 !== expected.token_sha256 ||
            row.events.some(event => event.kind === 'synced') || row.findings.status !== 'pending' ||
            row.retry_at !== boundary || row.retry_reason !== 'server' || row.retry_stage !== 'report') {
            throw new Error('history_replay_invalid_queued_release');
          }
        }
        for (const [index, row] of pending.entries()) {
          if (!row || row.token !== withdrawals[index].token || row.retry_at !== boundary) {
            throw new Error('history_replay_invalid_withdrawal_release');
          }
        }
        for (const row of [...reports, ...pending]) {
          delete row.retry_at; delete row.retry_reason; delete row.retry_stage;
          tx.objectStore('report' in row ? 'reports' : 'withdrawals').put(row);
        }
      } catch (error) {
        tx.abort(); await done.catch(() => {}); throw error;
      }
      await done;
      return { browser: new Date().toISOString() };
    } finally { db.close(); }
  }, { queued: queued.map(local => ({ id: local.report.id, token: local.token, token_sha256: local.report.token_sha256 })),
    withdrawals: bundle.withdrawals.map(item => ({ id: item.id, token: item.token })),
    boundary: Date.parse(bundle.identity.inputs.retry.at) });
  const expectedLocal = structuredClone(originalLocal);
  for (const name of ['reports', 'withdrawals']) for (const row of expectedLocal.stores[name].rows) {
    if (name === 'withdrawals' || queuedIds.includes(row.report.id)) {
      delete row.retry_at; delete row.retry_reason; delete row.retry_stage;
    }
  }
  const local = await localSnapshot(page, bundle);
  for (const name of ['reports', 'drafts', 'withdrawals']) sameHistoryRows(local.stores[name].rows,
    expectedLocal.stores[name].rows, `Replay release changed unrelated local ${name} content`);
  state.replay = { originalLocal, originalServer, expectedLocal,
    queued: new Set(queuedIds), withdrawals: new Set(withdrawalIds),
    released: { queued_report_ids: queuedIds, withdrawal_ids: withdrawalIds },
    releasedAt: { browser: released.browser, server: originalServer.observed_at },
    previous: null, computed: new Map() };
  return { profile: state.profile.id, identity: replayIdentity(bundle),
    baseline: { local: frozen.local, server: frozen.server },
    released: structuredClone(state.replay.released), released_at: { ...state.replay.releasedAt },
    boundary: structuredClone(bundle.identity.inputs.retry), retained_data: true,
    allowed_transitions: [...replayTransitions] };
}

function replayTime(value, earliest, latest, message) {
  const at = Date.parse(value);
  assert(Number.isFinite(at) && at >= earliest && at <= latest, message);
}
// Server-written columns hold a minute floor, so the window starts at the floor of its start.
function replayServerTime(value, earliest, latest, message) {
  replayTime(value, Math.floor(earliest / 60_000) * 60_000, Math.floor(latest / 60_000) * 60_000, message);
}
function generatedId(value) {
  assert(/^[1-9]\d*$/.test(String(value)), 'Invalid generated history row ID');
}
function failureDetails(details) {
  const { reason, error_class, step, ...extra } = details;
  assert.equal(Object.keys(extra).length, 0, 'Unexpected Findings failure details');
  assert(['before_earliest_rule_set', 'unknown_species', 'no_geodata_snapshot',
    'snapshot_storage_unavailable', 'computation_failed'].includes(reason), 'Unknown Findings failure reason');
  if (error_class !== undefined) {
    assert(/^(?:[0-9A-Z]{5}|TypeError|RangeError|SyntaxError|Error)$/.test(error_class), 'Invalid worker failure class');
    assert(['report', 'rule_set', 'snapshot', 'dwelling', 'ambona', 'hunting_district',
      'protected_areas', 'time_findings', 'write_findings'].includes(step), 'Invalid Findings failure step');
  } else assert.equal(step, undefined, 'Failure step without an error class');
}
async function replayComputedFindings(database, bundle, snapshot, row, replay = stateFor(bundle).replay) {
  const report = bundle.reports.find(local => local.report.id === row.report_id).report;
  const source = stateFor(bundle).source;
  const dayOfOccurrence = source.warsawDate(new Date(report.occurred_at.at));
  const rule = snapshot.metadata.rule_set.filter(item => item.effective_from <= dayOfOccurrence)
    .sort((a, b) => b.effective_from.localeCompare(a.effective_from) ||
      Date.parse(b.published_at) - Date.parse(a.published_at))[0];
  const current = snapshot.metadata.current_geodata[0];
  assert.equal(snapshot.metadata.current_geodata.length, 1, 'Replay requires one installed current snapshot');
  const geodata = snapshot.metadata.geodata_snapshot.find(item => item.id === current.snapshot_id);
  assert(rule && geodata, 'Replay Findings require actual installed historical rules and geodata');
  assert.equal(row.rule_set_id, rule.id, 'Replay Findings used a different occurrence-time Rule set');
  assert.equal(row.geodata_snapshot_id, geodata.id, 'Replay Findings used a different installed snapshot');
  const outgoing = serverReport(report, row.computed_at);
  const key = contentHash({ rule: rule.id, snapshot: geodata.id, location: report.incident_location,
    accuracy: outgoing.accuracy_m, occurred: report.occurred_at, species: report.species });
  if (!replay.computed.has(key)) {
    const spatial = spatialFindings(bundle, geodata, outgoing, rule);
    const parameters = rule.parameters;
    const time = parameters.noc && parameters.species && parameters.citations
      ? source.evaluateTimeFindings(report.occurred_at, outgoing.incident_bounds
        ? { bounds: outgoing.incident_bounds } : { lat: outgoing.incident_lat, lon: outgoing.incident_lon },
      report.species, parameters)
      : { noc: { status: 'not_computed', reason: 'historical_rules_unavailable' },
        okres_ochronny: { status: 'not_computed', reason: 'historical_rules_unavailable' } };
    replay.computed.set(key, { status: 'computed', rule_set_id: rule.id, geodata_snapshot_id: geodata.id,
      snapshot_date: iso(geodata.created_at), datasets: geodata.datasets,
      accuracy_m: outgoing.incident_source === 'device_fix' ? outgoing.accuracy_m : null,
      area_bounds: outgoing.incident_bounds, ...spatial, ...time });
  }
  return replay.computed.get(key);
}
async function validateReplayAdmission(database, bundle, snapshot, id) {
  const replay = stateFor(bundle).replay;
  const rows = table => snapshot.tables[table].filter(row => row.report_id === id);
  const row = replayRow(snapshot.tables.report.find(item => item.id === id));
  const original = bundle.reports.find(local => local.report.id === id).report;
  assert(/^[a-f0-9]{64}$/.test(row.proof_challenge ?? ''), 'Replay admission needs a real proof challenge');
  const received = Date.parse(row.received_at);
  replayTime(row.received_at, Math.floor(Date.parse(replay.releasedAt.server) / 60_000) * 60_000,
    Date.parse(snapshot.observed_at), 'Replay admission has an invalid actual receive time');
  assert.equal(received % 60_000, 0, 'Replay receive time must retain source minute precision');
  sameHistory(row, { ...serverReport(original, row.received_at), proof_challenge: row.proof_challenge },
    'Replay server Report differs from exact outgoing Report payload or source defaults');
  const prior = replay.previous?.server.tables.report.find(item => item.id === id);
  if (prior) sameHistory(row, replayRow(prior), 'An admitted history Report changed');
  const events = rows('report_event').map(replayRow);
  for (const event of events) generatedId(event.id);
  const created = events.filter(event => event.kind === 'created');
  const synced = events.filter(event => event.kind === 'synced');
  assert.equal(created.length, 1, 'Admission must retain one real created event');
  assert.equal(synced.length, 1, 'Admission must retain one real synced event');
  sameHistory(created[0], { id: created[0].id, report_id: id, kind: 'created',
    at: iso(original.captured_at), details: { privacy_policy_version: original.privacy_policy_version,
      terms_of_use_version: original.terms_of_use_version }, event_id: null }, 'Invalid admission created event');
  sameHistory(synced[0], { id: synced[0].id, report_id: id, kind: 'synced', at: row.received_at,
    details: {}, event_id: null }, 'Invalid admission synced event');
  return validateHistoryWorker(database, bundle, snapshot, id, replay,
    events.filter(event => !['created', 'synced'].includes(event.kind)));
}
async function validateHistoryWorker(database, bundle, snapshot, id, replay, diagnostics) {
  const rows = table => snapshot.tables[table].filter(row => row.report_id === id);
  const findings = rows('findings').map(replayRow);
  const jobs = rows('findings_job').map(replayRow);
  for (const event of diagnostics) generatedId(event.id);
  assert(findings.length <= 1 && jobs.length <= 1 && diagnostics.length <= 1, 'Unexpected replay worker rows');
  let result;
  if (findings.length) {
    assert.equal(jobs.length, 0, 'Computed Findings must retire their real job');
    const finding = findings[0];
    generatedId(finding.id);
    replayServerTime(finding.computed_at, Date.parse(replay.releasedAt.server), Date.parse(snapshot.observed_at),
      'Replay Findings have an invalid actual diagnostic time');
    result = await replayComputedFindings(database, bundle, snapshot, finding, replay);
    const { status, snapshot_date, datasets, ...stored } = result;
    sameHistory(finding, { id: finding.id, report_id: id, ...stored, shape_version: 2, computed_at: finding.computed_at },
      'Replay Findings differ from actual worker geometry, time or provenance contract');
    assert.equal(diagnostics.length, 1, 'Computed Findings need their real diagnostic event');
    sameHistory(diagnostics[0], { id: diagnostics[0].id, report_id: id, kind: 'findings_computed',
      at: finding.computed_at, details: {}, event_id: null }, 'Invalid computed Findings event');
  } else {
    assert.equal(jobs.length, 1, 'Every pending/failed admission needs its real Findings job');
    const job = jobs[0];
    assert(Number.isSafeInteger(job.attempts) && job.attempts >= 0 && job.attempts <= 3,
      'Invalid Findings retry attempts');
    replayTime(job.available_at, Date.parse(replay.releasedAt.server), Date.parse(snapshot.observed_at) + 8_000,
      'Invalid source Findings job availability');
    for (const [field, table] of [['rule_set_id', 'rule_set'], ['geodata_snapshot_id', 'geodata_snapshot']]) {
      assert(job[field] === null || snapshot.metadata[table].some(item => item.id === job[field]),
        'Findings job references unknown provenance');
    }
    sameHistory(Object.keys(job).sort(), ['report_id', 'attempts', 'available_at', 'failed_reason',
      'rule_set_id', 'geodata_snapshot_id'].sort(), 'Unexpected Findings job fields');
    if (job.failed_reason) {
      assert.equal(diagnostics.length, 1, 'Failed Findings need their terminal diagnostic');
      const diagnostic = diagnostics[0];
      assert.equal(diagnostic.kind, 'findings_failed', 'Unexpected Findings terminal event');
      failureDetails(diagnostic.details);
      assert.equal(diagnostic.details.reason, job.failed_reason, 'Failed job and diagnostic reason differ');
      replayServerTime(diagnostic.at, Date.parse(replay.releasedAt.server), Date.parse(snapshot.observed_at),
        'Invalid actual Findings failure time');
      sameHistory(diagnostic, { id: diagnostic.id, report_id: id, kind: 'findings_failed',
        at: diagnostic.at, details: diagnostic.details, event_id: null }, 'Unexpected failure event fields');
      result = { status: 'failed', reason: job.failed_reason };
    } else {
      assert.equal(diagnostics.length, 0, 'Pending Findings cannot have terminal diagnostics');
      result = { status: 'pending' };
    }
  }
  if (replay.previous) {
    for (const table of ['report_event', 'findings']) for (const previous of replay.previous.server.tables[table]
      .filter(item => item.report_id === id)) {
      const current = rows(table).find(item => item.id === previous.id);
      assert(current, 'Committed history worker rows disappeared');
      sameHistory(current, previous, 'Committed history worker rows changed');
    }
    const previousJob = replay.previous.server.tables.findings_job.find(item => item.report_id === id);
    if (previousJob && jobs.length) {
      assert(jobs[0].attempts >= previousJob.attempts, 'Findings retry attempts regressed');
      assert(Date.parse(jobs[0].available_at) >= Date.parse(previousJob.available_at), 'Findings availability moved backwards');
      for (const field of ['rule_set_id', 'geodata_snapshot_id']) if (previousJob[field] !== null) {
        assert.equal(jobs[0][field], previousJob[field], 'Pinned Findings job provenance changed');
      }
      if (previousJob.failed_reason) sameHistory(jobs[0], replayRow(previousJob), 'Terminal Findings job changed');
    }
  }
  return result;
}

// A refresh can commit between admissions or deletions that a poll did not observe.
// Check an exact integer subset of known matching candidate vectors, not arbitrary ranges.
function possibleIntegrityCounts(target, fixed, optional) {
  const wanted = target.map((value, index) => value - fixed[index]);
  if (wanted.some(value => !Number.isSafeInteger(value) || value < 0)) return false;
  const groups = Array(8).fill(0);
  for (const vector of optional) groups[vector[0] * 4 + vector[1] * 2 + vector[2]]++;
  const [x, y, z] = wanted;
  for (let abc = 0; abc <= Math.min(groups[7], x, y, z); abc++) {
    for (let ab = 0; ab <= Math.min(groups[6], x - abc, y - abc); ab++) {
      const acLow = Math.max(0, x - abc - ab - groups[4]);
      const acHigh = Math.min(groups[5], x - abc - ab);
      const bcLow = Math.max(0, y - abc - ab - groups[2]);
      const bcHigh = Math.min(groups[3], y - abc - ab);
      if (acLow <= acHigh && bcLow <= bcHigh &&
        Math.max(acLow + bcLow, z - abc - groups[1]) <= Math.min(acHigh + bcHigh, z - abc)) return true;
    }
  }
  return false;
}
function validateReplayIntegrity(snapshot, replay, reports) {
  const columns = ['duplicate_point_count', 'burst_count', 'duplicate_photo_count'];
  const vector = row => [Number(row.duplicate_point), Number(row.burst), Number(row.duplicate_photo)];
  const initialReports = byId(replay.originalServer.tables.report, 'id');
  const initialSignals = byId(replay.originalServer.tables.integrity_signal);
  const signals = byId(snapshot.tables.integrity_signal);
  const expected = byId(snapshot.integrity_expected);
  const initialExpected = byId(replay.originalServer.integrity_expected);
  const refreshes = byId(snapshot.tables.integrity_refresh);
  const changed = new Set([...replay.queued].filter(id => reports.has(id)));
  for (const id of replay.withdrawals) if (!reports.has(id)) changed.add(id);
  const indexMatches = source => {
    const index = new Map();
    for (const row of source.matches) {
      if (!index.has(row.seed_id)) index.set(row.seed_id, new Map());
      index.get(row.seed_id).set(row.report_id, row);
    }
    return index;
  };
  const initialMatches = indexMatches(replay.originalServer);
  const currentMatches = indexMatches(snapshot);
  const affected = new Set(changed);
  for (const id of reports.keys()) {
    const before = initialMatches.get(id) ?? new Map();
    const current = currentMatches.get(id) ?? new Map();
    const reference = initialReports.has(id) ? before : current;
    const counts = initialReports.has(id) ? initialExpected.get(id) : expected.get(id);
    const fixed = columns.map(column => counts[column]);
    for (const row of reference.values()) vector(row).forEach((value, index) => { fixed[index] -= value; });
    const optional = [];
    for (const candidate of new Set([...before.keys(), ...current.keys()])) {
      const was = before.get(candidate);
      const now = current.get(candidate);
      if (was && now) sameHistory(vector(now), vector(was), 'Immutable history integrity match changed');
      const always = was && now || !initialReports.has(id) && now && (initialReports.has(candidate) || candidate === id);
      if (always) vector(now).forEach((value, index) => { fixed[index] += value; });
      else optional.push(vector(now ?? was));
      if (changed.has(candidate)) affected.add(id);
    }
    const signal = signals.get(id);
    const original = initialSignals.get(id);
    if (!signal) {
      assert(!original && replay.queued.has(id) && refreshes.has(id) && refreshes.get(id).expand_neighbors,
        'History integrity signal disappeared without a pending first refresh');
      assert(!replay.previous?.server.tables.integrity_signal.some(row => row.report_id === id),
        'A previously committed integrity signal disappeared');
      continue;
    }
    sameHistory(Object.keys(signal).sort(), ['report_id', 'over_limit_hour', 'over_limit_day', ...columns].sort(),
      'Unexpected integrity signal fields');
    if (original) {
      sameHistory([signal.over_limit_hour, signal.over_limit_day], [original.over_limit_hour, original.over_limit_day],
        'Frozen admission quota diagnostics changed');
    } else {
      for (const [field, threshold] of [['over_limit_hour', 5], ['over_limit_day', 15]]) {
        assert(signal[field] === null || Number.isSafeInteger(signal[field]) &&
          signal[field] > threshold && signal[field] <= 50, 'Invalid real admission quota diagnostic');
      }
    }
    const previousSignal = replay.previous?.server.tables.integrity_signal.find(row => row.report_id === id);
    if (previousSignal) sameHistory([signal.over_limit_hour, signal.over_limit_day],
      [previousSignal.over_limit_hour, previousSignal.over_limit_day], 'Admission quota diagnostics changed after commit');
    const actual = columns.map(column => signal[column]);
    assert(actual.every(value => Number.isSafeInteger(value) && value >= 0), 'Invalid integrity counts');
    const quotaOnlyAdmission = !original && actual.every(value => value === 0) &&
      (signal.over_limit_hour !== null || signal.over_limit_day !== null) && refreshes.get(id)?.expand_neighbors;
    if (quotaOnlyAdmission) continue;
    if (snapshot.integrity_unfinished === 0) {
      sameHistory(actual, columns.map(column => expected.get(id)[column]), 'Settled history integrity differs from real matches');
    } else {
      assert(possibleIntegrityCounts(actual, fixed, optional),
        'History integrity counts cannot derive from any observed admission/deletion phase');
    }
  }
  for (const raw of snapshot.tables.integrity_refresh) {
    const row = replayRow(raw);
    assert(reports.has(row.report_id) && affected.has(row.report_id), 'Unexpected history integrity refresh target');
    sameHistory(Object.keys(row).sort(), ['report_id', 'requested_at', 'available_at', 'attempts',
      'failed_reason', 'expand_neighbors', 'generation', 'lease_until', 'error_class', 'failure_step'].sort(),
    'Unexpected integrity refresh fields');
    assert(Number.isSafeInteger(row.attempts) && row.attempts >= 0 && row.attempts <= 4, 'Invalid integrity refresh attempts');
    assert(/^[1-9]\d*$/.test(String(row.generation)), 'Invalid integrity refresh generation');
    assert.equal(typeof row.expand_neighbors, 'boolean');
    if (row.expand_neighbors) assert(replay.queued.has(row.report_id), 'Only admissions expand integrity neighbors');
    replayTime(row.requested_at, Date.parse(replay.releasedAt.server), Date.parse(snapshot.observed_at),
      'Invalid actual integrity request time');
    replayTime(row.available_at, Date.parse(replay.releasedAt.server), Date.parse(snapshot.observed_at) + 64_000,
      'Invalid source integrity retry time');
    if (row.lease_until !== null) replayTime(row.lease_until, Date.parse(replay.releasedAt.server),
      Date.parse(snapshot.observed_at) + 60_000, 'Invalid integrity worker lease');
    assert(row.failed_reason === null || row.failed_reason === 'refresh_failed' && row.attempts === 4,
      'Invalid terminal integrity refresh state');
    if (row.error_class !== null) {
      assert(/^(?:[0-9A-Z]{5}|TypeError|RangeError|SyntaxError|Error)$/.test(row.error_class), 'Invalid integrity failure class');
      assert(['compute_signals', 'delete_refresh', 'queue_neighbors'].includes(row.failure_step), 'Invalid integrity failure step');
    } else assert.equal(row.failure_step, null, 'Integrity failure step without failure class');
  }
}

function validateReplayLocal(local, server, bundle, serverFindings) {
  const replay = stateFor(bundle).replay;
  const reports = byId(local.stores.reports.rows, row => row.report.id);
  const expected = byId(replay.expectedLocal.stores.reports.rows, row => row.report.id);
  sameHistory(sortedIds(reports.keys()), sortedIds(expected.keys()), 'Historical local Report IDs changed');
  sameHistoryRows(local.stores.drafts.rows, replay.expectedLocal.stores.drafts.rows, 'Historical drafts changed');
  const serverReports = byId(server.tables.report, 'id');
  const queuedIds = [], syncedIds = [], rateLimited = [], refusedIds = [], findingsAhead = [];
  for (const [id, row] of reports) {
    const original = expected.get(id);
    if (!replay.queued.has(id)) {
      sameHistory(row, original, 'Frozen synchronized history or its private content changed');
    } else {
      const { events, findings, retry_at, retry_reason, retry_stage, sync_error, refused_version, ...immutable } = row;
      const { events: oldEvents, findings: oldFindings, ...oldImmutable } = original;
      sameHistory(immutable, oldImmutable, 'Queued history payload/token/private content/Notice/activity changed');
      const synced = events.filter(event => event.kind === 'synced');
      assert(synced.length <= 1, 'Queued history acquired duplicate synced events');
      sameHistory(events.filter(event => event.kind !== 'synced'), oldEvents, 'Historical original events changed');
      if (synced.length) {
        sameHistory(events, [...oldEvents, synced[0]], 'Synced event must append after original history events');
        sameHistory(Object.keys(synced[0]).sort(), ['at', 'kind'], 'Unexpected local synced event fields');
        replayTime(synced[0].at, Date.parse(replay.releasedAt.browser), Date.parse(local.observed_at),
          'Invalid local replay synced time');
        assert(serverReports.has(id), 'Locally synced historical Report lacks a committed server admission');
      }
      if (retry_at !== undefined) {
        assert(Number.isSafeInteger(retry_at), 'Invalid local replay retry time');
        assert(['network', 'server', 'rate_limit'].includes(retry_reason), 'Invalid source replay retry reason');
        assert(['report', 'findings'].includes(retry_stage), 'Unexpected replay retry stage');
        assert(!synced.length || retry_stage === 'findings', 'Synced replay Report cannot retry its upload');
        assert(retry_stage !== 'findings' || synced.length, 'Unuploaded replay Report cannot retry Findings');
        const maximum = retry_reason === 'rate_limit' ? 27 * 60 * 60_000 : 30_000;
        assert(retry_at >= Date.parse(replay.releasedAt.browser) && retry_at <= Date.parse(local.observed_at) + maximum,
          'Replay retry exceeds actual source backoff/Retry-After contract');
        assert.equal(sync_error, undefined, 'Retry cannot retain a terminal sync refusal');
      } else assert(retry_reason === undefined && retry_stage === undefined, 'Replay retry details lack a retry time');
      if (sync_error !== undefined) {
        assert(['validation_refused', 'server_refused'].includes(sync_error) && !synced.length,
          'Unexpected replay refusal state');
        assert.equal(typeof refused_version, 'string', 'Refusal lacks source app version');
        assert.equal(retry_at, undefined, 'Refusal cannot retain retry state');
      } else assert.equal(refused_version, undefined, 'Refused version lacks a refusal');
      if (findings.status === 'pending') {
        sameHistory(findings, oldFindings, 'Pending local replay Findings changed shape');
        if (serverFindings.has(id) && serverFindings.get(id).status !== 'pending') findingsAhead.push(id);
      } else {
        assert(synced.length && serverFindings.has(id), 'Local terminal Findings lack real synced server context');
        sameHistory(findings, serverFindings.get(id), 'Local replay Findings differ from actual API result');
      }
      if (replay.previous) {
        const prior = replay.previous.local.stores.reports.rows.find(item => item.report.id === id);
        if (prior.events.some(event => event.kind === 'synced')) {
          sameHistory(events, prior.events, 'Replay local synced event regressed or changed');
        }
        if (prior.findings.status !== 'pending') sameHistory(findings, prior.findings, 'Terminal local Findings changed');
        if (prior.sync_error !== undefined) sameHistory([sync_error, refused_version],
          [prior.sync_error, prior.refused_version], 'Terminal local upload refusal changed');
      }
    }
    (row.events.some(event => event.kind === 'synced') ? syncedIds : queuedIds).push(id);
    if (row.retry_reason === 'rate_limit') rateLimited.push({ id, retry_at: row.retry_at,
      retry_reason: row.retry_reason, retry_stage: row.retry_stage });
    if (row.sync_error) refusedIds.push(id);
  }
  const withdrawals = byId(local.stores.withdrawals.rows, 'id');
  const originalWithdrawals = byId(replay.expectedLocal.stores.withdrawals.rows, 'id');
  const tombstones = byId(server.tables.report_withdrawal, row => tombstoneKey(row.id, row.token_sha256));
  const withdrawalRetries = [];
  for (const [id, row] of withdrawals) {
    assert(originalWithdrawals.has(id), 'Unexpected historical local Withdrawal');
    const { retry_at, ...immutable } = row;
    sameHistory(immutable, originalWithdrawals.get(id), 'Pending Withdrawal ID/token/original time changed');
    if (retry_at !== undefined) {
      assert(Number.isSafeInteger(retry_at) && retry_at >= Date.parse(replay.releasedAt.browser) &&
        retry_at <= Date.parse(local.observed_at) + 27 * 60 * 60_000, 'Invalid source Withdrawal retry time');
      withdrawalRetries.push({ id, retry_at });
    }
    if (replay.previous) assert(replay.previous.local.stores.withdrawals.rows.some(item => item.id === id),
      'Retired local Withdrawal reappeared');
  }
  for (const [id, row] of originalWithdrawals) if (!withdrawals.has(id)) {
    assert(tombstones.has(tombstoneKey(id, hash(row.token))) && !serverReports.has(id),
      'Local Withdrawal retired before a real server DELETE with its own token');
  }
  return { queued_ids: queuedIds.sort(), synced_ids: syncedIds.sort(),
    withdrawal_ids: sortedIds(withdrawals.keys()), rate_limited: rateLimited.sort((a, b) => a.id.localeCompare(b.id)),
    withdrawal_retries: withdrawalRetries.sort((a, b) => a.id.localeCompare(b.id)),
    findings: findingsInventory([...reports].map(([id, row]) => [id, row.findings])),
    refused_ids: refusedIds.sort(), findingsAhead: findingsAhead.sort() };
}

function replayRateCounters(snapshot, replay) {
  const previous = replay.previous?.server ?? replay.originalServer;
  const rates = byId(snapshot.rates, 'ip_hash');
  for (const row of snapshot.rates) {
    assert(Number.isSafeInteger(row.daily_count) && row.daily_count >= 1 && row.daily_count <= 50,
      'Actual daily admission counter exceeds unchanged 50-per-address limit');
    assert(Number.isSafeInteger(row.hourly_count) && row.hourly_count >= 1 && row.hourly_count <= row.daily_count,
      'Invalid actual hourly admission counter');
    replayTime(row.hour_start, 0, Date.parse(snapshot.observed_at), 'Invalid actual counter hour');
    assert(Number.isFinite(Date.parse(row.expires_at)) && Date.parse(row.expires_at) > Date.parse(row.hour_start),
      'Invalid actual counter expiry');
    sameHistory(Object.keys(row).sort(), ['ip_hash', 'daily_count', 'hourly_count', 'hour_start', 'expires_at'].sort(),
      'Unexpected quota counter fields');
  }
  for (const before of previous.rates) {
    const row = rates.get(before.ip_hash);
    if (!row) assert(Date.parse(before.expires_at) <= Date.parse(snapshot.observed_at),
      'An unexpired quota counter disappeared during replay');
    else {
      assert(row.daily_count >= before.daily_count, 'Quota was reset inside a replay case');
      sameHistory(row.expires_at, before.expires_at, 'Existing quota counter expiry changed');
      if (row.hour_start === before.hour_start) assert(row.hourly_count >= before.hourly_count,
        'Hourly quota was reset inside a replay case');
      else assert(Date.parse(row.hour_start) > Date.parse(before.hour_start), 'Quota hour moved backwards');
    }
  }
  const rows = snapshot.rates.map(({ daily_count, hourly_count, hour_start, expires_at }) =>
    ({ daily_count, hourly_count, hour_start: iso(hour_start), expires_at: iso(expires_at) }))
    .sort((a, b) => canonical(a).localeCompare(canonical(b)));
  return { maximum_per_address_per_day: 50, scope: 'All persisted anonymous scopes; salted keys do not expose scope/address attribution',
    rows, total_daily: rows.reduce((sum, row) => sum + row.daily_count, 0),
    total_hourly: rows.reduce((sum, row) => sum + row.hourly_count, 0) };
}

/**
 * Pollable, assertion-backed replay inventory. Local IDB is read atomically BEFORE the single
 * server MVCC snapshot: a real server commit may lead its local acknowledgement, never vice versa.
 * Arrays contain historical IDs only. Findings buckets include all retained historical Reports.
 * queued_report_ids contains admitted IDs from the released upload backlog, not frozen Reports.
 * No raw Report payload, note, correspondence, token, address key or Blob bytes leave this API.
 * Findings = {counts:{pending,computed,outside_coverage,failed}, ids:{pending:[],computed:[],
 * outside_coverage:[],failed:[]}}. local queued_ids/synced_ids include ALL historical Reports.
 * Withdrawal retries carry only retry_at because the actual local-store contract stores no reason.
 * rate_counters.rows exposes daily_count/hourly_count/hour_start/expires_at, never salted keys.
 * Inspect sequentially per bundle. Pending worker/refusal states remain observable, not successes.
 */
export async function inspectHistoryReplay(page, bundle, database) {
  const state = stateFor(bundle);
  const replay = state.replay;
  assert(replay, 'Begin history replay before replay inspection');
  validateBundle(bundle, state.profile);
  const local = await localSnapshot(page, bundle);
  const server = await replayServerSnapshot(database, bundle);
  sameHistory(server.metadata, replay.originalServer.metadata, 'Replay rule/snapshot/dataset provenance changed');
  const reports = byId(server.tables.report, 'id');
  const originals = byId(replay.originalServer.tables.report, 'id');
  const tombstones = byId(server.tables.report_withdrawal, row => tombstoneKey(row.id, row.token_sha256));
  const retained = new Set(bundle.reports.map(row => row.report.id));
  const allServerIds = new Set([...retained, ...replay.withdrawals]);
  for (const [id] of reports) assert(allServerIds.has(id), 'A draft or unexpected history ID became a server Report');
  for (const [table, column] of serverTables) {
    if (table === 'report' || table === 'report_withdrawal') continue;
    for (const row of server.tables[table]) assert(reports.has(row[column]),
      'History child row survived without its server Report');
  }
  const retiredWithdrawals = [], pendingWithdrawals = [];
  for (const id of replay.withdrawals) {
    const withdrawal = bundle.withdrawals.find(item => item.id === id);
    const row = tombstones.get(tombstoneKey(id, hash(withdrawal.token)));
    if (row) {
      replayServerTime(row.withdrawn_at, Date.parse(replay.releasedAt.server), Date.parse(server.observed_at),
        'Invalid real Withdrawal tombstone time');
      sameHistory(replayRow(row), { id, token_sha256: hash(withdrawal.token), withdrawn_at: iso(row.withdrawn_at) },
        'Unexpected Withdrawal tombstone fields');
      assert(!reports.has(id), 'Acknowledged Withdrawal still has a server Report');
      retiredWithdrawals.push(id);
      const previous = replay.previous?.server.tables.report_withdrawal.find(item => item.id === id && item.token_sha256 === row.token_sha256);
      if (previous) sameHistory(row, previous, 'Acknowledged Withdrawal tombstone changed');
    } else {
      assert(reports.has(id), 'Pending Withdrawal lost server Report without a real tombstone');
      pendingWithdrawals.push(id);
    }
  }
  for (const row of tombstones.values()) {
    assert(replay.withdrawals.has(row.id), 'Unexpected historical Withdrawal tombstone');
    const withdrawal = bundle.withdrawals.find(item => item.id === row.id);
    assert.equal(row.token_sha256, hash(withdrawal.token), 'Server Withdrawal tombstone has a different token');
  }
  if (replay.previous) for (const row of replay.previous.server.tables.report_withdrawal) {
    assert(tombstones.has(tombstoneKey(row.id, row.token_sha256)), 'Acknowledged Withdrawal tombstone disappeared');
  }
  for (const table of ['report', 'report_event', 'findings', 'findings_job']) {
    const key = table === 'report' ? 'id' : 'report_id';
    const frozen = row => originals.has(row[key]) && (!replay.withdrawals.has(row[key]) || reports.has(row[key]));
    sameHistoryRows(server.tables[table].filter(frozen), replay.originalServer.tables[table].filter(frozen),
      `Frozen synchronized/pending-Withdrawal server ${table} changed`);
  }
  const serverFindings = new Map(bundle.reports.filter(row => !replay.queued.has(row.report.id))
    .map(row => [row.report.id, row.findings]));
  const admitted = [];
  for (const id of replay.queued) {
    if (reports.has(id)) {
      admitted.push(id);
      serverFindings.set(id, await validateReplayAdmission(database, bundle, server, id));
    } else {
      assert(!replay.previous?.server.tables.report.some(row => row.id === id), 'A committed queued Report disappeared');
    }
  }
  validateReplayIntegrity(server, replay, reports);
  const rateCounters = replayRateCounters(server, replay);
  const localState = validateReplayLocal(local, server, bundle, serverFindings);
  const { findingsAhead, ...localResult } = localState;
  const result = { profile: state.profile.id, identity: replayIdentity(bundle),
    empty_history: state.profile.id === 'H00',
    boundary: structuredClone(bundle.identity.inputs.retry), released: structuredClone(replay.released),
    released_at: { ...replay.releasedAt }, observed_at: { local: local.observed_at, server: server.observed_at },
    assertions: { immutable_payloads_and_private_content: true, frozen_synchronized_history: true,
      exact_admission_contract: true, actual_findings_contract: true, token_backed_delete_retirement: true,
      source_integrity_transitions: true, no_quota_reset: true,
      coherence: 'Atomic local snapshot precedes one server MVCC snapshot; only server-ahead lifecycle phases are allowed' },
    local: localResult,
    server: { queued_report_ids: admitted.sort(), retired_withdrawal_ids: retiredWithdrawals.sort(),
      pending_withdrawal_ids: pendingWithdrawals.sort(), findings: findingsInventory(serverFindings),
      rate_counters: rateCounters, integrity: { queued: server.integrity_pending,
        terminal: server.integrity_unfinished - server.integrity_pending } },
    in_flight: {
      server_committed_local_queued_ids: admitted.filter(id => localState.queued_ids.includes(id)).sort(),
      server_deleted_local_pending_withdrawal_ids: retiredWithdrawals.filter(id => localState.withdrawal_ids.includes(id)).sort(),
      server_findings_ahead_ids: findingsAhead },
    retained_data: true, allowed_transitions: [...replayTransitions] };
  replay.previous = { local, server };
  return result;
}

const naturalVersion = 'faza6-natural-history-1.3.0';
const naturalTransitions = [
  'Only synchronized historical Reports lose retry_at/retry_reason/retry_stage, atomically before app load.',
  'Only the synchronized pending subset receives real findings_job rows with source defaults; real workers own every subsequent transition.',
  'Original Reports, tokens, private content, photos, Notices, outcomes, events and activity dates remain exact.',
  'Only activated pending Findings, their worker jobs/diagnostics and source Findings retry metadata may change.',
  'Terminal local Findings and events remain exact; authenticated GET /api/reports/:id/findings presence retries remain in memory.',
  'Queued Reports, Withdrawals and historical Drafts remain frozen. No upload, deletion, quota reset or forced completion is permitted.'
];
function naturalServerInventory(snapshot) {
  return Object.fromEntries(Object.entries(snapshot.tables).map(([name, rows]) => [name, {
    count: rows.length, content_sha256: contentHash(rows),
    ids_sha256: contentHash(sortedIds(rows.map(row => row.id ?? row.report_id)))
  }]));
}
function naturalSharedState(local, previous) {
  const store = name => {
    const value = local.stores[name];
    const rows = [...value.rows].sort((a, b) => canonical(a).localeCompare(canonical(b)));
    return { count: rows.length, total: value.total, content_sha256: contentHash(rows),
      ids_sha256: contentHash(sortedIds(rows.map(row => row.id))) };
  };
  const shared = { home: store('home'), signer: store('signer'),
    preferences: { count: Object.keys(local.preferences).length, content_sha256: contentHash(local.preferences) },
    policy: 'Observed shared device state, not immutable history entities: active home/signature/settings/first-launch actions may change these stores.' };
  const digest = contentHash(shared);
  return { ...shared, content_sha256: digest,
    changed_since_previous_inspection: previous === null ? null : previous !== digest };
}

/**
 * Releases synchronized history only. The original generation bundle, seed identity and frozen
 * baselines remain unchanged. The blank origin releases local retries in one IDB transaction;
 * real worker jobs become visible only after that release and its exact-content assertions.
 */
export async function beginNaturalHistory(page, bundle, database) {
  const state = stateFor(bundle);
  assert(!state.natural && !state.replay, 'Natural history requires a fresh seed without another release');
  await ownership(database);
  const frozen = await inspectHistory(page, bundle, database);
  const originalLocal = structuredClone(state.localSnapshot);
  const originalServer = await replayServerSnapshot(database, bundle, false);
  for (const [table] of serverTables) assert.equal(contentHash(originalServer.tables[table]),
    state.serverBaseline.tables[table].content_sha256, `History ${table} changed before natural release`);
  const synchronized = bundle.reports.filter(local => local.events.some(event => event.kind === 'synced'));
  const pendingIds = sortedIds(synchronized.filter(local => local.findings.status === 'pending').map(local => local.report.id));
  const terminalIds = sortedIds(synchronized.filter(local => local.findings.status !== 'pending').map(local => local.report.id));
  const synchronizedIds = sortedIds(synchronized.map(local => local.report.id));
  const pending = new Set(pendingIds);
  for (const table of ['findings', 'findings_job']) assert(!originalServer.tables[table].some(row => pending.has(row.report_id)),
    'Natural pending history must have neither an existing Findings row nor an existing job');
  assert(!originalServer.tables.report_event.some(row => pending.has(row.report_id) &&
    ['findings_computed', 'findings_failed'].includes(row.kind)), 'Natural pending history already has a diagnostic');
  const expectedLocal = structuredClone(originalLocal);
  for (const row of expectedLocal.stores.reports.rows) if (synchronizedIds.includes(row.report.id)) {
    delete row.retry_at; delete row.retry_reason; delete row.retry_stage;
  }
  let released, local, activatedJobs, activationServer, serverAt;
  await database.query('BEGIN');
  try {
    const locked = await database.query('SELECT to_jsonb(r) AS row FROM public.report r WHERE id = ANY($1::uuid[]) FOR UPDATE',
      [pendingIds]);
    sameHistoryRows(locked.rows.map(item => item.row), originalServer.tables.report.filter(row => pending.has(row.id)),
      'Natural activation requires the exact original server Reports');
    for (const table of ['findings', 'findings_job']) {
      const existing = await database.query(`SELECT count(*)::int AS n FROM public.${table} WHERE report_id = ANY($1::uuid[])`,
        [pendingIds]);
      assert.equal(existing.rows[0].n, 0, 'Natural activation cannot replace existing Findings or jobs');
    }
    serverAt = iso((await database.query('SELECT transaction_timestamp() AS at')).rows[0].at);
    const inserted = await database.query(`INSERT INTO public.findings_job (report_id)
      SELECT id FROM unnest($1::uuid[]) AS pending(id) RETURNING *`, [pendingIds]);
    activatedJobs = inserted.rows.map(replayRow).sort((a, b) => a.report_id.localeCompare(b.report_id));
    sameHistoryRows(activatedJobs, pendingIds.map(report_id => ({ report_id, attempts: 0, available_at: serverAt,
      failed_reason: null, rule_set_id: null, geodata_snapshot_id: null })),
    'Natural activation must use only the real findings_job defaults');
    released = await page.evaluate(async ({ reports, boundary }) => {
      if (document.querySelector('main') || document.querySelector('script[src]')) {
        throw new Error('natural_history_requires_pre_app_blank_origin');
      }
      const request = indexedDB.open('bor-czuwa', 6);
      const db = await new Promise((resolve, reject) => {
        request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
        request.onblocked = () => reject(new Error('natural_history_blocked_by_prior_context'));
      });
      try {
        const tx = db.transaction('reports', 'readwrite');
        const done = new Promise((resolve, reject) => {
          tx.oncomplete = resolve; tx.onerror = () => reject(tx.error); tx.onabort = () => reject(tx.error);
        });
        try {
          const rows = await Promise.all(reports.map(expected => new Promise((resolve, reject) => {
            const read = tx.objectStore('reports').get(expected.id);
            read.onsuccess = () => resolve(read.result); read.onerror = () => reject(read.error);
          })));
          for (const [index, row] of rows.entries()) {
            const expected = reports[index];
            if (!row || row.token !== expected.token || row.report.token_sha256 !== expected.token_sha256 ||
              !row.events.some(event => event.kind === 'synced') || row.findings.status !== expected.status ||
              row.retry_at !== boundary || row.retry_reason !== 'server' || row.retry_stage !== 'findings') {
              throw new Error('natural_history_invalid_synchronized_release');
            }
          }
          for (const row of rows) {
            delete row.retry_at; delete row.retry_reason; delete row.retry_stage;
            tx.objectStore('reports').put(row);
          }
        } catch (error) {
          tx.abort(); await done.catch(() => {}); throw error;
        }
        await done;
        return { browser: new Date().toISOString() };
      } finally { db.close(); }
    }, { reports: synchronized.map(row => ({ id: row.report.id, token: row.token,
      token_sha256: row.report.token_sha256, status: row.findings.status })),
    boundary: Date.parse(bundle.identity.inputs.retry.at) });
    local = await localSnapshot(page, bundle);
    sameHistory(Object.keys(local.stores).sort(), Object.keys(expectedLocal.stores).sort(),
      'Natural release changed local store names');
    for (const name of Object.keys(expectedLocal.stores)) sameHistoryRows(local.stores[name].rows,
      expectedLocal.stores[name].rows, `Natural release changed unrelated local ${name} content`);
    sameHistory(local.preferences, originalLocal.preferences, 'Natural release changed shared preferences');
    activationServer = await replayServerSnapshot(database, bundle, false);
    for (const [table] of serverTables) {
      const expected = table === 'findings_job' ? [...originalServer.tables[table], ...activatedJobs] : originalServer.tables[table];
      sameHistoryRows(activationServer.tables[table].map(replayRow), expected.map(replayRow),
        `Natural activation changed unrelated server ${table} content`);
    }
    sameHistory(activationServer.metadata, originalServer.metadata, 'Natural activation changed installed provenance');
    await database.query('COMMIT');
  } catch (error) {
    await database.query('ROLLBACK');
    throw error;
  }
  const activation = {
    before: naturalServerInventory(originalServer),
    after: naturalServerInventory(activationServer),
    jobs: activatedJobs,
    method: 'INSERT findings_job(report_id) with real database defaults; no terminal jobs replaced'
  };
  const boundary = { ...structuredClone(bundle.identity.inputs.retry),
    common_boundary: true, released_scope: 'synchronized-reports-only',
    retained_scope: 'queued-reports-and-withdrawals',
    policy: 'The common artificial fixture boundary is removed only from synchronized local Reports; queued Reports and Withdrawals retain it exactly.' };
  const naturalIdentity = { version: naturalVersion, source_sha256: hash(await readFile(new URL(import.meta.url))) };
  naturalIdentity.sha256 = contentHash({ ...naturalIdentity, seed: replayIdentity(bundle),
    synchronized_report_ids: synchronizedIds, terminal_report_ids: terminalIds, pending_report_ids: pendingIds,
    boundary, activation });
  const identity = { ...replayIdentity(bundle), natural: naturalIdentity };
  state.natural = { originalLocal, originalServer, expectedLocal,
    pending, synchronized: new Set(synchronizedIds), terminal: new Set(terminalIds),
    released: { synchronized_report_ids: synchronizedIds, terminal_report_ids: terminalIds, pending_report_ids: pendingIds },
    releasedAt: { browser: released.browser, server: serverAt }, boundary, activation, identity,
    previous: { local, server: activationServer }, previousShared: null, computed: new Map() };
  return { profile: state.profile.id, identity: structuredClone(identity),
    baseline: { local: frozen.local, server: frozen.server },
    released: structuredClone(state.natural.released), activated_findings_job_ids: [...pendingIds],
    released_at: { ...state.natural.releasedAt }, boundary: structuredClone(boundary), activation,
    allowed_transitions: [...naturalTransitions], retained_data: true };
}

function validateNaturalLocal(local, serverFindings, bundle) {
  const natural = stateFor(bundle).natural;
  const reports = byId(local.stores.reports.rows, row => row.report.id);
  const expected = byId(natural.expectedLocal.stores.reports.rows, row => row.report.id);
  sameHistory(sortedIds(reports.keys()), sortedIds(expected.keys()), 'Natural historical local Report IDs changed');
  for (const name of ['drafts', 'withdrawals']) sameHistoryRows(local.stores[name].rows,
    natural.expectedLocal.stores[name].rows, `Natural history changed frozen ${name}`);
  const queuedIds = [], syncedIds = [], rateLimited = [], refusedIds = [], findingsAhead = [];
  const previous = byId(natural.previous.local.stores.reports.rows, row => row.report.id);
  for (const [id, row] of reports) {
    const original = expected.get(id);
    if (!natural.pending.has(id)) {
      sameHistory(row, original, 'Natural terminal/queued history or its private content changed');
    } else {
      const { findings, retry_at, retry_reason, retry_stage, ...immutable } = row;
      const { findings: originalFindings, ...oldImmutable } = original;
      sameHistory(immutable, oldImmutable,
        'Natural history changed original payload/token/private content/Notice/events/activity bytes');
      if (findings.status === 'pending') {
        sameHistory(findings, originalFindings, 'Natural pending local Findings changed shape');
        if (serverFindings.get(id).status !== 'pending') findingsAhead.push(id);
      } else sameHistory(findings, serverFindings.get(id), 'Natural local Findings differ from the real API/server result');
      if (retry_at === undefined) {
        assert(retry_reason === undefined && retry_stage === undefined, 'Natural retry details lack a retry time');
      } else {
        assert.equal(findings.status, 'pending', 'Terminal presence retries must remain in memory only');
        assert.equal(retry_stage, 'findings', 'Natural synchronized history may retry only Findings');
        assert(['network', 'server', 'rate_limit'].includes(retry_reason), 'Invalid natural Findings retry reason');
        // The real GET Findings endpoint has only the concurrency limiter's Retry-After: 1.
        const maximum = retry_reason === 'rate_limit' ? 1000 : 30_000;
        assert(Number.isSafeInteger(retry_at) && retry_at >= Date.parse(natural.releasedAt.browser) &&
          retry_at <= Date.parse(local.observed_at) + maximum, 'Natural retry exceeds the actual source backoff/Retry-After contract');
      }
      if (previous.get(id).findings.status !== 'pending') sameHistory(row.findings, previous.get(id).findings,
        'Natural terminal local Findings regressed or changed');
    }
    (row.events.some(event => event.kind === 'synced') ? syncedIds : queuedIds).push(id);
    if (row.retry_reason === 'rate_limit') rateLimited.push({ id, retry_at: row.retry_at,
      retry_reason: row.retry_reason, retry_stage: row.retry_stage });
    if (row.sync_error) refusedIds.push(id);
  }
  return { queued_ids: queuedIds.sort(), synced_ids: syncedIds.sort(),
    withdrawal_ids: sortedIds(local.stores.withdrawals.rows.map(row => row.id)),
    findings: findingsInventory([...reports].map(([id, row]) => [id, row.findings])),
    rate_limited: rateLimited.sort((a, b) => a.id.localeCompare(b.id)), refused_ids: refusedIds.sort(),
    findingsAhead: findingsAhead.sort() };
}

/**
 * Assertion-backed natural inventory. Read IDB before the atomic server snapshot: a worker
 * commit may lead its local acknowledgement. Only compact digests and public metadata escape.
 * Failed jobs remain failed observations, never completion evidence. Inspect sequentially.
 */
export async function inspectNaturalHistory(page, bundle, database) {
  const state = stateFor(bundle);
  const natural = state.natural;
  assert(natural, 'Begin natural history before natural inspection');
  validateBundle(bundle, state.profile);
  const local = await localSnapshot(page, bundle);
  // Natural refresh preserves all Report/integrity rows byte-for-byte, so no neighbor recomputation is needed.
  const server = await replayServerSnapshot(database, bundle, false);
  sameHistory(server.metadata, natural.originalServer.metadata, 'Natural Rule/geodata/dataset provenance changed');
  for (const [table] of serverTables) {
    if (table === 'report_event') continue;
    const mutable = table === 'findings' || table === 'findings_job';
    const frozen = row => !mutable || !natural.pending.has(row.report_id);
    sameHistoryRows(server.tables[table].filter(frozen), natural.originalServer.tables[table].filter(frozen),
      `Natural history changed frozen server ${table} bytes`);
  }
  const originalEvents = byId(natural.originalServer.tables.report_event, 'id');
  const events = byId(server.tables.report_event, 'id');
  for (const [id, original] of originalEvents) {
    assert(events.has(id), 'Natural history lost an original server event');
    sameHistory(events.get(id), original, 'Natural history changed original server event bytes');
  }
  const diagnostics = new Map();
  for (const [id, row] of events) if (!originalEvents.has(id)) {
    assert(natural.pending.has(row.report_id) && ['findings_computed', 'findings_failed'].includes(row.kind),
      'Natural history added a non-worker server event');
    if (!diagnostics.has(row.report_id)) diagnostics.set(row.report_id, []);
    diagnostics.get(row.report_id).push(replayRow(row));
  }
  const serverFindings = new Map(bundle.reports.filter(row => natural.synchronized.has(row.report.id))
    .map(row => [row.report.id, row.findings]));
  const pendingIds = [], failedIds = [], completedIds = [];
  const current = server.metadata.current_geodata[0];
  for (const id of natural.pending) {
    const findings = await validateHistoryWorker(database, bundle, server, id, natural, diagnostics.get(id) ?? []);
    serverFindings.set(id, findings);
    (findings.status === 'pending' ? pendingIds : findings.status === 'failed' ? failedIds : completedIds).push(id);
    const job = server.tables.findings_job.find(row => row.report_id === id);
    if (job) {
      assert.equal(job.rule_set_id === null, job.geodata_snapshot_id === null, 'Natural job provenance must pin atomically');
      if (job.rule_set_id !== null) {
        const report = bundle.reports.find(row => row.report.id === id).report;
        const occurrence = state.source.warsawDate(new Date(report.occurred_at.at));
        const rule = server.metadata.rule_set.filter(row => row.effective_from <= occurrence)
          .sort((a, b) => b.effective_from.localeCompare(a.effective_from) ||
            Date.parse(b.published_at) - Date.parse(a.published_at))[0];
        assert(rule && current, 'Natural pinned job lacks installed source provenance');
        assert.equal(job.rule_set_id, rule.id, 'Natural job pinned a different occurrence-time Rule set');
        assert.equal(job.geodata_snapshot_id, current.snapshot_id, 'Natural job pinned a different current geodata snapshot');
      }
    }
  }
  const { findingsAhead, ...localResult } = validateNaturalLocal(local, serverFindings, bundle);
  const shared = naturalSharedState(local, natural.previousShared);
  const result = { profile: state.profile.id, identity: structuredClone(natural.identity),
    released: structuredClone(natural.released), activated_findings_job_ids: sortedIds(natural.pending),
    released_at: { ...natural.releasedAt }, boundary: structuredClone(natural.boundary),
    observed_at: { local: local.observed_at, server: server.observed_at },
    assertions: { immutable_payloads_and_private_content: true, frozen_queued_reports_and_withdrawals: true,
      frozen_drafts: true, frozen_terminal_findings_and_events: true, actual_findings_contract: true,
      exact_source_job_activation: true, no_quota_reset: true,
      coherence: 'Atomic local snapshot precedes one server MVCC snapshot; only server-ahead Findings phases are allowed' },
    local: localResult,
    server: { activated_jobs_pending_ids: pendingIds.sort(), activated_jobs_failed_ids: failedIds.sort(),
      activated_jobs_completed_ids: completedIds.sort(), findings: findingsInventory(serverFindings),
      rate_counters: replayRateCounters(server, natural),
      integrity: { queued: server.integrity_pending, terminal: server.integrity_unfinished - server.integrity_pending },
      inventory: naturalServerInventory(server) },
    shared_local_state: shared,
    in_flight: { server_findings_ahead_ids: findingsAhead },
    retained_data: true, allowed_transitions: [...naturalTransitions] };
  natural.previous = { local, server };
  natural.previousShared = shared.content_sha256;
  return result;
}
