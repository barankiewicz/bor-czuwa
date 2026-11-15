import assert from 'node:assert/strict';
import { test } from 'node:test';
import { notificationId, reconcileFollowUps, draftReminderSlots, planDraftReminders, syncDraftReminders, type NotificationsPort } from '../src/lib/draft-reminders.ts';

const iso = (dates: Date[]) => dates.map(date => date.toISOString());

test('a Draft is reminded the morning after capture and on day 3, at 10:00 Warsaw time', () => {
  // Captured 21:30 Warsaw (CEST, UTC+2) on 3 October: 4 and 6 October at 10:00 CEST.
  assert.deepEqual(iso(draftReminderSlots('2026-10-03T19:30:00.000Z')),
    ['2026-10-04T08:00:00.000Z', '2026-10-06T08:00:00.000Z']);
  // 00:30 Warsaw on 4 October is still 3 October in UTC; the Warsaw date counts.
  assert.deepEqual(iso(draftReminderSlots('2026-10-03T22:30:00.000Z')),
    ['2026-10-05T08:00:00.000Z', '2026-10-07T08:00:00.000Z']);
  // Across the end of summer time (25 October 2026) the day-3 slot is 10:00 CET, UTC+1.
  assert.deepEqual(iso(draftReminderSlots('2026-10-23T12:00:00.000Z')),
    ['2026-10-24T08:00:00.000Z', '2026-10-26T09:00:00.000Z']);
});

const draft = (id: string, capturedAt: string, extra: { remindersOff?: true } = {}) => ({ id, capturedAt, ...extra });
const plan = (drafts: ReturnType<typeof draft>[], now: string) =>
  planDraftReminders(drafts, new Date(now)).map(item => ({ day: item.day, at: item.at.toISOString(), draftIds: item.draftIds }));

test('a slot already past is skipped, never moved, and nothing comes after day 3', () => {
  const captured = draft('a', '2026-10-03T19:30:00.000Z');
  assert.deepEqual(plan([captured], '2026-10-03T20:00:00.000Z'), [
    { day: '2026-10-04', at: '2026-10-04T08:00:00.000Z', draftIds: ['a'] },
    { day: '2026-10-06', at: '2026-10-06T08:00:00.000Z', draftIds: ['a'] }
  ]);
  // Opened at 10:05 on the first morning: only day 3 is left, at its own time.
  assert.deepEqual(plan([captured], '2026-10-04T08:05:00.000Z'), [
    { day: '2026-10-06', at: '2026-10-06T08:00:00.000Z', draftIds: ['a'] }
  ]);
  assert.deepEqual(plan([captured], '2026-10-06T08:00:00.000Z'), []);
  assert.deepEqual(plan([captured], '2026-10-20T08:00:00.000Z'), []);
});

test('several Drafts due on one day share one reminder, and a stopped Draft has none', () => {
  const drafts = [
    draft('a', '2026-10-01T07:00:00.000Z'),
    draft('b', '2026-10-03T07:00:00.000Z'),
    draft('c', '2026-10-03T15:00:00.000Z'),
    draft('d', '2026-10-03T16:00:00.000Z', { remindersOff: true })
  ];
  assert.deepEqual(plan(drafts, '2026-10-03T18:00:00.000Z'), [
    { day: '2026-10-04', at: '2026-10-04T08:00:00.000Z', draftIds: ['a', 'b', 'c'] },
    { day: '2026-10-06', at: '2026-10-06T08:00:00.000Z', draftIds: ['b', 'c'] }
  ]);
});

type Stored = { id: number; title: string; body: string; schedule: { at: string }; extra: Record<string, unknown>;
  actionTypeId?: string; isExactNotification?: boolean };

