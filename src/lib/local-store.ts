import { version } from '$app/environment';
import { openDB, type DBSchema, type IDBPObjectStore } from 'idb';
import { appVersion } from './app-version';
import { eventTypes } from './event-types';
import type { DeviceFix, FindingsResult, IncidentArea, Report } from './report';
import { choosesPoint, outgoingArea, placeOrigin, withResolvedHome, type PlaceReference } from './home-area';
import { draftOccurrence, draftReadiness, DraftValidationError } from './draft-readiness';
import { changedFields, mergeDraft, replayJournal, stamped, type JournalChange } from './draft-merge';
import type { LocalPhoto } from './photos';
import { privacyPolicyVersion, termsOfUseVersion } from './legal/versions';
import type { NoticePlaces, NoticeVariant, SignedDetails } from './notice-composer';
import type { NoticeEvent, NoticeOutcome } from './notice-event';
import type { RecipientSuggestion, RecipientUnit } from './recipient-resolver';

// One Notice per recipient. Its text is composed when shown; Signed details are never stored here.
export type LocalNotice = {
  id: string;
  recipient: RecipientUnit;
  others: RecipientUnit[];
  places?: NoticePlaces;
  variant: NoticeVariant;
  askHandoff?: boolean;
  // Which local handoff raised the question; never sent to the server.
  handoffRoute?: NoticeRoute;
  // The Findings current at the first handoff, so the text stays what was handed over. Numbers and
  // dataset names the server returned; never composed text, Signed details or a private fix, never sent.
  handoffFindings?: FindingsResult;
  events: (NoticeEvent & { synced?: true; refused?: true })[];
  outcomes?: (NoticeOutcome & { synced?: true; refused?: true })[];
};
export type NoticeState = 'not_notified' | 'handed_to_mail_client' | 'confirmed_by_reporter';
export type NoticeRoute = 'mail' | 'pdf' | 'copy';

export type LocalReport = {
  lastActivityAt?: string;
  report: Report;
  privateFix?: DeviceFix;
  photos?: LocalPhoto[];
  note?: string;
  token: string;
  events: ({ kind: 'created'; at: string; details?: {
    privacy_policy_version: string; terms_of_use_version: string
  } } | { kind: 'synced'; at: string })[];
  findings: FindingsResult;
  /** The server lost this Report after accepting it; it is being uploaded again. */
  server_lost?: true;
  sync_error?: string;
  refused_version?: string;
  retry_at?: number;
  retry_reason?: 'network' | 'server' | 'rate_limit';
  retry_stage?: 'report' | 'findings' | 'events';
  notices?: LocalNotice[];
  noticePreparation?: {
    choices: { unit: RecipientUnit; selected: boolean }[];
    suggestion?: RecipientSuggestion;
    gminaAnswer?: string | null;
    gminaCorrection?: RecipientUnit;
    variant?: NoticeVariant;
  };
};

export type LocalWithdrawal = { id: string; token: string; at: string; retry_at?: number };
const withdrawalChannelName = 'bor-czuwa-withdrawal';

export type LocalDraft = {
  lastActivityAt?: string;
  id: string;
  eventType: number | null;
  capturedAt: string;
  /** Started from Zapisz miejsce i czas, so completion shows Co as its first step. */
  quickCapture?: true;
  /** "Nie przypominaj" was chosen on a reminder covering this Draft. */
  remindersOff?: true;
  fix?: DeviceFix;
  occurredMode?: 'now' | 'within_hours' | 'date_only';
  hoursAgo?: number;
  occurredDate?: string;
  species?: Report['species'];
  fromHome?: boolean;
  /** The exact Incident area the Reporter saved under; any geometry change leaves it stale. */
  confirmedArea?: IncidentArea;
  /** Only this method supplies the Incident location; the other method's choices stay local. */
  locationMethod?: 'map' | 'reporter';
  hearingBearing?: number;
  hearingDistanceM?: number;
  /** Drafts saved before distances were metres; see `hearingDistance`. */
  hearingDistanceBand?: 'under_500m' | '500m_to_1km' | 'over_1km';
  /** Selected reference and offset stay on this device; never included in the Report. */
  manualReference?: PlaceReference;
  manualLat?: string;
  manualLon?: string;
  /** How far from the chosen point it may have been, in metres. */
  pointRadiusM?: number;
  photos?: LocalPhoto[];
  note?: string;
  /** When the write that last changed each field started, in ms; lets a late journal entry take its turn. */
  writtenAt?: Record<string, number>;
};

