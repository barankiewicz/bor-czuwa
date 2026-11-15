// The largest and oldest values the central store takes. Honest clients stay well inside them:
// the largest area is the 8 km home cell (8.4 km on a side at 49 degrees north), the largest
// chosen area a 3 km radius (6.1 km), and a phone's own clock is trusted to within a week.
export const inputLimits = {
  /** Either side of an Incident area, in metres at its middle latitude. */
  maxAreaSideM: 10_000,
  /** A cell-tower fix can be tens of kilometres off; nothing the app records is worse. */
  maxAccuracyM: 100_000,
  /** The app did not exist before 2026; this bounds captured_at and device_fix.at from below. */
  earliestInstant: '2020-01-01T00:00:00Z',
  /** How far ahead of the server's clock a phone clock may run. */
  maxClockAheadMs: 7 * 86_400_000
} as const;
