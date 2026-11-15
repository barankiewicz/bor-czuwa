// When Draft reminders fire and what they say. The native plugin is passed in, so the policy runs
// the same in unit tests as on the phone.

const warsaw = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Warsaw', year: 'numeric', month: '2-digit',
  day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });

function warsawParts(at: number) {
  const parts = Object.fromEntries(warsaw.formatToParts(new Date(at)).map(part => [part.type, part.value]));
  return { y: Number(parts.year), m: Number(parts.month), d: Number(parts.day), h: Number(parts.hour), min: Number(parts.minute) };
}

/** 10:00 Warsaw time on the Warsaw calendar day `days` after the one containing `at`. */
function warsawTenOClock(at: number, days: number) {
  const { y, m, d } = warsawParts(at);
  const guess = Date.UTC(y, m - 1, d + days, 10);
  const seen = warsawParts(guess);
  const offset = Date.UTC(seen.y, seen.m - 1, seen.d, seen.h, seen.min) - guess;
  return new Date(guess - offset);
}

/** The two reminder times of a Draft: the morning after capture and day 3, both at 10:00 Warsaw time. */
export function draftReminderSlots(capturedAt: string) {
  const at = new Date(capturedAt).getTime();
  return [warsawTenOClock(at, 1), warsawTenOClock(at, 3)];
}

export type RemindedDraft = { id: string; capturedAt: string; remindersOff?: true };
/** One reminder per Warsaw day, covering every Draft with a slot on that day. */
export type PlannedReminder = { day: string; at: Date; draftIds: string[] };

const warsawDay = (at: Date) => {
  const { y, m, d } = warsawParts(at.getTime());
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
};

/** Reminders still to come. A slot already past is skipped rather than moved later. */
export function planDraftReminders(drafts: RemindedDraft[], now: Date): PlannedReminder[] {
  const days = new Map<string, PlannedReminder>();
  for (const draft of drafts) {
    if (draft.remindersOff) continue;
    for (const at of draftReminderSlots(draft.capturedAt)) {
      if (at.getTime() <= now.getTime()) continue;
      const day = warsawDay(at);
      const planned = days.get(day) ?? { day, at, draftIds: [] };
      planned.draftIds.push(draft.id);
      days.set(day, planned);
    }
  }
  return [...days.values()].sort((a, b) => a.at.getTime() - b.at.getTime());
}

type Listed = { id: number; title?: string; body?: string; isExactNotification?: boolean; schedule?: { at?: Date | string }; extra?: Record<string, unknown> };
/** The part of the local notifications plugin that Draft reminders use. */
export type NotificationsPort = {
  getPending(): Promise<{ notifications: Listed[] }>;
  schedule(options: { notifications: {
    id: number; title: string; body: string; channelId: string; actionTypeId: string; isExactNotification: boolean;
    schedule: { at: Date }; extra: { draftReminderDay: string; draftIds: string[]; guard: string };
  }[] }): Promise<unknown>;
  cancel(options: { notifications: { id: number }[] }): Promise<void>;
  getDeliveredNotifications(): Promise<{ notifications: { id: number }[] }>;
  removeDeliveredNotificationsById(options: { ids: number[] }): Promise<void>;
};

/** The Android channel MainActivity creates for Draft reminders. */
export const draftReminderChannel = 'draft-reminders';
/** The action type carrying "Dokończ" and "Nie przypominaj". */
export const draftReminderActionType = 'draft-reminder-actions';

/** What a Draft reminder carries for the app: its Warsaw day and the Drafts it covers. */
export type ReminderExtra = { day: string; draftIds: string[] };
/** Reads a notification's extra as a Draft reminder's, or undefined for any other notification. */
export function reminderExtra(extra: Record<string, unknown> | undefined): ReminderExtra | undefined {
  if (typeof extra?.draftReminderDay !== 'string' || !Array.isArray(extra.draftIds)) return undefined;
  return { day: extra.draftReminderDay, draftIds: extra.draftIds.filter((id): id is string => typeof id === 'string') };
}

/** A reminder's Android id. The install's guard is mixed in so the Warsaw day alone cannot name it. */
export function notificationId(key: string, guard: string) {
  let hash = 2166136261;
  for (const char of `${guard}:${key}`) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619);
  return hash & 0x7fffffff;
}

const sameIds = (a: string[], b: string[]) => a.length === b.length && a.every((id, index) => id === b[index]);

/**
 * Makes the plugin's Draft reminders match the plan. A reminder whose time has passed was delivered and is
 * never scheduled again; it is only withdrawn from the shade when none of its Drafts wants reminding.
 */