interface Store extends DBSchema {
  reports: { key: string; value: LocalReport };
  withdrawals: { key: string; value: LocalWithdrawal };
  drafts: { key: string; value: LocalDraft };
  home: { key: string; value: { id: string; fix: DeviceFix } };
  signer: { key: string; value: { id: string; details: SignedDetails } };
}

// Async so a browser that refuses IndexedDB synchronously rejects like any other failure to open.
async function database() {
  return openDB<Store>('bor-czuwa', 6, {
    async upgrade(db, oldVersion, _newVersion, transaction) {
      if (oldVersion < 1) db.createObjectStore('reports', { keyPath: 'report.id' });
      if (oldVersion < 2) db.createObjectStore('drafts', { keyPath: 'id' });
      if (oldVersion < 3) db.createObjectStore('home', { keyPath: 'id' });
      if (oldVersion < 4) {
        let cursor = await transaction.objectStore('reports').openCursor();
        while (cursor) {
          if (cursor.value.report.event_type !== 'shot' && cursor.value.report.photo_sha256 === undefined) {
            await cursor.update({ ...cursor.value, report: { ...cursor.value.report, photo_sha256: [] } });
          }
          cursor = await cursor.continue();
        }
      }
      if (oldVersion < 5) db.createObjectStore('signer', { keyPath: 'id' });
      if (oldVersion < 6) db.createObjectStore('withdrawals', { keyPath: 'id' });
    }
  });
}

/** The browser refuses this site any storage, so no write can succeed until the Reporter allows it.
 * Firefox throws SecurityError; Chromium fails the open with UnknownError and its own permission message,
 * which no other UnknownError carries. */
export function storageDenied(cause: unknown) {
  return cause instanceof DOMException && (cause.name === 'SecurityError'
    || (cause.name === 'UnknownError' && /denied permission to access the database/i.test(cause.message)));
}

let keeping: Promise<boolean> | undefined;
/** Asks the browser, at most once per page load, to keep this site's data when space runs low.
 * Resolves true when the browser keeps it. */
export function keepStorage() {
  return keeping ??= (async () => {
    const storage = navigator.storage;
    if (await storage?.persisted?.()) return true;
    return !!(await storage?.persist?.());
  })().catch(() => false);
}

export async function getHome() {
  const db = await database();
  try { return (await db.get('home', 'mine'))?.fix; } finally { db.close(); }
}

/** Forgets the saved home only; Reports keep their own fixes. The next from-home Report saves it again. */
export async function forgetHome() {
  const db = await database();
  try { await db.delete('home', 'mine'); } finally { db.close(); }
}

/*
 * Two tabs can hold one Draft. Every write reads the stored record in its own transaction and puts back
 * only the fields its tab changed (see `mergeDraft`), and never creates a Draft that is gone.
 *
 * A page that is leaving cannot wait for that read: Chromium aborts a transaction its page did not
 * commit, and every write queued behind one still waiting for its read (measured). A leaving page has
 * two ways out. `draft-writer:<id>` in localStorage names the last write any tab started on the Draft,
 * or says `closed`. While it names this tab's own write, made from a copy holding every stored field,
 * nobody else has written since: the page puts its whole copy and commits it at once. Without that
 * proof (another tab wrote, the Draft is unknown, or localStorage refused the note) the page first
 * commits a journal entry of the fields it changed, then tries the merged write. A photo is also
 * kept on its own as soon as it is taken. Entries and photos go to a second database,
 * `bor-czuwa-pending`: Chromium runs one readwrite transaction at a time per database, so a write
 * there is never queued behind the Draft store (measured: committed at once beside a held
 * `bor-czuwa`, and kept when the page left). `bor-czuwa` keeps its version and shape.
 * `listDrafts` and `createReport` apply entries and photos to Drafts that still exist and delete
 * every one they read; deleting a Draft deletes its entries and photos.
 *
 * Closure is decided by IndexedDB, never by localStorage alone. A Draft is closed when its record is
 * gone; closing it also leaves a `closed:<id>` record in the pending database, which a photo put
 * checks in its own transaction. A save that finds the record gone rejects with DraftClosedError.
 * localStorage can only take the whole-copy shortcut away: the leaving page uses it only after
 * writing a fresh note that localStorage accepted, and closing a Draft removes the note first.
 */
