import type { LocalDraft } from './local-store';
import type { DeviceFix, Report } from './report';
import { areaConfirmed, choosesPoint, manualPoint, nearHomePoint, outgoingArea, placeOrigin, withResolvedHome } from './home-area';
import { warsawDate, warsawDateAtNoon } from './time-findings';

export type DraftIssue = 'event' | 'location' | 'home' | 'area' | 'photo' | 'details' |
  'manual_point' | 'near_home' | 'moved_point' | 'occurrence';

export class DraftValidationError extends Error {
  constructor(readonly issue: DraftIssue) { super(`draft_${issue}`); }
}

function validOccurrence(draft: LocalDraft) {
  if (draft.occurredMode === 'within_hours') {
    const hours = draft.hoursAgo ?? 1;
    return Number.isInteger(hours) && hours >= 1 && hours <= 24;
  }
  if (draft.occurredMode === 'date_only') {
    const day = draft.occurredDate ?? '';
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || Number.isNaN(Date.parse(`${day}T12:00:00Z`))) return false;
    return warsawDate(new Date(warsawDateAtNoon(day))) === day &&
      day <= warsawDate(new Date(draft.capturedAt));
  }
  return !draft.occurredMode || draft.occurredMode === 'now';
}

export function draftReadiness(saved: LocalDraft, home?: DeviceFix): DraftIssue[] {
  const issues: DraftIssue[] = [];
  const draft = withResolvedHome(saved, home);
  const chosen = choosesPoint(draft);
  const moved = chosen ? manualPoint(draft) : null;
  const photos = draft.photos ?? [];
  if (draft.eventType === null || !Number.isInteger(draft.eventType) || draft.eventType < 0 || draft.eventType > 4) issues.push('event');
  if (!placeOrigin(draft)) issues.push('location');
  if (draft.fromHome === undefined) issues.push('home');
  if (draft.fromHome !== undefined && outgoingArea(draft) && !areaConfirmed(draft)) issues.push('area');
  if (photos.length > 3 || (draft.eventType === 0 && photos.length) || (draft.eventType === 2 && !photos.length)) issues.push('photo');
  if ((draft.note?.length ?? 0) > 500) issues.push('details');
  if (chosen && !draft.fromHome && (draft.manualLat || draft.manualLon) && !moved) issues.push('manual_point');
  // Shots too: away from home a shot's area centre, direction and distance lead back to where the Reporter stood.
  if (draft.fromHome === false && home && moved && nearHomePoint(moved, home)) issues.push('near_home');
  if (draft.fromHome === false && home && draft.fix && nearHomePoint(draft.fix, home) && !moved) issues.push('moved_point');
  if (!validOccurrence(draft)) issues.push('occurrence');
  return issues;
}

export function draftOccurrence(draft: LocalDraft): Report['occurred_at'] {
  if (!validOccurrence(draft)) throw new DraftValidationError('occurrence');
  if (draft.occurredMode === 'within_hours') return {
    at: new Date(new Date(draft.capturedAt).getTime() - (draft.hoursAgo ?? 1) * 3_600_000).toISOString(),
    window_end: draft.capturedAt, source: 'entered_by_reporter', coarseness: 'within_hours'
  };
  if (draft.occurredMode === 'date_only') return {
    at: warsawDateAtNoon(draft.occurredDate!), source: 'entered_by_reporter', coarseness: 'date_only'
  };
  return { at: draft.capturedAt, source: 'device_clock', coarseness: 'exact' };
}