/** The local notifications plugin as the phone behaves: a delivered reminder stays listed as pending. */
function fakePlugin(initial: Stored[] = []) {
  const stored = new Map(initial.map(item => [item.id, item]));
  const delivered = new Set<number>();
  const scheduled: Stored[] = [];
  const port: NotificationsPort = {
    async getPending() { return { notifications: [...stored.values()] }; },
    async schedule({ notifications }) {
      for (const item of notifications) {
        const copy = { ...item, schedule: { at: item.schedule.at.toISOString() } } as Stored;
        stored.set(item.id, copy);
        scheduled.push(copy);
      }
      return {};
    },
    async cancel({ notifications }) { for (const { id } of notifications) stored.delete(id); },
    async getDeliveredNotifications() { return { notifications: [...delivered].map(id => ({ id, extra: stored.get(id)?.extra })) }; },
    async removeDeliveredNotificationsById({ ids }) { for (const id of ids) delivered.delete(id); }
  };
  return { port, stored, delivered, scheduled };
}

const text = (draftIds: string[]) => draftIds.length === 1
  ? { title: `Dokończ ${draftIds[0]}`, body: 'Dalej: Kiedy to się stało?' }
  : { title: `Szkice do dokończenia: ${draftIds.length}`, body: 'Wybierz w Moich zapisach.' };
const sync = (port: NotificationsPort, drafts: ReturnType<typeof draft>[], now: string, enabled = true) =>
  syncDraftReminders(port, drafts, { now: new Date(now), enabled, exact: true, text, guard: 'g1' });
const pending = (plugin: ReturnType<typeof fakePlugin>) => [...plugin.stored.values()]
  .map(item => [item.schedule.at, item.title, item.extra.draftIds]).sort();

test('several Drafts get at most one notification a day, with both actions', async () => {
  const plugin = fakePlugin();
  await sync(plugin.port, [draft('a', '2026-10-01T07:00:00.000Z'), draft('b', '2026-10-03T07:00:00.000Z')], '2026-10-03T18:00:00.000Z');
  assert.deepEqual(pending(plugin), [
    ['2026-10-04T08:00:00.000Z', 'Szkice do dokończenia: 2', ['a', 'b']],
    ['2026-10-06T08:00:00.000Z', 'Dokończ b', ['b']]
  ]);
  assert.ok(plugin.scheduled.every(item => item.actionTypeId === 'draft-reminder-actions' && item.isExactNotification === true));
});

test('a delivered reminder is never scheduled again, however often the app starts', async () => {
  const plugin = fakePlugin();
  const drafts = [draft('a', '2026-10-03T19:30:00.000Z')];
  await sync(plugin.port, drafts, '2026-10-03T20:00:00.000Z');
  plugin.delivered.add([...plugin.stored.values()][0].id);
  plugin.scheduled.length = 0;
  for (const now of ['2026-10-04T08:30:00.000Z', '2026-10-05T07:00:00.000Z', '2026-10-05T19:00:00.000Z']) await sync(plugin.port, drafts, now);
  assert.deepEqual(plugin.scheduled, []);
  await sync(plugin.port, drafts, '2026-10-07T07:00:00.000Z');
  assert.deepEqual(plugin.scheduled, []);
});

test('a Draft that became a Report or was deleted is reminded no more', async () => {
  const plugin = fakePlugin();
  const a = draft('a', '2026-10-03T07:00:00.000Z');
  const b = draft('b', '2026-10-03T08:00:00.000Z');
  await sync(plugin.port, [a, b], '2026-10-03T18:00:00.000Z');
  await sync(plugin.port, [b], '2026-10-03T18:10:00.000Z');
  assert.deepEqual(pending(plugin), [
    ['2026-10-04T08:00:00.000Z', 'Dokończ b', ['b']],
    ['2026-10-06T08:00:00.000Z', 'Dokończ b', ['b']]
  ]);
  await sync(plugin.port, [], '2026-10-03T18:20:00.000Z');
  assert.deepEqual(pending(plugin), []);
});

