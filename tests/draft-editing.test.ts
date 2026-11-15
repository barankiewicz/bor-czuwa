import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';

type LocalDraft = { id: string; eventType: null; capturedAt: string; note?: string;
  fix?: { lat: number; lon: number; accuracy_m: number; at: string } };
type Doc = LocalDraft & Record<string, unknown>;
type DraftEditing = {
  create: (value: LocalDraft) => Promise<void>;
  change: (value: LocalDraft, edit: (value: LocalDraft) => LocalDraft, options?: { wait?: number }) => LocalDraft | undefined;
  flush: (leaving?: boolean) => Promise<void>;
  saveAsReport: (value: LocalDraft) => Promise<LocalDraft>;
  remove: (id: string) => Promise<void>;
  current: (id: string) => LocalDraft | undefined;
};

// Load the real module with only its storage boundary replaced; no browser or database is needed.
function load<T>(file: string, dependencies: Record<string, unknown>): T {
  const module = { exports: {} };
  const source = ts.transpileModule(readFileSync(new URL(file, import.meta.url), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
  }).outputText;
  runInNewContext(source, { module, exports: module.exports, require: (name: string) => dependencies[name] ?? {}, setTimeout, clearTimeout });
  return module.exports as T;
}

function deferred<T = void>() {
  let resolve!: (value: T) => void, reject!: (cause: unknown) => void;
  const promise = new Promise<T>((accept, refuse) => { resolve = accept; reject = refuse; });
  return { promise, resolve, reject };
}
const draft = (id = 'A'): LocalDraft => ({ id, eventType: null, capturedAt: '2026-11-05T00:00:00Z' });

const merge = load<object>('../src/lib/draft-merge.ts', {});
const { mergeDraft } = merge as { mergeDraft: (stored: Doc, base: Doc, mine: Doc) => Doc };
/** A writer whose create, save and leave all go through `save`, for tests about ordering and failures. */
const writer = (save: (value: LocalDraft) => Promise<unknown>) =>
  () => ({ prepare: async () => {}, create: save, save, leave: save, keepPhoto: () => {}, dropPhoto: () => {} });

function editor(overrides: Record<string, unknown> = {}) {
  const writes: LocalDraft[] = [], failures: unknown[] = [];
  const storage = {
    createDraftWriter: writer((value: LocalDraft) => { writes.push(value); return Promise.resolve(); }),
    createReport: async (value: LocalDraft) => value,
    deleteDraft: async () => {}, ...overrides
  };
  const { createDraftEditing } = load<{ createDraftEditing: (options: { changed: () => void; failed: (cause: unknown) => void }) => DraftEditing }>('../src/lib/draft-editing.ts', { './local-store': storage, './draft-merge': merge });
  return { edits: createDraftEditing({ changed: () => {}, failed: cause => failures.push(cause) }), writes, failures };
}

test('an idle flush starts storage now but resolves only after commit', async () => {
  const commit = deferred();
  const writes: LocalDraft[] = [];
  const { edits } = editor({ createDraftWriter: writer((value: LocalDraft) => { writes.push(value); return commit.promise; }) });
  edits.change(draft(), value => ({ ...value, note: 'pending' }), { wait: 400 });
  const flushed = edits.flush();
  assert.equal(writes.length, 1);
  assert.equal(writes[0].note, 'pending');
  let complete = false;
  void flushed.then(() => { complete = true; });
  await Promise.resolve();
  assert.equal(complete, false);
  commit.resolve();
  await flushed;
  assert.equal(complete, true);
});

test('flush rejects a running A failure even when submitted B succeeds, and A remains retryable', async () => {
  const first = deferred(), bStarted = deferred();
  const writes: LocalDraft[] = [];
  let hold = true;
  const { edits, failures } = editor({ createDraftWriter: writer((value: LocalDraft) => {
    writes.push(value);
    if (value.id === 'A' && hold) return first.promise;
    if (value.id === 'B') bStarted.resolve();
    return Promise.resolve();
  }) });
  edits.change(draft(), value => ({ ...value, note: 'A pending' }));
  edits.change(draft('B'), value => ({ ...value, note: 'B pending' }), { wait: 400 });
  const flushed = edits.flush();
  const refused = assert.rejects(flushed, /disk unavailable/);
  first.reject(new Error('disk unavailable'));
  await refused;
  await bStarted.promise;
  hold = false;
  await edits.flush();
  assert.equal(writes.filter(value => value.id === 'A').length, 2);
  assert.equal(failures.length, 1);
});

