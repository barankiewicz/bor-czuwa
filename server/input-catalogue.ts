import { inputLimits } from '../src/lib/input-limits.ts';
import type { Report } from '../src/lib/report.ts';

/** Clock-dependent limits; the shape limits live in the Report schema. */
export function timesWithinWindow(report: Report, now: number) {
  const latest = now + inputLimits.maxClockAheadMs;
  const earliest = Date.parse(inputLimits.earliestInstant);
  const recorded = [report.captured_at, ...(report.device_fix ? [report.device_fix.at] : [])];
  const occurred = [report.occurred_at.at, ...(report.occurred_at.window_end ? [report.occurred_at.window_end] : [])];
  return recorded.every(value => Date.parse(value) >= earliest && Date.parse(value) <= latest) &&
    occurred.every(value => Date.parse(value) <= latest);
}