test('the delivered reminder leaves the shade once none of its Drafts wants reminding', async () => {
  const plugin = fakePlugin();
  const a = draft('a', '2026-10-03T07:00:00.000Z');
  await sync(plugin.port, [a], '2026-10-03T18:00:00.000Z');
  const first = [...plugin.stored.values()].find(item => item.schedule.at === '2026-10-04T08:00:00.000Z')!;
  plugin.delivered.add(first.id);
  await sync(plugin.port, [{ ...a, remindersOff: true }], '2026-10-04T08:01:00.000Z');
  assert.deepEqual(pending(plugin), []);
  assert.deepEqual([...plugin.delivered], []);
});

test('turning reminders off cancels every pending one and turning them on restores what is left', async () => {
  const plugin = fakePlugin();
  const drafts = [draft('a', '2026-10-03T07:00:00.000Z')];
  await sync(plugin.port, drafts, '2026-10-03T18:00:00.000Z');
  await sync(plugin.port, drafts, '2026-10-03T18:05:00.000Z', false);
  assert.deepEqual(pending(plugin), []);
  await sync(plugin.port, drafts, '2026-10-04T09:00:00.000Z', true);
  assert.deepEqual(pending(plugin), [['2026-10-06T08:00:00.000Z', 'Dokończ a', ['a']]]);
});

test('granting exact alarms upgrades pending reminders without moving their Warsaw slots', async () => {
  const plugin = fakePlugin();
  const drafts = [draft('a', '2026-10-03T07:00:00.000Z')];
  await syncDraftReminders(plugin.port, drafts, { now: new Date('2026-10-03T18:00:00.000Z'), enabled: true, exact: false, text, guard: 'g1' });
  assert.ok((await plugin.port.getPending()).notifications.every(item => item.isExactNotification === false));
  await syncDraftReminders(plugin.port, drafts, { now: new Date('2026-10-04T08:05:00.000Z'), enabled: true, exact: true, text, guard: 'g1' });
  assert.deepEqual((await plugin.port.getPending()).notifications.map(item => [item.schedule!.at, item.isExactNotification]), [
    ['2026-10-04T08:00:00.000Z', false], ['2026-10-06T08:00:00.000Z', true]
  ]);
});

test('a per-Draft reminder from an earlier version is replaced', async () => {
  const plugin = fakePlugin([{ id: 42, title: 'Bór czuwa', body: 'Dokończ zapisany szkic.',
    schedule: { at: '2026-10-04T08:00:00.000Z' }, extra: { draftId: 'a' } }]);
  await sync(plugin.port, [draft('a', '2026-10-03T07:00:00.000Z')], '2026-10-03T18:00:00.000Z');
  assert.equal(plugin.stored.has(42), false);
  assert.deepEqual(pending(plugin), [
    ['2026-10-04T08:00:00.000Z', 'Dokończ a', ['a']],
    ['2026-10-06T08:00:00.000Z', 'Dokończ a', ['a']]
  ]);
});

test('a reminder carries this install\'s guard and an id that the date alone does not give away', async () => {
  const one = fakePlugin();
  const two = fakePlugin();
  const drafts = [draft('a', '2026-10-03T07:00:00.000Z')];
  await sync(one.port, drafts, '2026-10-03T18:00:00.000Z');
  await syncDraftReminders(two.port, drafts, { now: new Date('2026-10-03T18:00:00.000Z'), enabled: true, exact: true, text, guard: 'g2' });
  assert.ok([...one.stored.values()].every(item => item.extra.guard === 'g1'));
  assert.ok([...two.stored.values()].every(item => item.extra.guard === 'g2'));
  const ids = (plugin: typeof one) => [...plugin.stored.keys()].sort();
  assert.notDeepEqual(ids(one), ids(two));
  // What an outside app can compute from the Warsaw day, with no guard, is not one of the ids.
  assert.ok(![...one.stored.keys()].includes(notificationId('draft-reminder:2026-10-04', '')));
});

