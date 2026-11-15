import { test } from 'node:test';
import assert from 'node:assert/strict';
import { areaConfirmed, choosesPoint, homeArea, manualPoint, nearHomePoint, outgoingArea, placeEstimate, resolvedHome } from '../src/lib/home-area.ts';
import { reportSchema, type DeviceFix } from '../src/lib/report.ts';

const fix: DeviceFix = { lat: 53.403481, lon: 22.658699, accuracy_m: 12, at: '2026-09-24T10:00:00Z' };
type LocalDraft = Parameters<typeof outgoingArea>[0];
const draft: LocalDraft = { eventType: 0, fix };

test('home area hides exact fix and has stable bounds throughout its cell', () => {
  const area = homeArea(fix, 4);
  assert.equal(area.precise_fix_withheld, 'home_privacy');
  assert.equal(area.basis, 'reporter_selected_area');
  assert.ok(area.bounds[0] <= fix.lon && fix.lon <= area.bounds[2]);
  assert.ok(area.bounds[1] <= fix.lat && fix.lat <= area.bounds[3]);
  assert.deepEqual(homeArea({ ...fix, lat: fix.lat + 0.0001, lon: fix.lon + 0.0001 }, 4), area);
  assert.equal(JSON.stringify(area).includes(String(fix.lat)), false);
});

test('local home recognition permits nearby fixes and rejects distant ones', () => {
  assert.equal(nearHomePoint({ ...fix, lat: fix.lat + 0.0005 }, fix), true);
  assert.equal(nearHomePoint({ ...fix, lat: fix.lat + 0.02 }, fix), false);
  assert.equal(nearHomePoint({ lat: fix.lat, lon: fix.lon }, fix), true);
  assert.equal(nearHomePoint({ lat: fix.lat + 0.002, lon: fix.lon }, fix), false);
});

test('transport rejects exact fix, tiny bounds, and unmarked area', () => {
  const location = homeArea(fix, 4);
  const report = {
    id: '8bb7862e-a4b1-47ed-b5c6-95dfd0d127aa', event_type: 'shot', captured_at: fix.at,
    occurred_at: { at: fix.at, source: 'device_clock', coarseness: 'exact' },
    device_fix: null, incident_location: location, species: null, has_note: false,
    app_version: '0.1.0', privacy_policy_version: 'internal-fixture', terms_of_use_version: 'internal-fixture',
    token_sha256: 'a'.repeat(64)
  };
  for (const event_type of ['shot', 'person_with_gun', 'injured_animal', 'poaching']) {
    assert.equal(reportSchema.safeParse({ ...report, event_type,
      ...(event_type === 'shot' ? {} : { photo_sha256: [] }) }).success, true);
  }
  assert.equal(reportSchema.safeParse({ ...report, event_type: 'remains' }).success, false);
  assert.equal(reportSchema.safeParse({ ...report, device_fix: fix }).success, false);
  assert.equal(reportSchema.safeParse({ ...report, incident_location: { ...location, bounds: [22.65, 53.4, 22.651, 53.401] } }).success, false);
  // Away from home, a non-shot area is drawn around a chosen point or estimated from what was seen, never heard.
  const drawn = { ...report, event_type: 'person_with_gun', photo_sha256: [], incident_location: { ...location, precise_fix_withheld: null } };
  assert.equal(reportSchema.safeParse(drawn).success, true);
  assert.equal(reportSchema.safeParse({ ...drawn, incident_location: { ...drawn.incident_location, basis: 'estimated_from_hearing', hearing_distance_m: 500 } }).success, false);
  const seen = { ...drawn.incident_location, basis: 'estimated_from_sighting', hearing_distance_m: 500 };
  for (const event_type of ['person_with_gun', 'injured_animal', 'poaching']) {
    assert.equal(reportSchema.safeParse({ ...drawn, event_type, incident_location: seen }).success, true, event_type);
  }
  assert.equal(reportSchema.safeParse({ ...report, incident_location: seen }).success, false, 'a shot is heard, not seen');
  assert.equal(reportSchema.safeParse({ ...drawn, event_type: 'remains', photo_sha256: ['a'.repeat(64)], incident_location: seen }).success, false,
    'remains are photographed where the Reporter stands');
});