export async function syncDraftReminders(port: NotificationsPort, drafts: RemindedDraft[], options: {
  now: Date; enabled: boolean; exact: boolean; guard: string | undefined; text: (draftIds: string[]) => { title: string; body: string };
}) {
  // The app shell's guard could not be read: nothing can be trusted when tapped, so nothing is changed.
  if (options.guard === undefined) return [];
  const guard = options.guard;
  const plan = options.enabled ? planDraftReminders(drafts, options.now) : [];
  const wanted = new Map(plan.map(item => {
    const { title, body } = options.text(item.draftIds);
    return [notificationId(`draft-reminder:${item.day}`, guard), { ...item, title, body }] as const;
  }));
  const reminding = new Set(options.enabled ? drafts.filter(draft => !draft.remindersOff).map(draft => draft.id) : []);
  const { notifications } = await port.getPending();
  const cancel: number[] = [];
  const withdraw: number[] = [];
  const kept = new Set<number>();
  for (const item of notifications) {
    const extra = item.extra ?? {};
    // Earlier versions kept one reminder per Draft under its id.
    if (typeof extra.draftId === 'string') { cancel.push(item.id); continue; }
    const reminder = reminderExtra(extra);
    if (!reminder) continue;
    const at = item.schedule?.at ? new Date(item.schedule.at).getTime() : NaN;
    if (at <= options.now.getTime()) {
      if (!reminder.draftIds.some(id => reminding.has(id))) { cancel.push(item.id); withdraw.push(item.id); }
      continue;
    }
    const want = wanted.get(item.id);
    if (want && want.title === item.title && want.body === item.body && item.isExactNotification === options.exact && extra.guard === guard && sameIds(reminder.draftIds, want.draftIds)) kept.add(item.id);
    else cancel.push(item.id);
  }
  if (cancel.length) await port.cancel({ notifications: cancel.map(id => ({ id })) });
  if (withdraw.length) {
    const shown = new Set((await port.getDeliveredNotifications()).notifications.map(item => item.id));
    const ids = withdraw.filter(id => shown.has(id));
    if (ids.length) await port.removeDeliveredNotificationsById({ ids });
  }
  const due = [...wanted].filter(([id]) => !kept.has(id));
  if (due.length) await port.schedule({ notifications: due.map(([id, item]) => ({
    id, title: item.title, body: item.body, channelId: draftReminderChannel, actionTypeId: draftReminderActionType,
    isExactNotification: options.exact, schedule: { at: item.at }, extra: { draftReminderDay: item.day, draftIds: item.draftIds, guard }
  })) });
  return plan;
}

/** The part of the local notifications plugin that follow-up checks use. */
export type FollowUpPort = {
  getPending(): Promise<{ notifications: Listed[] }>;
  schedule(options: { notifications: {
    id: number; title: string; body: string; channelId: string; isExactNotification: boolean;
    schedule: { at: Date }; extra: { followUpNoticeId: string; guard: string };
  }[] }): Promise<{ warning?: unknown }>;
  cancel(options: { notifications: { id: number }[] }): Promise<void>;
  getDeliveredNotifications(): Promise<{ notifications: Listed[] }>;
  removeDeliveredNotificationsById(options: { ids: number[] }): Promise<void>;
};

/**
 * Makes the plugin's follow-up checks match the signed Notices that await a reply. A check made before
 * reminders carried the guard sits under an id the Notice id gives away, so it is replaced.
 * Returns false when a check could only be scheduled inexactly.
 */
export async function reconcileFollowUps(port: FollowUpPort, current: Iterable<readonly [string, Date]>,
  options: { guard: string; now: Date; title: string }) {
  const wanted = new Map(current);
  const pending = await port.getPending();
  const obsolete = pending.notifications.filter(item => typeof item.extra?.followUpNoticeId === 'string' &&
    (!wanted.has(item.extra.followUpNoticeId) || item.extra.guard !== options.guard));
  if (obsolete.length) await port.cancel({ notifications: obsolete.map(item => ({ id: item.id })) });
  const delivered = await port.getDeliveredNotifications();
  const dismissed = delivered.notifications.filter(item => typeof item.extra?.followUpNoticeId === 'string' &&
    !wanted.has(item.extra.followUpNoticeId));
  if (dismissed.length) await port.removeDeliveredNotificationsById({ ids: dismissed.map(item => item.id) });
  const scheduled = new Map(pending.notifications.filter(item => !obsolete.includes(item)).map(item => [item.extra?.followUpNoticeId, item] as const));
  let scheduledExactly = true;
  for (const [id, at] of wanted) {
    // "No reply yet" moves the check-in, so a reminder pending for the old time is scheduled again over its id.
    const existing = scheduled.get(id);
    const pendingAt = existing?.schedule?.at ? new Date(existing.schedule.at).getTime() : NaN;
    // An unreadable pending time keeps the reminder rather than rescheduling it on every start.
    if ((existing?.title === options.title && (Number.isNaN(pendingAt) || Math.abs(pendingAt - at.getTime()) < 60_000)) || at.getTime() <= options.now.getTime()) continue;
    const result = await port.schedule({ notifications: [{
      id: notificationId(`follow-up:${id}`, options.guard), title: options.title,
      body: 'Sprawdź, czy urząd odpowiedział na Twoje powiadomienie.',
      channelId: 'follow-up-checks', schedule: { at }, isExactNotification: false,
      extra: { followUpNoticeId: id, guard: options.guard }
    }] });
    if (result.warning) scheduledExactly = false;
  }
  return scheduledExactly;
}
