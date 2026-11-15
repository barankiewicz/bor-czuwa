import type { LocalDraft } from './local-store';

type Fields = Record<string, unknown>;

/** Plain data is compared by value. A photo is the same photo by its id: IndexedDB stores a copy of its Blob. */
export function sameField(key: string, a: unknown, b: unknown): boolean {
  if (key === 'photos') return photoIds(a) === photoIds(b);
  return same(a, b);
}

const photoIds = (photos: unknown) => JSON.stringify(((photos ?? []) as { id: string }[]).map(photo => photo.id));

function same(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || !a || !b) return false;
  const arrays = Array.isArray(a);
  if (arrays !== Array.isArray(b)) return false;
  const plain = (value: object) => arrays || Object.prototype.toString.call(value) === '[object Object]';
  if (!plain(a) || !plain(b)) return false;
  const left = a as Fields, right = b as Fields;
  for (const key of new Set([...Object.keys(left), ...Object.keys(right)])) if (!same(left[key], right[key])) return false;
  return true;
}

/**
 * The top-level fields that differ between `base` (the copy last stored or loaded) and `mine`.
 * `writtenAt` is bookkeeping kept by the store, never an edit.
 */
export function changedFields(base: LocalDraft, mine: LocalDraft): string[] {
  const was = base as Fields, now = mine as Fields;
  return [...new Set([...Object.keys(was), ...Object.keys(now)])].filter(key => key !== 'writtenAt' && !sameField(key, was[key], now[key]));
}

/** Records that the write starting at `at` (ms since the epoch) changed `keys`. */
export function stamped(draft: LocalDraft, keys: string[], at: number): LocalDraft {
  if (!keys.length) return draft;
  return { ...draft, writtenAt: { ...draft.writtenAt, ...Object.fromEntries(keys.map(key => [key, at])) } };
}

/** A field a leaving tab changed. `pending`: an earlier write of that tab was already carrying it. */
export type JournalChange = { before?: unknown; after?: unknown; pending?: true };

/**
 * Applies journal entries left by pages that were gone before their merged write, in the order their
 * writes started. A field from a leaving tab's newest edit is taken unless a write that started later
 * changed it, as the merged write would have landed after every write started before it. A field an
 * earlier write of that tab was already carrying started at an unknown time, so it is taken only while
 * the stored value is still the one that tab had loaded.
 */
export function replayJournal(stored: LocalDraft, entries: { at: number; changes: Record<string, JournalChange> }[]): LocalDraft {
  let result = stored;
  for (const entry of [...entries].sort((a, b) => a.at - b.at)) for (const [key, change] of Object.entries(entry.changes)) {
    if (key === 'writtenAt') continue;
    const fields = result as Fields;
    const skip = change.pending ? !sameField(key, fields[key], change.before) : (result.writtenAt?.[key] ?? 0) > entry.at;
    if (skip) continue;
    const next: Fields = { ...fields };
    if ('after' in change) next[key] = change.after; else delete next[key];
    result = stamped(next as LocalDraft, [key], entry.at);
  }
  return result;
}

/**
 * Puts the top-level fields this tab changed since `base` on top of `stored`, so fields only
 * another tab changed survive. A field both tabs changed takes this tab's value: the later write wins.
 */
export function mergeDraft(stored: LocalDraft, base: LocalDraft, mine: LocalDraft): LocalDraft {
  const merged: Fields = { ...stored };
  const now = mine as Fields;
  for (const key of changedFields(base, mine)) {
    if (now[key] !== undefined) merged[key] = now[key];
    else delete merged[key];
  }
  return merged as LocalDraft;
}