type Fields = Record<string, unknown>;
type Change = JournalChange;
type JournalEntry = { id: string; draft: string; writer: string; at: number; changes: Record<string, Change> };
/** A photo kept on its own until a write of its Draft holds it. */
type KeptPhoto = { id: string; draft: string; photo: LocalPhoto };
/** A Draft that was deleted or saved as a Report: no photo is kept for it any more. */
type ClosedDraft = { id: string; draft: string };
type Connection = Awaited<ReturnType<typeof database>>;
interface Pending extends DBSchema { items: { key: string; value: JournalEntry | KeptPhoto | ClosedDraft } }
// Async like `database`, so a browser that refuses IndexedDB synchronously rejects instead of throwing.
const pendingDatabase = async () => openDB<Pending>('bor-czuwa-pending', 1, { upgrade(db) { db.createObjectStore('items', { keyPath: 'id' }); } });
type PendingConnection = Awaited<ReturnType<typeof pendingDatabase>>;
/** Opens both databases; if either open fails, the other connection is closed and the failure passed on. */
async function bothDatabases() {
  const [db, pending] = await Promise.allSettled([database(), pendingDatabase()]);
  if (db.status === 'fulfilled' && pending.status === 'fulfilled') return [db.value, pending.value] as const;
  if (db.status === 'fulfilled') db.value.close();
  if (pending.status === 'fulfilled') pending.value.close();
  throw db.status === 'rejected' ? db.reason : (pending as PromiseRejectedResult).reason;
}
const writerKey = (id: string) => `draft-writer:${id}`;
const closedNote = 'closed';
const journalPrefix = 'draft-journal:', photoPrefix = 'draft-photo:', closedKey = (draft: string) => `closed:${draft}`;
const range = (prefix: string, draft?: string) => {
  const start = prefix + (draft ? `${draft}:` : '');
  return IDBKeyRange.bound(start, start + String.fromCharCode(0xffff));
};

function readNote(key: string) {
  try { return localStorage.getItem(key); } catch { return null; }
}
/** False when localStorage refused the write. */
function writeNote(key: string, value: string | null) {
  try {
    if (value === null) localStorage.removeItem(key); else localStorage.setItem(key, value);
    return true;
  } catch { return false; }
}

/** Entries and photos waiting in the pending database, for one Draft or all, oldest entries first. */
async function pendingFor(pending: PendingConnection, draft?: string) {
  const [entries, photos] = await Promise.all([pending.getAll('items', range(journalPrefix, draft)), pending.getAll('items', range(photoPrefix, draft))]);
  return { entries: (entries as JournalEntry[]).sort((a, b) => a.at - b.at), photos: photos as KeptPhoto[] };
}
type Waiting = Awaited<ReturnType<typeof pendingFor>>;
/** Applies entries and kept photos to the Drafts that still exist, inside a transaction holding drafts. */
async function applyPending(drafts: { get(id: string): Promise<LocalDraft | undefined>; put(value: LocalDraft): Promise<unknown> }, { entries, photos }: Waiting) {
  for (const id of new Set([...entries, ...photos].map(item => item.draft))) {
    const stored = await drafts.get(id);
    if (!stored) continue;
    writeNote(writerKey(id), crypto.randomUUID());
    const recovered = replayJournal(stored, entries.filter(entry => entry.draft === id));
    const missing = photos.filter(kept => kept.draft === id && !recovered.photos?.some(photo => photo.id === kept.photo.id));
    if (missing.length) recovered.photos = [...recovered.photos ?? [], ...missing.map(kept => kept.photo)];
    await drafts.put(recovered);
  }
}
/** Deletes what was applied, or what belonged to a Draft that is gone. */
async function forgetPending(pending: PendingConnection, { entries, photos }: Waiting) {
  const transaction = pending.transaction('items', 'readwrite');
  await Promise.all([...[...entries, ...photos].map(item => transaction.store.delete(item.id)), transaction.done]);
}
/** Records a Draft as closed and deletes its entries and photos, in one transaction. */
async function closePending(pending: PendingConnection, draft: string) {
  const transaction = pending.transaction('items', 'readwrite');
  const doomed = await Promise.all([transaction.store.getAllKeys(range(journalPrefix, draft)), transaction.store.getAllKeys(range(photoPrefix, draft))]);
  await Promise.all([...doomed.flat().map(key => transaction.store.delete(key)), transaction.store.put({ id: closedKey(draft), draft }), transaction.done]);
}

/** The Draft was deleted or saved as a Report in another tab, so this copy must not be stored or become a Report. */
export class DraftClosedError extends Error {
  constructor(readonly draft?: string) { super('draft_closed'); this.name = 'DraftClosedError'; }
}