test('300 note edits retain the 400ms debounce and one newest-value write', async context => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  const { edits, writes } = editor();
  for (let count = 1; count <= 300; count++) edits.change(draft(), value => ({ ...value, note: 'x'.repeat(count) }), { wait: 400 });
  context.mock.timers.tick(399);
  assert.equal(writes.length, 0);
  context.mock.timers.tick(1);
  await edits.flush();
  assert.equal(writes.length, 1);
  assert.equal(writes[0].note?.length, 300);
});

test('flush also rejects A when B was already submitted before its snapshot', async () => {
  const first = deferred();
  let hold = true;
  const writes: string[] = [];
  const { edits } = editor({ createDraftWriter: writer((value: LocalDraft) => {
    writes.push(value.id);
    return value.id === 'A' && hold ? first.promise : Promise.resolve();
  }) });
  const a = edits.create(draft());
  const aRefused = assert.rejects(a, /disk unavailable/);
  const b = edits.create(draft('B'));
  const flushed = edits.flush();
  const flushRefused = assert.rejects(flushed, /disk unavailable/);
  first.reject(new Error('disk unavailable'));
  await aRefused;
  await flushRefused;
  await b;
  hold = false;
  await edits.flush();
  assert.deepEqual(writes, ['A', 'B', 'A']);
});

test('queued save uses the newest Draft and late changes cannot resurrect it', async () => {
  const first = deferred();
  let saved: LocalDraft | undefined;
  const { edits } = editor({ createDraftWriter: writer(() => first.promise), createReport: async (value: LocalDraft) => { saved = value; return value; } });
  edits.change(draft(), value => ({ ...value, note: 'first' }));
  const report = edits.saveAsReport(draft());
  edits.change(draft(), value => ({ ...value, note: 'newest', fix: { lat: 53, lon: 22, accuracy_m: 8, at: value.capturedAt } }), { wait: 400 });
  first.resolve();
  await report;
  assert.equal(saved?.note, 'newest');
  assert.equal(saved?.fix?.accuracy_m, 8);
  assert.equal(edits.change(draft(), value => ({ ...value, note: 'late' })), undefined);
  await edits.flush();
  assert.equal(edits.current('A'), undefined);
});

test('an awaited flush drains a note changed while its first commit is held', async () => {
  const first = deferred(), second = deferred(), secondStarted = deferred();
  const notes: (string | undefined)[] = [];
  const { edits } = editor({ createDraftWriter: writer((value: LocalDraft) => {
    notes.push(value.note);
    if (notes.length === 1) return first.promise;
    secondStarted.resolve();
    return second.promise;
  }) });
  edits.change(draft(), value => ({ ...value, note: 'first' }), { wait: 400 });
  const flushed = edits.flush();
  let complete = false;
  void flushed.then(() => { complete = true; });
  edits.change(draft(), value => ({ ...value, note: 'newest' }), { wait: 400 });
  first.resolve();
  await secondStarted.promise;
  assert.deepEqual(notes, ['first', 'newest']);
  assert.equal(complete, false);
  second.resolve();
  await flushed;
  assert.equal(complete, true);
});

test('a new write failure during an awaited flush rejects without silently retrying it', async () => {
  const first = deferred();
  let writes = 0;
  const { edits } = editor({ createDraftWriter: writer(() => ++writes === 1 ? first.promise : Promise.reject(new Error('new write refused'))) });
  edits.change(draft(), value => ({ ...value, note: 'first' }), { wait: 400 });
  const flushed = edits.flush();
  const refused = assert.rejects(flushed, /new write refused/);
  edits.change(draft(), value => ({ ...value, note: 'newest' }), { wait: 400 });
  first.resolve();
  await refused;
  assert.equal(writes, 2);
});

test('delete stays behind an active write and drops pending and late writes', async () => {
  const first = deferred();
  const order: string[] = [];
  const { edits } = editor({ createDraftWriter: writer(() => { order.push('write'); return first.promise; }), deleteDraft: async () => { order.push('delete'); } });
  edits.change(draft(), value => ({ ...value, note: 'first' }));
  edits.change(draft(), value => ({ ...value, note: 'pending' }), { wait: 400 });
  const removed = edits.remove('A');
  assert.equal(edits.change(draft(), value => ({ ...value, note: 'late' })), undefined);
  const flushed = edits.flush();
  assert.deepEqual(order, ['write']);
  first.resolve();
  await removed;
  await flushed;
  assert.deepEqual(order, ['write', 'delete']);
});