test('manual point requires both valid coordinates', () => {
  const draft = { id: 'draft', eventType: 0, capturedAt: fix.at, fix };
  assert.equal(manualPoint({ ...draft, manualLat: '53.4' }), null);
  assert.equal(manualPoint({ ...draft, manualLat: '91', manualLon: '22.8' }), null);
  assert.deepEqual(manualPoint({ ...draft, manualLat: '53.4', manualLon: '22.8' }), { lat: 53.4, lon: 22.8 });
});

const metres = (bounds: number[]) => [(bounds[2] - bounds[0]) * 111_320 * Math.cos((bounds[1] + bounds[3]) / 2 * Math.PI / 180),
  (bounds[3] - bounds[1]) * 111_320];
const centre = (bounds: number[]) => ({ lat: (bounds[1] + bounds[3]) / 2, lon: (bounds[0] + bounds[2]) / 2 });
const near = (a: number, b: number, tolerance: number) => Math.abs(a - b) <= tolerance;
const valid = (area: unknown) => reportSchema.shape.incident_location.safeParse(area).success;

test('a shot heard now away from home keeps an area sized by its uncertainty, with direction and distance', () => {
  const both = outgoingArea({ ...draft, fromHome: false, hearingBearing: 90, hearingDistanceM: 1000 })!;
  const [width, height] = metres(both.bounds);
  // r = max(250 m, half of 1 km) = 500 m, so a 1 km square centred 1 km east of the fix.
  assert.ok(near(width, 1000, 2) && near(height, 1000, 2), `${width} × ${height}`);
  assert.ok(near(centre(both.bounds).lat, fix.lat, 1e-5));
  assert.ok(near((centre(both.bounds).lon - fix.lon) * 111_320 * Math.cos(fix.lat * Math.PI / 180), 1000, 2));
  assert.equal(both.basis, 'estimated_from_hearing');
  assert.equal(both.precise_fix_withheld, null);
  assert.equal(both.hearing_bearing_deg, 90);
  assert.equal(both.hearing_distance_m, 1000);
  assert.equal(valid(both), true);

  const close = outgoingArea({ ...draft, fromHome: false, hearingBearing: 0, hearingDistanceM: 200 })!;
  assert.ok(metres(close.bounds).every(side => near(side, 500, 2)), 'the radius never drops below 250 m');

  const distanceOnly = outgoingArea({ ...draft, fromHome: false, hearingDistanceM: 300 })!;
  assert.ok(metres(distanceOnly.bounds).every(side => near(side, 600, 2)));
  assert.ok(near(centre(distanceOnly.bounds).lat, fix.lat, 1e-5));
  assert.equal(distanceOnly.hearing_bearing_deg, undefined);

  const nothing = outgoingArea({ ...draft, fromHome: false })!;
  assert.ok(metres(nothing.bounds).every(side => near(side, 2000, 2)), 'one kilometre without any estimate');
  assert.equal(nothing.basis, 'reporter_selected_area');
  assert.equal(valid(nothing), true);

  const bearingOnly = outgoingArea({ ...draft, fromHome: false, hearingBearing: 45 })!;
  assert.equal(bearingOnly.basis, 'estimated_from_hearing');
  assert.equal(bearingOnly.hearing_bearing_deg, 45);
  assert.equal(valid(bearingOnly), true);
});

test('from home a shot snaps to the fixed grid and keeps direction and distance on the phone', () => {
  const small = outgoingArea({ ...draft, fromHome: true, hearingBearing: 70, hearingDistanceM: 1500 })!;
  assert.equal(small.precise_fix_withheld, 'home_privacy');
  assert.equal(small.hearing_bearing_deg, undefined);
  assert.equal(small.hearing_distance_m, undefined);
  assert.equal(small.basis, 'estimated_from_hearing');
  assert.equal(JSON.stringify(small).includes(String(fix.lat)), false);
  // r = 750 m, so the 4 km cell holding the estimate.
  const estimate = placeEstimate({ ...draft, hearingBearing: 70, hearingDistanceM: 1500 })!;
  assert.deepEqual(small.bounds, homeArea(estimate, 4).bounds);
  assert.equal(valid(small), true);

  const far = outgoingArea({ ...draft, fromHome: true, hearingDistanceM: 2000 })!;
  assert.deepEqual(far.bounds, homeArea(fix, 8).bounds, 'distance only, r = 2 km, so an 8 km cell');
  const unknown = outgoingArea({ ...draft, fromHome: true })!;
  assert.deepEqual(unknown.bounds, homeArea(fix, 4).bounds, 'no estimate, r = 1 km, so a 4 km cell');
  assert.equal(unknown.basis, 'reporter_selected_area');

  const otherEvent = outgoingArea({ ...draft, eventType: 1, fromHome: true })!;
  assert.deepEqual(otherEvent.bounds, homeArea(fix, 4).bounds);
  assert.equal(valid(otherEvent), true);
});