test('a pending reminder made without the guard is replaced, not kept', async () => {
  const plugin = fakePlugin([{ id: notificationId('draft-reminder:2026-10-04', ''), title: 'Dokończ a', body: 'Dalej: Kiedy to się stało?',
    schedule: { at: '2026-10-04T08:00:00.000Z' }, isExactNotification: true,
    extra: { draftReminderDay: '2026-10-04', draftIds: ['a'] } }]);
  await sync(plugin.port, [draft('a', '2026-10-03T07:00:00.000Z')], '2026-10-03T18:00:00.000Z');
  assert.ok([...plugin.stored.values()].every(item => item.extra.guard === 'g1'));
  assert.equal(plugin.stored.size, 2);
});

test('syncing again with the same guard keeps the pending reminders as they are', async () => {
  const plugin = fakePlugin();
  const drafts = [draft('a', '2026-10-03T07:00:00.000Z')];
  await sync(plugin.port, drafts, '2026-10-03T18:00:00.000Z');
  plugin.scheduled.length = 0;
  await sync(plugin.port, drafts, '2026-10-03T18:05:00.000Z');
  assert.deepEqual(plugin.scheduled, []);
});

test('without the app shell guard nothing is scheduled, cancelled or thrown', async () => {
  const plugin = fakePlugin([{ id: 7, title: 'Dokończ a', body: 'x', schedule: { at: '2026-10-04T08:00:00.000Z' },
    extra: { draftReminderDay: '2026-10-04', draftIds: ['a'], guard: 'g1' } }]);
  const result = await syncDraftReminders(plugin.port, [draft('a', '2026-10-03T07:00:00.000Z')],
    { now: new Date('2026-10-03T18:00:00.000Z'), enabled: true, exact: true, text, guard: undefined });
  assert.deepEqual(result, []);
  assert.deepEqual(plugin.scheduled, []);
  assert.ok(plugin.stored.has(7));
});

function fakeFollowUps(initial: { id: number; title: string; at: string; extra: Record<string, unknown> }[]) {
  const stored = new Map(initial.map(item => [item.id, { ...item, schedule: { at: item.at } }]));
  const port = {
    async getPending() { return { notifications: [...stored.values()] }; },
    async schedule({ notifications }: { notifications: { id: number; title: string; schedule: { at: Date }; extra: Record<string, unknown> }[] }) {
      for (const item of notifications) stored.set(item.id, { id: item.id, title: item.title, at: item.schedule.at.toISOString(),
        schedule: { at: item.schedule.at.toISOString() }, extra: item.extra });
      return {};
    },
    async cancel({ notifications }: { notifications: { id: number }[] }) { for (const { id } of notifications) stored.delete(id); },
    async getDeliveredNotifications() { return { notifications: [] }; },
    async removeDeliveredNotificationsById() {}
  } as unknown as Parameters<typeof reconcileFollowUps>[0];
  return { port, stored };
}

test('a follow-up check made without the guard is replaced, one with it is kept', async () => {
  const at = new Date('2026-12-20T09:00:00.000Z');
  const options = { guard: 'g1', now: new Date('2026-11-15T00:00:00.000Z'), title: 'Bór czuwa' };
  const oldId = notificationId('follow-up:n1', '');
  const plugin = fakeFollowUps([{ id: oldId, title: 'Bór czuwa', at: at.toISOString(), extra: { followUpNoticeId: 'n1' } }]);
  await reconcileFollowUps(plugin.port, [['n1', at]], options);
  assert.equal(plugin.stored.has(oldId), false);
  const kept = [...plugin.stored.values()];
  assert.equal(kept.length, 1);
  assert.equal(kept[0].extra.guard, 'g1');
  assert.equal(kept[0].id, notificationId('follow-up:n1', 'g1'));
  // Syncing again changes nothing.
  const before = JSON.stringify([...plugin.stored.values()]);
  await reconcileFollowUps(plugin.port, [['n1', at]], options);
  assert.equal(JSON.stringify([...plugin.stored.values()]), before);
});