// Two tabs share one IndexedDB. This store keeps the writer's contract (read, merge, put in one step;
// nothing written for a Draft that is gone) with the real merge, so the editing logic is tested alone.
// Called without a base, as the code before the merge called it, it puts the whole copy as that code did.
const closedError = () => Object.assign(new Error('draft_closed'), { name: 'DraftClosedError' });
function sharedStore() {
  const stored = new Map<string, Doc>();
  let writes = 0;
  const leaves: { value: Doc; base?: Doc }[] = [];
  // While `hold` is set, a write is applied in the order it was submitted but answers its tab only on release.
  let hold: Promise<void> | undefined;
  const answer = <T>(value: T) => hold ? hold.then(() => value) : Promise.resolve(value);
  const merged = (value: Doc, base: Doc) => {
    writes++;
    const current = stored.get(value.id);
    if (!current) return null;
    const next = mergeDraft(current, base, value);
    stored.set(value.id, next);
    return next;
  };
  const storage = {
    createDraftWriter: () => ({
      prepare: async () => {}, keepPhoto: () => {}, dropPhoto: () => {},
      create: async (value: Doc) => { writes++; stored.set(value.id, value); return value; },
      // A save that finds the Draft gone rejects, as the real writer does; a leaving write just keeps nothing.
      save: (value: Doc, base?: Doc) => answer(base ? merged(value, base) : (writes++, stored.set(value.id, value), value))
        .then(result => { if (result === null) throw closedError(); return result; }),
      leave: (value: Doc, stored?: Doc, sent?: Doc) => { leaves.push({ value, base: sent ?? stored }); return answer(merged(value, sent ?? stored ?? ({} as Doc)) ?? undefined); }
    }),
    createReport: async (value: Doc, base?: Doc) => {
      if (!base) { stored.delete(value.id); return value; }
      const current = stored.get(value.id);
      if (!current) throw closedError();
      stored.delete(value.id);
      return mergeDraft(current, base, value);
    },
    deleteDraft: async (id: string) => { stored.delete(id); }
  };
  return { stored, storage, writes: () => writes, leaves, hold: (until?: Promise<void>) => { hold = until; } };
}
const twoTabs = () => {
  const shared = sharedStore();
  return { shared, a: editor(shared.storage).edits, b: editor(shared.storage).edits };
};
const plain = (value: unknown) => JSON.parse(JSON.stringify(value));

type Change = { before?: unknown; after?: unknown; pending?: true };
const replay = (stored: Doc, entries: { at: number; changes: Record<string, Change> }[]) =>
  (merge as { replayJournal: (stored: Doc, entries: { at: number; changes: Record<string, Change> }[]) => Doc }).replayJournal(stored, entries);

test('a journal entry made after another tab\'s stored write wins for the fields it changed, and loses to a later write', () => {
  // Tab B's write of the note started at 100; tab A left with its own note at 200, behind a held store.
  const stored = { ...draft(), note: 'B earlier', species: 1, writtenAt: { note: 100 } } as Doc;
  const later = replay(stored, [{ at: 200, changes: { note: { after: 'A later' } } }]);
  assert.equal(later.note, 'A later');
  assert.equal((later.writtenAt as Record<string, number>).note, 200);
  assert.equal(later.species, 1);
  // An entry older than the stored write does not put back the older answer.
  assert.equal(replay(stored, [{ at: 50, changes: { note: { after: 'A earlier' } } }]).note, 'B earlier');
  // A field an earlier write of the leaving tab already carried is taken only over the value that tab loaded.
  assert.equal(replay(stored, [{ at: 200, changes: { note: { before: 'loaded', after: 'A', pending: true } } }]).note, 'B earlier');
  assert.equal(replay({ ...stored, note: 'loaded' } as Doc, [{ at: 200, changes: { note: { before: 'loaded', after: 'A', pending: true } } }]).note, 'A');
});

test('mergeDraft applies only the fields this tab changed', () => {
  const base = { ...draft(), hoursAgo: 2 } as Doc;
  const stored = { ...base, note: 'from B', species: 1 } as Doc;
  assert.deepEqual(plain(mergeDraft(stored, base, { ...base, occurredMode: 'within_hours' } as Doc)), { ...stored, occurredMode: 'within_hours' });
  // Equal nested values are not a change; a removed field is.
  assert.deepEqual(plain(mergeDraft(stored, { ...base, fix: { lat: 1, lon: 2 } } as Doc, { ...base, fix: { lat: 1, lon: 2 } } as Doc)), stored);
  const { hoursAgo: _removed, ...without } = base;
  assert.equal('hoursAgo' in mergeDraft(stored, base, without as Doc), false);
  assert.equal((mergeDraft(stored, base, without as Doc) as Doc).note, 'from B');
});