test('a point with a radius sends the area around it, or a grid cell when the point is at home', () => {
  const point = { manualLat: '53.2', manualLon: '22.4' };
  const earlier = { ...draft, eventType: 1, occurredMode: 'within_hours' as const, hoursAgo: 3, ...point, pointRadiusM: 1500 };
  assert.equal(choosesPoint(earlier), true);
  const area = outgoingArea({ ...earlier, fromHome: false })!;
  assert.ok(metres(area.bounds).every(side => near(side, 3000, 3)));
  assert.ok(near(centre(area.bounds).lat, 53.2, 1e-5) && near(centre(area.bounds).lon, 22.4, 1e-5));
  assert.equal(area.basis, 'reporter_selected_area');
  assert.equal(area.precise_fix_withheld, null);
  assert.equal(valid(area), true);

  const shotPoint = outgoingArea({ ...draft, ...point, fromHome: false, hearingBearing: 90, hearingDistanceM: 500, pointRadiusM: 100 })!;
  assert.equal(shotPoint.basis, 'reporter_selected_area', 'a chosen point ignores the compass');
  assert.equal(shotPoint.hearing_bearing_deg, undefined);
  assert.ok(metres(shotPoint.bounds).every(side => near(side, 200, 2)));
  assert.equal(valid(shotPoint), true);

  const atHome = outgoingArea({ ...earlier, fromHome: true })!;
  assert.deepEqual(atHome.bounds, homeArea({ lat: 53.2, lon: 22.4 }, 8).bounds);
  const atHomeSmall = outgoingArea({ ...earlier, pointRadiusM: 1000, fromHome: true })!;
  assert.deepEqual(atHomeSmall.bounds, homeArea({ lat: 53.2, lon: 22.4 }, 4).bounds);
});

test('the radius slider’s first stop keeps the chosen point itself', () => {
  const exact = { ...draft, eventType: 1, occurredMode: 'within_hours' as const, manualLat: '53.2', manualLon: '22.4', pointRadiusM: 0 };
  assert.equal(outgoingArea({ ...exact, fromHome: false }), null, 'a point, with every point Finding');
  assert.deepEqual(outgoingArea({ ...exact, fromHome: true })!.bounds, homeArea({ lat: 53.2, lon: 22.4 }, 4).bounds, 'still a cell at home');
});

test('another Event happening now away from home sends its point', () => {
  assert.equal(outgoingArea({ ...draft, eventType: 3, fromHome: false }), null);
  assert.equal(choosesPoint({ ...draft, eventType: 3 }), false);
  assert.equal(choosesPoint({ ...draft, eventType: 3, fix: undefined }), true);
});

