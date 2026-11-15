import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compassPoint, createPointer, deviceHeading, nativeSpread, rotationFromEuler, roundBearing } from '../src/lib/compass.ts';

const near = (actual: number | null, expected: number) =>
  assert.ok(actual !== null && Math.abs(((actual - expected + 540) % 360) - 180) < 0.5, `${actual} is not ${expected}`);

test('flat phone points its screen top at the heading that alpha implies', () => {
  near(deviceHeading(rotationFromEuler(0, 0, 0), 0), 0);
  near(deviceHeading(rotationFromEuler(90, 0, 0), 0), 270);
  near(deviceHeading(rotationFromEuler(270, 0, 0), 0), 90);
});

test('screen rotation turns the pointing edge with the content, not against it', () => {
  // Landscape with angle 90 puts the screen top on the device's right edge.
  near(deviceHeading(rotationFromEuler(0, 0, 0), 90), 90);
  near(deviceHeading(rotationFromEuler(0, 0, 0), 270), 270);
  near(deviceHeading(rotationFromEuler(0, 0, 0), 180), 180);
  near(deviceHeading(rotationFromEuler(90, 0, 0), 90), 0);
});

test('a tilted phone keeps its heading', () => {
  near(deviceHeading(rotationFromEuler(300, 40, 0), 0), 60);
  near(deviceHeading(rotationFromEuler(300, -30, 20), 0), 60);
});

test('an upright phone points where its back camera looks', () => {
  // Top edge raised to vertical: the screen faces the Reporter and the camera looks at heading 60.
  near(deviceHeading(rotationFromEuler(300, 85, 0), 0), 60);
  near(deviceHeading(rotationFromEuler(300, 90, 0), 0), 60);
  // Leaning back past vertical still looks the same way, so the beam does not flip.
  near(deviceHeading(rotationFromEuler(300, 120, 0), 0), 60);
  // Upright in landscape (screen angle 90): the device's right edge points up, its top edge west, and the
  // camera north. Columns are the device x, y and z axes in east, north, up.
  near(deviceHeading([0, -1, 0, 0, 0, -1, 1, 0, 0], 90), 0);
});

test('bearings round to 5 degrees and wrap at north', () => {
  assert.deepEqual([0, 2.4, 2.5, 67.4, 67.6, 357.4, 357.6, 359.9].map(roundBearing), [0, 0, 5, 65, 70, 355, 0, 0]);
});

test('each bearing is named by the nearest of eight compass points', () => {
  assert.deepEqual([0, 20, 25, 70, 135, 200, 250, 295, 340].map(compassPoint), ['północ', 'północ', 'północny wschód',
    'wschód', 'południowy wschód', 'południe', 'zachód', 'północny zachód', 'północ']);
});

function feed(headings: number[], step = 100) {
  const pointer = createPointer();
  return headings.map((heading, index) => pointer.add({ heading, spread: 15, at: index * step })).at(-1)!;
}

test('the first reading points at once, without waiting for agreement', () => {
  const first = createPointer().add({ heading: 90, spread: 40, at: 0 });
  assert.equal(first.pointing, 90);
  assert.equal(first.spread, 40);
});

test('the pointer smooths across north instead of averaging to south', () => {
  const state = feed([358, 2, 359, 1]);
  assert.ok(state.pointing! < 2 || state.pointing! > 358, String(state.pointing));
});

test('jittery readings still point, at their recent mean', () => {
  near(feed([10, 80, 20, 100, 0, 60, 30, 90]).pointing!, 60);
});

test('android accuracy widens the beam and never withholds it', () => {
  const good = { matrix: [], magneticAccuracy: 3, fieldMicrotesla: 48, headingAccuracyDegrees: 12 };
  assert.equal(nativeSpread(good), 15);
  assert.equal(nativeSpread({ ...good, headingAccuracyDegrees: -1 }), 15);
  // Pixel 10a, Android 17, calibrated magnetometer, lying on a desk.
  assert.equal(nativeSpread({ ...good, headingAccuracyDegrees: 30.000000834826057, fieldMicrotesla: 53.1 }), 15);
  assert.equal(nativeSpread({ ...good, magneticAccuracy: 0 }), 40);
  assert.equal(nativeSpread({ ...good, fieldMicrotesla: 140 }), 40);
  assert.equal(nativeSpread({ ...good, fieldMicrotesla: -1 }), 40);
  assert.equal(nativeSpread({ ...good, headingAccuracyDegrees: 45 }), 40);
});