test('a photo is the same photo by its id, though IndexedDB hands each tab its own Blob copy', () => {
  const photo = (id: string) => ({ id, sha256: id, jpeg: new Blob([id]) });
  const base = { ...draft(), photos: [photo('1')] } as Doc;
  // Tab A added photo 2; tab B reads photo 1 back as a different Blob object and writes only a note.
  const stored = { ...base, photos: [photo('1'), photo('2')] } as Doc;
  const mine = { ...base, photos: [photo('1')], note: 'from B' } as Doc;
  const merged = mergeDraft(stored, base, mine) as Doc & { photos: { id: string }[] };
  assert.deepEqual(merged.photos.map(item => item.id), ['1', '2']);
  assert.equal(merged.note, 'from B');
  // Removing a photo is a change.
  assert.deepEqual((mergeDraft(stored, base, { ...base, photos: [] } as Doc) as typeof merged).photos, []);
});

for (const order of ['AB', 'BA']) test(`two tabs keep both fields, tab ${order[0]} first`, async () => {
  const { shared, a, b } = twoTabs();
  await a.create(draft() as Doc);
  const copy = shared.stored.get('A')!;
  const time = () => { a.change(copy, value => ({ ...value, occurredMode: 'within_hours' } as Doc)); return a.flush(); };
  const note = () => { b.change(copy, value => ({ ...value, note: 'note from B' })); return b.flush(); };
  await (order === 'AB' ? time() : note());
  await (order === 'AB' ? note() : time());
  assert.equal(shared.stored.get('A')!.occurredMode, 'within_hours');
  assert.equal(shared.stored.get('A')!.note, 'note from B');
});

test('the later write wins when both tabs change one field', async () => {
  const { shared, a, b } = twoTabs();
  await a.create(draft() as Doc);
  const copy = shared.stored.get('A')!;
  a.change(copy, value => ({ ...value, hoursAgo: 2 } as Doc)); await a.flush();
  b.change(copy, value => ({ ...value, hoursAgo: 3 } as Doc)); await b.flush();
  a.change(copy, value => ({ ...value, note: 'A note' })); await a.flush();
  assert.equal(shared.stored.get('A')!.hoursAgo, 3);
  assert.equal(shared.stored.get('A')!.note, 'A note');
});

test('a tab adopts the merged record without telling the screen, and keeps edits made while storing', async () => {
  const { shared, a, b } = twoTabs();
  await a.create(draft() as Doc);
  const copy = shared.stored.get('A')!;
  b.change(copy, value => ({ ...value, note: 'from B' })); await b.flush();
  a.change(copy, value => ({ ...value, species: 1 } as Doc)); await a.flush();
  assert.equal(a.current('A')!.note, 'from B');
  assert.equal((a.current('A') as Doc).species, 1);
});

test('a Report from a tab that never saw the other tab\'s edits has both', async () => {
  const { shared, a, b } = twoTabs();
  await a.create(draft() as Doc);
  const copy = shared.stored.get('A')!;
  a.change(copy, value => ({ ...value, occurredMode: 'within_hours' } as Doc)); await a.flush();
  b.change(copy, value => ({ ...value, note: 'from B' })); await b.flush();
  const report = await a.saveAsReport(copy) as Doc;
  assert.equal(report.occurredMode, 'within_hours');
  assert.equal(report.note, 'from B');
});

for (const leaving of [false, true]) test(`a Draft deleted in another tab is not brought back by a late ${leaving ? 'leaving ' : ''}edit`, async () => {
  const { shared, a, b } = twoTabs();
  await a.create(draft() as Doc);
  const copy = shared.stored.get('A')!;
  await b.remove('A');
  a.change(copy, value => ({ ...value, note: 'late' }), { wait: 400 });
  // A save that finds the Draft gone rejects; a leaving write keeps nothing and says nothing.
  if (leaving) await a.flush(true); else await assert.rejects(a.flush(), /draft_closed/);
  assert.equal(shared.stored.size, 0);
});

