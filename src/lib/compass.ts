// Polish names of the eight compass points, which are also the translation keys.
const points = ['północ', 'północny wschód', 'wschód', 'południowy wschód', 'południe', 'południowy zachód', 'zachód', 'północny zachód'];

/** Bearings are stored in 5-degree steps: close to continuous, without claiming single-degree accuracy. */
export function roundBearing(heading: number) {
  return (Math.round(heading / 5) * 5) % 360;
}

export function compassPoint(bearing: number) {
  return points[Math.round(bearing / 45) % 8];
}

// Row-major device-to-world rotation, world axes east, north, up. Android's
// SensorManager.getRotationMatrixFromVector and the W3C DeviceOrientation frame agree on these.
export type Rotation = readonly number[];

export type HeadingSample = { heading: number; spread: number; at: number };
/** Where the phone points now, if anywhere. `spread` is the beam's half-width in degrees. */
export type HeadingState = { pointing?: number; spread?: number };
export type NativeReading = { matrix: number[]; magneticAccuracy: number; fieldMicrotesla: number; headingAccuracyDegrees: number };

const radians = Math.PI / 180;
const pointingMs = 250;
// The beam's half-width: the uncertainty of an estimate by ear and a phone compass, not a measured spread.
export const beamSpread = 15;
export const lowAccuracySpread = 40;

export function rotationFromEuler(alpha: number, beta: number, gamma: number): Rotation {
  const [ca, sa] = [Math.cos(alpha * radians), Math.sin(alpha * radians)];
  const [cb, sb] = [Math.cos(beta * radians), Math.sin(beta * radians)];
  const [cg, sg] = [Math.cos(gamma * radians), Math.sin(gamma * radians)];
  return [
    ca * cg - sa * sb * sg, -cb * sa, cg * sa * sb + ca * sg,
    cg * sa + ca * sb * sg, ca * cb, sa * sg - ca * cg * sb,
    -cb * sg, sb, cb * cg
  ];
}

/**
 * Compass heading the phone points at: the screen's top edge while the phone lies flat, the back camera's
 * direction while it is held upright. The two are perpendicular, so one of them is always close enough to
 * horizontal, and both face the same way as the phone is raised.
 */
export function deviceHeading(rotation: Rotation, screenAngle: number): number {
  // screen.orientation.angle turns the content clockwise, so its top lies at that angle from the device top.
  const [sx, sy] = [Math.sin(screenAngle * radians), Math.cos(screenAngle * radians)];
  const top = [rotation[0] * sx + rotation[1] * sy, rotation[3] * sx + rotation[4] * sy];
  const camera = [-rotation[2], -rotation[5]];
  const [east, north] = Math.hypot(...top) >= Math.hypot(...camera) ? top : camera;
  return (Math.atan2(east, north) / radians + 360) % 360;
}

function circularMean(headings: number[]) {
  const x = headings.reduce((sum, heading) => sum + Math.sin(heading * radians), 0) / headings.length;
  const y = headings.reduce((sum, heading) => sum + Math.cos(heading * radians), 0) / headings.length;
  return (Math.atan2(x, y) / radians + 360) % 360;
}

/** Android flags: magnetometer calibration, a field outside the Earth's range, or a wide fused estimate. */
export function nativeSpread(reading: NativeReading) {
  const earthField = reading.fieldMicrotesla >= 20 && reading.fieldMicrotesla <= 70;
  // A calibrated Pixel 10a reports a constant 30.0000008 degrees, so the limit sits clear of that.
  const estimate = reading.headingAccuracyDegrees < 0 || reading.headingAccuracyDegrees <= 40;
  return reading.magneticAccuracy >= 1 && earthField && estimate ? beamSpread : lowAccuracySpread;
}

/** Points at the mean of the last quarter second of readings, so the beam neither waits nor jitters. */
export function createPointer() {
  let samples: HeadingSample[] = [];
  return {
    add(sample: HeadingSample): HeadingState {
      samples = [...samples.filter(item => item.at > sample.at - pointingMs), sample];
      return { pointing: circularMean(samples.map(item => item.heading)), spread: Math.max(...samples.map(item => item.spread)) };
    }
  };
}
