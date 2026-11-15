import type { IncidentArea } from './report';
import { createReport, deleteDraft, createDraftWriter, type LocalDraft } from './local-store';
import { changedFields, mergeDraft } from './draft-merge';

/**
 * The one path every Draft write takes: field edits, the device fix, the Event choice, capture,
 * pause, saving as a Report and deleting. A change is applied at once to the newest copy of its
 * Draft, never to a copy the caller held from earlier. Native Draft transactions are submitted
 * in order without waiting for earlier commits. Saving as a Report and deleting wait for earlier
 * work and block later submissions. Once closed, a Draft cannot be brought back by a late write,
 * not even from another tab. Another tab's edits to other fields of the same Draft are kept: a store
 * applies only the fields this tab changed since it last stored or loaded the Draft.
 */
export function createDraftEditing({ changed, failed }: {
  /** Told the newest copy after every accepted change, so the screen shows what will be stored. */
  changed: (draft: LocalDraft) => void;
  /** Told when a background store fails; awaited writes reject to their caller instead. */
  failed: (cause: unknown) => void;
}) {
  const newest = new Map<string, LocalDraft>();
  /** The copy of each Draft this tab last stored or loaded; what it changed is measured against it. */
  const base = new Map<string, LocalDraft>();
  /**
   * The copy each Draft's newest still-running write carries. The next write measures its changes
   * against it, so a field an earlier write already sent is not sent again over another tab's answer
   * that landed between them.
   */
  const sent = new Map<string, LocalDraft>();
  /** Drafts whose write failed while a later one was running: the next write measures from `base` again. */
  const rebase = new Set<string>();
  const unstored = new Set<string>();
  const closed = new Set<string>();
  const writer = createDraftWriter();
  const inFlight = new Set<Promise<unknown>>();
  const waiting: (() => void)[] = [];
  let waitingHead = 0;
  let blocked = false;
  let failureVersion = 0;
  let lastFailure: unknown;
  let pending: ReturnType<typeof setTimeout> | undefined;

  function then<T>(step: () => Promise<T>, terminal = false) {
    let resolve!: (value: T | PromiseLike<T>) => void;
    let reject!: (cause: unknown) => void;
    const next = new Promise<T>((accept, refuse) => { resolve = accept; reject = refuse; });
    const previous = terminal && inFlight.size ? Promise.allSettled(inFlight) : undefined;
    inFlight.add(next);
    const run = () => {
      try { step().then(resolve, reject); } catch (cause) { reject(cause); }
    };
    const start = () => {
      if (terminal) blocked = true;
      // Native transactions order Draft stores; only terminal operations await earlier commits.
      if (previous) void previous.then(run, run);
      else run();
    };
    const settled = () => {
      inFlight.delete(next);
      if (terminal) {
        blocked = false;
        // Submit older waiting work before callers can enqueue more work after this terminal.
        while (!blocked && waitingHead < waiting.length) waiting[waitingHead++]!();
        if (waitingHead === waiting.length) { waiting.length = 0; waitingHead = 0; }
      }
    };
    void next.then(settled, cause => { failureVersion++; lastFailure = cause; settled(); });
    if (blocked) waiting.push(start);
    else start();
    return next;
  }
  /**
   * Takes the stored record as this tab's base, and as its newest copy with any edit made since `sent`
   * laid on top. Screens are not told: they pick it up at their next change or when re-entered.
   */
  function adopt(id: string, sent: LocalDraft, stored: LocalDraft | undefined) {
    // Gone in another tab: nothing was written, and this tab's copy stays as it is.
    if (!stored || closed.has(id)) return;
    base.set(id, stored);
    const latest = newest.get(id);
    newest.set(id, latest && latest !== sent ? mergeDraft(stored, sent, latest) : stored);
  }
  /**
   * Stores whatever is newest when its turn comes, so a burst of changes costs one write.
   * `leaving`: the page may be gone before IndexedDB answers, so the write starts before this yields.
   */
  function store(id: string, leaving = false) {
    return then(async () => {
      const draft = newest.get(id);
      if (!draft || (!leaving && !unstored.has(id)) || closed.has(id)) return;
      unstored.delete(id);
      const stored = base.get(id), running = rebase.has(id) ? undefined : sent.get(id), known = running ?? stored;
      rebase.delete(id);
      sent.set(id, draft);
      try {
        const written = await (leaving ? writer.leave(draft, stored, running) : known ? writer.save(draft, known) : writer.create(draft));
        if (sent.get(id) === draft) sent.delete(id);
        adopt(id, draft, written);
      }
      catch (cause) {
        // Deleted or saved as a Report in another tab: this tab stops editing it and forgets its copy.
        if ((cause as Error)?.name === 'DraftClosedError') { close(id); throw cause; }
        if (sent.get(id) === draft) sent.delete(id); else rebase.add(id);
        // An older failure must not dirty a newer value already submitted for storage.
        if (newest.get(id) === draft) unstored.add(id);
        throw cause;
      }
    });
  }
  /**
   * Stores every change not stored yet, the waiting note included. Resolves once all are on the phone.
   * `leaving` also covers changes whose store has started but not finished: a page that is leaving
   * loses a transaction it has not committed.
   */
  function flush(leaving = false): Promise<void> {
    clearTimeout(pending);
    pending = undefined;
    const failuresBefore = failureVersion;
    const running = [...inFlight];
    const ids = leaving
      ? [...newest].filter(([id, draft]) => !closed.has(id) && (unstored.has(id) || !base.has(id) || changedFields(base.get(id)!, draft).length)).map(([id]) => id)
      : [...unstored];
    const stores = ids.map(id => {
      const stored = store(id, leaving);
      stored.catch(failed);
      return stored;
    });
    // An already-running write must also succeed before an awaited flush can claim durability.
    return Promise.all([...running, ...stores]).then(() => {
      if (failureVersion !== failuresBefore) throw lastFailure;
      // Edits accepted while storage was busy belong to this awaited flush too.
      if (unstored.size || inFlight.size) return flush(leaving);
    });
  }

  function close(id: string) {
    closed.add(id);
    newest.delete(id);
    base.delete(id);
    sent.delete(id);
    unstored.delete(id);
  }

  return {
    prepare: writer.prepare,
    flush,
    /** The newest copy of a Draft this session has changed; undefined once it is a Report or deleted. */
    current: (id: string) => closed.has(id) ? undefined : newest.get(id),
    isClosed: (id: string) => closed.has(id),
    /** Stores a new Draft. */
    create(draft: LocalDraft) {
      newest.set(draft.id, draft);
      unstored.add(draft.id);
      return store(draft.id);
    },
    /**
     * Applies `change` to the newest copy of `draft` and stores it in turn. With `wait`, the store
     * waits until no change has come for that many milliseconds, or until `flush`.
     * Returns the changed copy, or undefined when the Draft is already a Report or deleted.
     */
    change(draft: LocalDraft, change: (newest: LocalDraft) => LocalDraft, { wait }: { wait?: number } = {}) {
      if (closed.has(draft.id)) return undefined;
      if (!base.has(draft.id)) base.set(draft.id, draft);
      const previous = newest.get(draft.id) ?? draft;
      const next = change(previous);
      // A photo is put on its own as it is taken, so no wait for the Draft's write can lose it.
      for (const photo of next.photos ?? []) if (!previous.photos?.some(item => item.id === photo.id)) writer.keepPhoto(draft.id, photo);
      for (const photo of previous.photos ?? []) if (!next.photos?.some(item => item.id === photo.id)) writer.dropPhoto(draft.id, photo.id);
      newest.set(draft.id, next);
      unstored.add(draft.id);
      changed(next);
      clearTimeout(pending);
      if (wait) pending = setTimeout(() => { void flush().catch(() => {}); }, wait);
      else void flush().catch(() => {});
      return next;
    },
    /** Saves the newest copy as a Report after every earlier write, then closes the Draft. */
    saveAsReport(draft: LocalDraft, confirmedArea?: IncidentArea | null) {
      clearTimeout(pending);
      pending = undefined;
      return then(async () => {
        const saved = newest.get(draft.id) ?? draft;
        // This tab may not have seen another tab's edits; the Report is built from the stored record with this tab's changes on top.
        const report = await createReport(confirmedArea ? { ...saved, confirmedArea } : saved, base.get(draft.id) ?? draft).catch(cause => {
          // Deleted or saved as a Report in another tab: closed here too, never a second Report.
          if ((cause as Error)?.name === 'DraftClosedError') close(draft.id);
          throw cause;
        });
        close(draft.id);
        return report;
      }, true);
    },
    /** Deletes a Draft; any write still waiting for it is dropped. */
    remove(id: string) {
      closed.add(id);
      return then(() => deleteDraft(id), true).then(() => close(id), cause => {
        closed.delete(id);
        throw cause;
      });
    }
  };
}