test('a write that finds the Draft gone closes it in this tab, so no later edit or leaving write is tried', async () => {
  const { shared, a, b } = twoTabs();
  await a.create(draft() as Doc);
  const copy = shared.stored.get('A')!;
  await b.remove('A');
  a.change(copy, value => ({ ...value, note: 'late' }));
  await assert.rejects(a.flush(), /draft_closed/);
  assert.equal(a.current('A'), undefined);
  assert.equal(a.change(copy, value => ({ ...value, note: 'later' })), undefined);
  const leavesBefore = shared.leaves.length;
  await a.flush(true);
  assert.equal(shared.leaves.length, leavesBefore);
  assert.equal(shared.stored.size, 0);
});

test('a stale tab whose Draft was saved as a Report elsewhere stops and builds no second Report', async () => {
  const { shared, a, b } = twoTabs();
  await a.create(draft() as Doc);
  const copy = shared.stored.get('A')!;
  b.change(copy, value => ({ ...value, note: 'from B' })); await b.flush();
  await b.saveAsReport(copy);
  a.change(copy, value => ({ ...value, note: 'x' }));
  await assert.rejects(a.saveAsReport(copy), /draft_closed/);
  assert.equal(a.current('A'), undefined);
  assert.equal(a.change(copy, value => ({ ...value, note: 'y' })), undefined);
  assert.equal(shared.stored.size, 0);
});

test('a burst of 300 characters in one tab writes once and loses nothing', async () => {
  const { shared, a } = twoTabs();
  await a.create(draft() as Doc);
  const copy = shared.stored.get('A')!, before = shared.writes();
  let text = '';
  for (let i = 0; i < 300; i++) { text += 'x'; a.change(copy, value => ({ ...value, note: text }), { wait: 400 }); }
  await a.flush();
  assert.equal(shared.stored.get('A')!.note!.length, 300);
  assert.equal(shared.writes() - before, 1);
});

test('a leaving flush also sends a change whose store started but has not finished', async () => {
  const held = deferred<Doc | undefined>();
  const leaves: { value: Doc; base?: Doc }[] = [];
  const { edits } = editor({ createDraftWriter: () => ({ prepare: async () => {}, keepPhoto: () => {}, dropPhoto: () => {}, create: async (value: Doc) => value,
    save: () => held.promise, leave: async (value: Doc, stored?: Doc) => { leaves.push({ value, base: stored }); return value; } }) });
  const copy = draft() as Doc;
  edits.change(copy, value => ({ ...value, occurredMode: 'within_hours' } as Doc));
  // That store waits on the database; the page leaves now.
  void edits.flush(true);
  assert.equal(leaves.length, 1, 'the leaving write must start before flush yields');
  assert.equal(leaves[0].value.occurredMode, 'within_hours');
  assert.equal(leaves[0].base?.occurredMode, undefined);
  held.resolve(undefined);
});

test('a later edit does not send again a field an earlier, still-running write carries', async () => {
  const { shared, a, b } = twoTabs();
  await a.create(draft() as Doc);
  const copy = shared.stored.get('A')!;
  const release = deferred();
  shared.hold(release.promise);
  // Queued in this order: A's 2 hours, B's 3 hours, then A's note. A has heard back from none of them.
  a.change(copy, value => ({ ...value, hoursAgo: 2 } as Doc));
  b.change(copy, value => ({ ...value, hoursAgo: 3 } as Doc));
  a.change(copy, value => ({ ...value, note: 'A note' }));
  release.resolve();
  await Promise.all([a.flush(), b.flush()]);
  assert.equal(shared.stored.get('A')!.hoursAgo, 3);
  assert.equal(shared.stored.get('A')!.note, 'A note');
});

test('a photo is kept on its own as it is taken, and let go when it is removed', async () => {
  const kept: string[] = [], dropped: string[] = [];
  const { edits } = editor({ createDraftWriter: () => ({ prepare: async () => {}, create: async (value: Doc) => value, save: async (value: Doc) => value,
    leave: async (value: Doc) => value,
    keepPhoto: (_draft: string, photo: { id: string }) => kept.push(photo.id), dropPhoto: (_draft: string, id: string) => dropped.push(id) }) });
  const copy = draft() as Doc;
  edits.change(copy, value => ({ ...value, photos: [{ id: 'p1', sha256: 'x', jpeg: new Blob(['1']) }] } as Doc));
  edits.change(copy, value => ({ ...value, note: 'n' }));
  edits.change(copy, value => ({ ...value, photos: [] } as Doc));
  await edits.flush();
  assert.deepEqual(kept, ['p1']);
  assert.deepEqual(dropped, ['p1']);
});