/** Keeps a Draft connection ready so a lifecycle flush can start its transaction before yielding. */
export function createDraftWriter() {
  let connection: Connection | undefined;
  let pending: PendingConnection | undefined;
  let opening: Promise<void> | undefined;
  /** Per Draft, this tab's last write token while that write came from a copy holding every stored field. */
  const whole = new Map<string, string>();
  /** Merged writes still waiting for their read, per Draft. Nothing is written by them until it answers. */
  const reading = new Map<string, Set<{ abort(): void }>>();
  const superseded = new WeakSet<object>();
  function prepare() {
    if (connection && pending) return Promise.resolve();
    return opening ??= bothDatabases().then(([db, side]) => {
      connection = db;
      pending = side;
      const invalidate = () => {
        db.close();
        side.close();
        if (connection === db) { connection = undefined; pending = undefined; opening = undefined; }
      };
      for (const target of [db, side]) {
        target.addEventListener('versionchange', invalidate);
        target.addEventListener('close', invalidate);
      }
    }).catch(cause => { opening = undefined; throw cause; });
  }
  /** Puts or deletes one item in the pending database, committed at once. */
  function pendingWrite(change: (store: IDBPObjectStore<Pending, ['items'], 'items', 'readwrite'>) => unknown) {
    if (!pending) return;
    const transaction = pending.transaction('items', 'readwrite');
    change(transaction.store);
    transaction.commit();
    void transaction.done.catch(() => {});
  }
  /**
   * Names a write this tab is starting. `complete`: the written copy is known to hold every stored field.
   * `noted`: localStorage accepted the new note just now.
   */
  function start(id: string, complete: boolean) {
    const seen = readNote(writerKey(id)), token = crypto.randomUUID(), at = Date.now();
    // A stale tab never overwrites a closure; its write then finds the Draft gone.
    // Only a note that localStorage kept can prove anything later.
    const noted = seen !== closedNote && writeNote(writerKey(id), token);
    // A merged write that follows this tab's own complete write, with nobody else's between, writes
    // this tab's newest copy: the stored record held nothing else to merge.
    if (noted && (complete || (seen !== null && seen === whole.get(id)))) whole.set(id, token); else whole.delete(id);
    return { seen, token, noted, at };
  }
  /** Proof that no other tab has started a write since this tab's last complete one. */
  function holdsAll(id: string) {
    const token = whole.get(id);
    return token !== undefined && readNote(writerKey(id)) === token;
  }
  /** Deletes kept photos once a stored record holds them. */
  function tidyPhotos(stored: LocalDraft) {
    if (stored.photos?.length) pendingWrite(store => { for (const photo of stored.photos!) void store.delete(`${photoPrefix}${stored.id}:${photo.id}`); });
  }
  /**
   * Reads, merges and puts in one transaction. Resolves to the stored record, null when the Draft is
   * gone, or undefined when a leaving write took this one's place.
   */
  function merge(draft: LocalDraft, base: LocalDraft, { token, at }: { token: string; at: number }): Promise<LocalDraft | null | undefined> {
    const transaction = connection!.transaction('drafts', 'readwrite');
    const waiting = reading.get(draft.id) ?? new Set();
    reading.set(draft.id, waiting.add(transaction));
    const written = transaction.store.get(draft.id).then(stored => {
      waiting.delete(transaction);
      // Deleted or saved as a Report elsewhere: nothing is written, so the Draft is not created again.
      if (!stored) return null;
      // Each changed field is stamped with the time this write started, the order writes land in.
      const merged = stamped(mergeDraft(stored, base, draft), changedFields(base, draft), at);
      void transaction.store.put(merged);
      transaction.commit();
      return merged;
    });
    return Promise.all([written, transaction.done]).then(([merged]) => {
      // Nobody wrote since, so this tab's copy now holds every stored field.
      if (merged && readNote(writerKey(draft.id)) === token) whole.set(draft.id, token);
      if (merged) tidyPhotos(merged);
      return merged;
    }, cause => {
      waiting.delete(transaction);
      // A leaving write took this one's place; it carries the same changes.
      if (superseded.has(transaction)) return undefined;
      throw cause;
    });
  }
  /**
   * A page that leaves loses a transaction still waiting for its read, and with it every write queued
   * behind it, committed or not. So before a whole-copy write this tab's waiting merged writes for the
   * Draft are ended; the whole copy carries their changes.
   */
  function supersede(id: string) {
    for (const transaction of reading.get(id) ?? []) {
      superseded.add(transaction);
      try { transaction.abort(); } catch { /* already committing: it finishes without this page */ }
    }
    reading.delete(id);
  }
  /** Stores a Draft this tab has just made; no other tab can have written it. */
  function create(draft: LocalDraft): Promise<LocalDraft> {
    if (!connection) return prepare().then(() => create(draft));
    start(draft.id, true);
    const transaction = connection.transaction('drafts', 'readwrite');
    const result = Promise.all([transaction.store.put(draft), transaction.done]);
    transaction.commit();
    return result.then(() => draft);
  }
  /**
   * Stores the fields this tab changed since `base` on top of the stored record. `base` is the copy this
   * tab's newest still-running write carries, or else the copy it last stored or loaded. Resolves to the
   * record as stored, or undefined when the Draft is gone.
   */
  function save(draft: LocalDraft, base: LocalDraft): Promise<LocalDraft | undefined> {
    if (!connection) return prepare().then(() => save(draft, base));
    return merge(draft, base, start(draft.id, false)).then(merged => merged === null ? closed(draft.id) : merged);
  }
  /** A write found the Draft gone: says so for any tab that missed it, lets go of what was kept for it, and rejects. */
  function closed(id: string): never {
    writeNote(writerKey(id), closedNote);
    if (pending) void closePending(pending, id).catch(() => {});
    throw new DraftClosedError(id);
  }
  /**
   * Puts a photo just taken on its own, committed at once and held up by no Draft write, unless the
   * Draft is already closed.
   */
  function keepPhoto(draft: string, photo: LocalPhoto) {
    if (!pending) return;
    const transaction = pending.transaction('items', 'readwrite');
    void transaction.store.get(closedKey(draft)).then(closure => closure ? undefined : transaction.store.put({ id: `${photoPrefix}${draft}:${photo.id}`, draft, photo }));
    void transaction.done.catch(() => {});
  }
  /** A photo removed before any write held it is not brought back. */
  function dropPhoto(draft: string, photo: string) {
    pendingWrite(store => void store.delete(`${photoPrefix}${draft}:${photo}`));
  }
  /**
   * The write for a page that may be gone before IndexedDB answers: it starts before this returns.
   * `stored` is the copy this tab last stored or loaded, `sent` the copy its newest still-running write
   * carries. See the note above `createDraftWriter`.
   */
  function leave(draft: LocalDraft, stored: LocalDraft | undefined, sent: LocalDraft | undefined): Promise<LocalDraft | undefined> {
    // Deleted or saved as a Report in another tab: there is nothing to keep, and nothing is written down.
    if (readNote(writerKey(draft.id)) === closedNote) return Promise.resolve(undefined);
    const proof = !!connection && holdsAll(draft.id);
    const note = start(draft.id, proof);
    // The proof holds only if localStorage still takes a note now: a closure it refused to record leaves an old one behind.
    if (proof && note.noted) {
      supersede(draft.id);
      const copy = stamped(draft, changedFields(stored ?? ({} as LocalDraft), draft), note.at);
      const transaction = connection!.transaction('drafts', 'readwrite');
      const result = Promise.all([transaction.store.put(copy), transaction.done]);
      // Start commit while this document can still send work to IndexedDB.
      transaction.commit();
      return result.then(() => copy);
    }
    const loaded = stored ?? ({} as LocalDraft), latest = sent ?? loaded;
    const newest = changedFields(latest, draft), changes: Record<string, Change> = {};
    // Photos are kept on their own as they are taken.
    for (const key of new Set([...changedFields(loaded, draft), ...newest])) if (key !== 'photos') {
      const before = ((newest.includes(key) ? latest : loaded) as Fields)[key], after = (draft as Fields)[key];
      changes[key] = { ...(before === undefined ? {} : { before }), ...(after === undefined ? {} : { after }), ...(newest.includes(key) ? {} : { pending: true as const }) };
    }
    const entry: JournalEntry = { id: `${journalPrefix}${draft.id}:${note.token}`, draft: draft.id, writer: note.token, at: note.at, changes };
    pendingWrite(store => void store.put(entry));
    if (!connection) return prepare().then(() => merge(draft, latest, note)).then(merged => merged ?? undefined);
    return merge(draft, latest, note).then(merged => {
      // The merged write landed, or the Draft is gone: the entry is not needed.
      if (merged === null && pending) void closePending(pending, draft.id).catch(() => {});
      else pendingWrite(store => void store.delete(entry.id));
      return merged ?? undefined;
    });
  }
  return { prepare, create, save, leave, keepPhoto, dropPhoto };
}