test('a seen Event happening now is placed by direction and distance, as a heard shot is', () => {
  for (const eventType of [1, 3, 4]) {
    const both = outgoingArea({ ...draft, eventType, fromHome: false, hearingBearing: 180, hearingDistanceM: 200 })!;
    // r = max(250 m, 100 m) = 250 m, so a 500 m square centred 200 m south of the fix.
    assert.ok(metres(both.bounds).every(side => near(side, 500, 2)), `${eventType}: ${metres(both.bounds)}`);
    assert.ok(near((fix.lat - centre(both.bounds).lat) * 111_320, 200, 1));
    assert.ok(near(centre(both.bounds).lon, fix.lon, 1e-5));
    assert.equal(both.basis, 'estimated_from_sighting');
    assert.equal(both.hearing_bearing_deg, 180);
    assert.equal(both.hearing_distance_m, 200);
    assert.equal(valid(both), true);

    const bearingOnly = outgoingArea({ ...draft, eventType, fromHome: false, hearingBearing: 45 })!;
    assert.ok(metres(bearingOnly.bounds).every(side => near(side, 2000, 2)), 'one kilometre around the Reporter');
    assert.equal(bearingOnly.basis, 'estimated_from_sighting');
    const distanceOnly = outgoingArea({ ...draft, eventType, fromHome: false, hearingDistanceM: 750 })!;
    assert.ok(metres(distanceOnly.bounds).every(side => near(side, 1500, 2)));
    assert.equal(distanceOnly.hearing_bearing_deg, undefined);

    // Pomiń keeps the phone's position, sent as the point it is.
    assert.equal(outgoingArea({ ...draft, eventType, fromHome: false }), null);

    const home = outgoingArea({ ...draft, eventType, fromHome: true, hearingBearing: 70, hearingDistanceM: 1500 })!;
    const estimate = placeEstimate({ ...draft, eventType, hearingBearing: 70, hearingDistanceM: 1500 })!;
    assert.deepEqual(home.bounds, homeArea(estimate, 4).bounds);
    assert.equal(home.basis, 'estimated_from_sighting');
    assert.equal(home.precise_fix_withheld, 'home_privacy');
    assert.equal(home.hearing_bearing_deg, undefined);
    assert.equal(home.hearing_distance_m, undefined);
    assert.equal(valid(home), true);
    assert.deepEqual(outgoingArea({ ...draft, eventType, fromHome: true, hearingDistanceM: 3000 })!.bounds, homeArea(fix, 8).bounds);
  }
  // Remains are photographed where the Reporter stands, so a stray direction is ignored.
  assert.equal(outgoingArea({ ...draft, eventType: 2, fromHome: false, hearingBearing: 90, hearingDistanceM: 500 }), null);
  // Earlier, a chosen point wins over any direction left on the Draft.
  const earlier = outgoingArea({ ...draft, eventType: 1, occurredMode: 'date_only', manualLat: '53.2', manualLon: '22.4',
    hearingBearing: 90, hearingDistanceM: 500, fromHome: false })!;
  assert.equal(earlier.basis, 'reporter_selected_area');
  assert.equal(earlier.hearing_bearing_deg, undefined);
});

test('a saved home decides the home question unless the Reporter answered it', () => {
  assert.equal(resolvedHome(draft, undefined), undefined);
  assert.equal(resolvedHome(draft, { ...fix, lat: fix.lat + 0.0005 }), true);
  assert.equal(resolvedHome(draft, { ...fix, lat: fix.lat + 0.02 }), false);
  assert.equal(resolvedHome({ ...draft, fromHome: false }, fix), false);
  // A point chosen on the map is judged against the home, not the recording fix.
  assert.equal(resolvedHome({ ...draft, manualLat: '53.2', manualLon: '22.4' }, fix), false);
});

test('Drafts saved with a distance band still estimate an area', () => {
  const area = outgoingArea({ ...draft, fromHome: false, hearingDistanceBand: '500m_to_1km' })!;
  assert.ok(metres(area.bounds).every(side => near(side, 1500, 2)));
  assert.equal(area.hearing_distance_m, 750);
});

test('any change to outgoing geometry needs a new confirmation', () => {
  const item: LocalDraft = { ...draft, fromHome: false, hearingBearing: 90, hearingDistanceM: 500 };
  const confirmed = { ...item, confirmedArea: outgoingArea(item)! };
  assert.equal(areaConfirmed(confirmed), true);
  for (const change of [
    { hearingBearing: 270 }, { hearingBearing: undefined }, { hearingDistanceM: 3000 },
    { fix: { ...fix, lat: fix.lat + 0.1 } }, { manualLat: '53.2', manualLon: '22.4' }, { fromHome: true },
    { occurredMode: 'within_hours' }
  ] as Partial<LocalDraft>[]) {
    assert.equal(areaConfirmed({ ...confirmed, ...change }), false, JSON.stringify(change));
  }
  assert.equal(areaConfirmed({ ...confirmed, hearingBearing: 90 }), true);
  assert.equal(areaConfirmed({ ...confirmed, note: 'x' } as LocalDraft), true);
});