export async function listDrafts() {
  const [db, pending] = await bothDatabases();
  const sorted = (drafts: LocalDraft[]) => drafts.sort((a, b) => a.capturedAt.localeCompare(b.capturedAt));
  try {
    // Entries and photos left by a page that was gone before its merged write; usually there are none,
    // so the Drafts are read alongside them rather than after, and read again only when some were applied.
    const [waiting, listed] = await Promise.all([pendingFor(pending), db.getAll('drafts')]);
    if (!waiting.entries.length && !waiting.photos.length) return sorted(listed);
    const transaction = db.transaction('drafts', 'readwrite');
    await applyPending(transaction.store, waiting);
    await transaction.done;
    await forgetPending(pending, waiting);
    return sorted(await db.getAll('drafts'));
  }
  finally { db.close(); pending.close(); }
}

/**
 * Closing a Draft first names a new write, so no other tab can still prove its copy whole, and once
 * closed says so: a stale tab's leaving write then keeps nothing and writes nothing down.
 */
async function closingDraft(id: string, close: () => Promise<void>) {
  // Removing the note never needs space, so a full localStorage still takes the proof away.
  writeNote(writerKey(id), null);
  await close();
  writeNote(writerKey(id), closedNote);
}

export async function deleteDraft(id: string) {
  const [db, pending] = await bothDatabases();
  try {
    await closingDraft(id, async () => {
      await db.delete('drafts', id);
      await closePending(pending, id);
    });
  } finally { db.close(); pending.close(); }
}

/**
 * Saves a Draft as a Report. The Report is built from the stored record with the fields this tab changed
 * since `base` on top, so another tab's edits are in it; a Draft that is gone raises DraftClosedError.
 */
export async function createReport(mine: LocalDraft, base: LocalDraft) {
  writeNote(writerKey(mine.id), null);
  const token = Array.from(crypto.getRandomValues(new Uint8Array(32)),
    byte => byte.toString(16).padStart(2, '0')).join('');
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token));
  const tokenHash = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
  const [db, pending] = await bothDatabases();
  try {
    // An entry or photo another tab left for this Draft is part of what the Report is built from.
    const waiting = await pendingFor(pending, mine.id);
    const transaction = db.transaction(['reports', 'drafts', 'home'], 'readwrite');
    await applyPending(transaction.objectStore('drafts'), waiting);
    const stored = await transaction.objectStore('drafts').get(mine.id);
    if (!stored) throw new DraftClosedError(mine.id);
    const saved = mergeDraft(stored, base, mine);
    const photos = saved.photos ?? [];
    const fix = saved.fix;
    const home = await transaction.objectStore('home').get('mine');
    const issues = draftReadiness(saved, home?.fix);
    if (issues.length) throw new DraftValidationError(issues[0]);
    const draft = withResolvedHome(saved, home?.fix);
    const area = outgoingArea(draft);
    const chosen = choosesPoint(draft);
    const origin = placeOrigin(draft)!;
    const now = new Date().toISOString();
    const local: LocalReport = {
      lastActivityAt: now,
      report: {
        id: crypto.randomUUID(), event_type: eventTypes[draft.eventType!], captured_at: draft.capturedAt,
        occurred_at: draftOccurrence(draft),
        device_fix: area || chosen ? null : { ...fix! },
        incident_location: area ??
          (chosen ? { ...origin, source: 'moved_by_reporter' } : { lat: fix!.lat, lon: fix!.lon, source: 'device_fix' }),
        // Gatunek is asked only for remains and an injured animal; an older Draft's answer for another Event stays local.
        species: draft.eventType === 2 || draft.eventType === 3 ? draft.species ?? null : null,
        ...(draft.eventType !== 0 ? { photo_sha256: photos.map(photo => photo.sha256) } : {}),
        has_note: !!draft.note?.trim(), app_version: appVersion,
        privacy_policy_version: privacyPolicyVersion, terms_of_use_version: termsOfUseVersion,
        token_sha256: tokenHash
      },
      privateFix: fix && (area || chosen) ? { ...fix } : undefined,
      photos, note: draft.note ?? '',
      token, events: [{ kind: 'created', at: now, details: {
        privacy_policy_version: privacyPolicyVersion, terms_of_use_version: termsOfUseVersion
      } }], findings: { status: 'pending' }
    };
    await transaction.objectStore('reports').add(local);
    // Only a fix taken at home becomes the saved home; a point chosen later may be anywhere on the map.
    if (draft.fromHome && !home && fix && !chosen) await transaction.objectStore('home').put({ id: 'mine', fix });
    await transaction.objectStore('drafts').delete(draft.id);
    await transaction.done;
    writeNote(writerKey(mine.id), closedNote);
    await closePending(pending, mine.id);
    return local;
  } finally { db.close(); pending.close(); }
}

export async function listReports() {
  const db = await database();
  try {
    return (await db.getAll('reports')).sort((a, b) => a.events[0].at.localeCompare(b.events[0].at));
  } finally { db.close(); }
}

export async function hasReport(id: string) {
  const db = await database();
  try { return (await db.count('reports', id)) > 0; } finally { db.close(); }
}