test('transport keeps home areas coarse and hearing estimates off them', () => {
  const home = homeArea(fix, 4);
  for (const size of [4, 8] as const) {
    const cell = homeArea(fix, size);
    assert.equal(valid(cell), true, `${size} km rounded cell`);
    assert.equal(valid({ ...cell, bounds: cell.bounds.map(value => Number((value + 0.000001).toFixed(6))) }), false,
      `${size} km home bounds cannot shift even one decimal unit`);
  }
  assert.equal(valid({ ...home, hearing_bearing_deg: 70 }), false);
  assert.equal(valid({ ...home, basis: 'estimated_from_hearing', hearing_distance_m: 500 }), false);
  assert.equal(valid({ ...home, basis: 'estimated_from_hearing' }), true);
  assert.equal(valid({ ...home, bounds: [22.65, 53.4, 22.66, 53.41] }), false, 'a home area cannot shrink below the grid');
  const away = outgoingArea({ ...draft, fromHome: false, hearingBearing: 90, hearingDistanceM: 1000 })!;
  assert.equal(valid({ ...away, bounds: [22.65, 53.4, 22.651, 53.401] }), false, 'under 150 m a side');
  assert.equal(valid({ ...away, hearing_distance_m: 50 }), false);
  assert.equal(valid({ ...away, hearing_distance_m: 5000 }), true, 'the target reaches 5 km');
  assert.equal(valid({ ...away, hearing_distance_m: 5100 }), false);
  assert.equal(valid({ ...away, hearing_distance_band: 'over_1km' }), false, 'band and metres never travel together');
  for (const hearing_bearing_deg of [72, 360, -5, 12.5]) assert.equal(valid({ ...away, hearing_bearing_deg }), false, String(hearing_bearing_deg));
  assert.equal(valid({ ...away, basis: 'reporter_selected_area' }), false);
  const { hearing_distance_m: _, ...legacy } = away;
  assert.equal(valid({ ...legacy, hearing_distance_band: 'over_1km' }), true, 'older builds still sync');
});

test('resolvedHome asks when the Accuracy circle reaches into the 150 m home zone', () => {
  const home = fix;
  const at = (distanceM: number, accuracy_m: number) =>
    ({ eventType: 0, fix: { ...fix, lat: fix.lat + distanceM / 111_000, accuracy_m } }) as LocalDraft;
  const rows: Array<[number, number, boolean | undefined]> = [
    [149, 8, true], [149, 300, true], [151, 8, undefined], [160, 8, false], [160, 150, undefined],
    [160, 200, undefined], [250, 200, undefined], [300, 8, false], [300, 300, undefined]
  ];
  for (const [distance, accuracy, expected] of rows) {
    assert.equal(resolvedHome(at(distance, accuracy), home), expected, `${distance} m, Accuracy ${accuracy} m`);
  }
  assert.equal(resolvedHome({ ...at(160, 150), fromHome: false }, home), false, 'an explicit answer wins');
  const chosen = { ...at(160, 300), locationMethod: 'map' as const,
    manualLat: String(fix.lat + 160 / 111_000), manualLon: String(fix.lon) };
  assert.equal(resolvedHome(chosen, home), false, 'a chosen point has no Accuracy and keeps the distance rule');
});

test('resolvedHome decides exact and fractional boundary cases the same way at every bearing', () => {
  const home = fix;
  // Rows are built with the projection the distance check uses (111 000 m per degree of latitude). Do not
  // use shiftedBy here: it scales by 111 320, so its "150 m" is 149.57 m to the check.
  const rows: Array<[number, number, boolean | undefined]> = [
    [150, 0, true], [150.4, 0, false], [160, 10, undefined], [300, 150, undefined], [165, 10, false], [305, 150, false],
    [160.6, 10.6, undefined], [151.6, 1.7, undefined], [151.6, 1.5, false], [149.9, 300, true]
  ];
  for (const bearing of [0, 45, 90, 180, 270]) {
    for (const [distance, accuracy, expected] of rows) {
      const place = { lat: home.lat + distance * Math.cos(bearing * Math.PI / 180) / 111_000,
        lon: home.lon + distance * Math.sin(bearing * Math.PI / 180) / (111_000 * Math.cos(home.lat * Math.PI / 180)) };
      const device = { eventType: 0, fix: { ...fix, ...place, accuracy_m: accuracy } } as LocalDraft;
      assert.equal(resolvedHome(device, home), expected, `${distance} m, Accuracy ${accuracy} m, bearing ${bearing}`);
    }
  }
});