export function isSynced(local: LocalReport) {
  return local.events.some(event => event.kind === 'synced');
}

export async function withdrawReport(local: LocalReport) {
  const db = await database();
  try {
    const transaction = db.transaction(['reports', 'withdrawals'], 'readwrite');
    const saved = await transaction.objectStore('reports').get(local.report.id);
    if (saved) {
      await transaction.objectStore('withdrawals').put({ id: saved.report.id, token: saved.token, at: new Date().toISOString() });
      await transaction.objectStore('reports').delete(saved.report.id);
    }
    await transaction.done;
    if (saved) {
      const channel = new BroadcastChannel(withdrawalChannelName);
      channel.postMessage(saved.report.id);
      channel.close();
    }
  } finally { db.close(); }
}

export function watchReportWithdrawals(onWithdrawal: (id: string) => void) {
  let channel: BroadcastChannel;
  // Firefox refuses the channel along with storage when site data is blocked; start-up must go on to find that out.
  try { channel = new BroadcastChannel(withdrawalChannelName); } catch { return () => {}; }
  channel.onmessage = event => { if (typeof event.data === 'string') onWithdrawal(event.data); };
  return () => channel.close();
}

export async function listWithdrawals() {
  const db = await database();
  try { return await db.getAll('withdrawals'); } finally { db.close(); }
}

export async function recordWithdrawalRetry(id: string, token: string, retryAt: number) {
  const db = await database();
  try {
    const transaction = db.transaction('withdrawals', 'readwrite');
    const saved = await transaction.store.get(id);
    if (saved?.token === token) await transaction.store.put({ ...saved, retry_at: retryAt });
    await transaction.done;
  } finally { db.close(); }
}

export async function retireWithdrawal(id: string, token: string) {
  const db = await database();
  try {
    const transaction = db.transaction('withdrawals', 'readwrite');
    const saved = await transaction.store.get(id);
    if (saved?.token === token) await transaction.store.delete(id);
    await transaction.done;
  } finally { db.close(); }
}

// Returns false when the Report is no longer on the phone.
export async function recordSync(id: string, update: { synced?: boolean; findings?: FindingsResult; error?: string; retryAt?: number; retryReason?: LocalReport['retry_reason']; retryStage?: LocalReport['retry_stage'] }) {
  const db = await database();
  try {
    const transaction = db.transaction('reports', 'readwrite');
    const local = await transaction.store.get(id);
    if (local) {
      const previous = JSON.stringify(local);
      if (update.synced === false) {
        if (isSynced(local)) local.server_lost = true;
        local.events = local.events.filter(event => event.kind !== 'synced');
        for (const notice of local.notices ?? []) {
          for (const event of [...notice.events, ...(notice.outcomes ?? [])]) {
            delete event.synced;
            delete event.refused;
          }
        }
      }
      if (update.synced && !isSynced(local)) local.events.push({ kind: 'synced', at: new Date().toISOString() });
      if (update.synced) delete local.server_lost;
      if (update.findings) local.findings = update.findings;
      local.sync_error = update.error;
      local.refused_version = update.error ? version : undefined;
      local.retry_at = update.retryAt;
      local.retry_reason = update.retryReason;
      local.retry_stage = update.retryStage;
      if (JSON.stringify(local) !== previous) await transaction.store.put(local);
    }
    await transaction.done;
    return !!local;
  } finally { db.close(); }
}

async function updateReport(id: string, change: (local: LocalReport) => void) {
  const db = await database();
  try {
    const transaction = db.transaction('reports', 'readwrite');
    const local = await transaction.store.get(id);
    if (local) { change(local); await transaction.store.put(local); }
    await transaction.done;
  } finally { db.close(); }
}

export function saveNoticePreparation(reportId: string, preparation: LocalReport['noticePreparation']) {
  return updateReport(reportId, local => { local.noticePreparation = preparation; });
}

export async function addNotices(reportId: string, notices: LocalNotice[]) {
  const db = await database();
  try {
    const transaction = db.transaction('reports', 'readwrite');
    const local = await transaction.store.get(reportId);
    if (!local) throw new Error('report_not_found');
    local.notices ??= [];
    const prepared = notices.map(notice => {
      const existing = local.notices!.find(item => item.recipient.kind === notice.recipient.kind &&
        item.recipient.id === notice.recipient.id && item.variant === notice.variant);
      if (existing) {
        existing.recipient = notice.recipient;
        existing.others = notice.others;
        existing.places = notice.places;
        local.lastActivityAt = new Date().toISOString();
        return existing;
      }
      local.notices!.push(notice);
      local.lastActivityAt = new Date().toISOString();
      return notice;
    });
    await transaction.store.put(local);
    await transaction.done;
    return prepared;
  } finally { db.close(); }
}

/** Keeps the Findings the handed-off text was composed from, not whatever storage holds by now. */
function freezeFindings(local: LocalReport, notice: LocalNotice, used?: FindingsResult) {
  notice.handoffFindings ??= structuredClone(used ?? local.findings);
}

/** A handed-off Notice reads the Findings it was handed over with; an unsent one follows the latest. */
export function noticeFindings(local: LocalReport, notice: LocalNotice): FindingsResult {
  return notice.handoffFindings ?? local.findings;
}

export function recordNoticeEvent(reportId: string, noticeId: string, event: NoticeEvent, used?: FindingsResult) {
  return updateReport(reportId, local => {
    const notice = local.notices?.find(item => item.id === noticeId);
    if (!notice) return;
    notice.events.push(event);
    local.lastActivityAt = event.at;
    notice.askHandoff = event.kind === 'handed_to_mail_client';
    if (notice.askHandoff) notice.handoffRoute = 'mail';
    // Only the handoff freezes; a confirmation never does, so an older handoff without a snapshot keeps following the Findings.
    if (event.kind === 'handed_to_mail_client') freezeFindings(local, notice, used);
  });
}

export function recordNoticeOutcome(reportId: string, noticeId: string, outcome: NoticeOutcome) {
  return updateReport(reportId, local => {
    const notice = local.notices?.find(item => item.id === noticeId);
    if (!notice || noticeState(notice) !== 'confirmed_by_reporter') return;
    // Older confirmations lack a Notice id. Re-send one linked event before its first outcome.
    const confirmation = notice.events.find(event => event.kind === 'confirmed_by_reporter');
    if (confirmation && !notice.events.some(event => event.kind === 'confirmed_by_reporter' && event.notice_id === noticeId)) {
      notice.events.push({ ...confirmation, id: crypto.randomUUID(), notice_id: noticeId, synced: undefined, refused: undefined });
    }
    notice.outcomes = [...(notice.outcomes ?? []), outcome];
    local.lastActivityAt = outcome.at;
  });
}

/** Asks "Udało się wysłać?" after a local handoff the server never hears of: a saved PDF or copied text. */
export function setHandoffQuestion(reportId: string, noticeId: string, ask: boolean, route?: NoticeRoute, used?: FindingsResult) {
  return updateReport(reportId, local => {
    const notice = local.notices?.find(item => item.id === noticeId);
    if (!notice) return;
    notice.askHandoff = ask;
    if (route) notice.handoffRoute = route;
    if (ask) freezeFindings(local, notice, used);
    local.lastActivityAt = new Date().toISOString();
  });
}

export function markNoticeEvent(reportId: string, eventId: string, outcome: 'synced' | 'refused') {
  return updateReport(reportId, local => {
    const event = local.notices?.flatMap(notice => [...notice.events, ...(notice.outcomes ?? [])]).find(item => item.id === eventId);
    if (event) event[outcome] = true;
  });
}

export function noticeState(notice: LocalNotice): NoticeState {
  if (notice.events.some(event => event.kind === 'confirmed_by_reporter')) return 'confirmed_by_reporter';
  if (notice.events.some(event => event.kind === 'handed_to_mail_client')) return 'handed_to_mail_client';
  return 'not_notified';
}

export function awaitingSignedNoticeReply(notice: LocalNotice) {
  if (notice.variant !== 'signed' || noticeState(notice) !== 'confirmed_by_reporter') return false;
  const outcome = notice.outcomes?.at(-1)?.outcome;
  return !outcome || outcome === 'no_answer_yet';
}

// Check-in interval only. It is not a filing deadline. "No reply yet" answers it and asks again six weeks later.
export function signedNoticeCheckInAt(notice: LocalNotice) {
  if (!awaitingSignedNoticeReply(notice)) return undefined;
  const confirmed = notice.events.find(event => event.kind === 'confirmed_by_reporter');
  if (!confirmed) return undefined;
  const since = notice.outcomes?.at(-1)?.at ?? confirmed.at;
  return new Date(Date.parse(since) + 42 * 24 * 60 * 60 * 1000);
}

export async function getSigner() {
  const db = await database();
  try { return (await db.get('signer', 'mine'))?.details; } finally { db.close(); }
}

export async function rememberSigner(details: SignedDetails | undefined) {
  const db = await database();
  try {
    if (details) await db.put('signer', { id: 'mine', details });
    else await db.delete('signer', 'mine');
  } finally { db.close(); }
}
