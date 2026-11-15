import { checkInEnabled } from './check-in';
import { Capacitor, registerPlugin } from '@capacitor/core';
import { signedNoticeCheckInAt, type LocalDraft, type LocalReport } from './local-store';
import type { LocalPhoto } from './photos';
import { beamSpread, deviceHeading, lowAccuracySpread, nativeSpread, rotationFromEuler, type HeadingSample, type NativeReading } from './compass';
import { draftReminderActionType, notificationId, reminderExtra, syncDraftReminders, type NotificationsPort } from './draft-reminders';
import { handoffNotice, handoffRecipient } from './demo-handoff.js';

export const isAndroidApp = typeof window !== 'undefined' && Capacitor.isNativePlatform();
const reminderTitle = 'Bór czuwa';


// The plugin is a proxy that answers every property, `then` included, so it must never be the
// value an async function resolves with; the module around it is safe to await.
const localNotifications = () => import('@capacitor/local-notifications');

export type ReminderIssue = 'exact' | 'notifications';

/**
 * Brings the phone's Draft reminders in line with the Drafts and the Menu switch. It never asks for a
 * permission, so it is safe beside the capture receipt; without the permission nothing is scheduled.
 */
export async function syncReminders(drafts: LocalDraft[], enabled: boolean,
  text: (draftIds: string[]) => { title: string; body: string }, actions: { finish: string; stop: string }): Promise<ReminderIssue | undefined> {
  if (!isAndroidApp) return undefined;
  const { LocalNotifications } = await localNotifications();
  const permission = (await LocalNotifications.checkPermissions()).display;
  const allowed = permission === 'granted';
  if (allowed) await LocalNotifications.registerActionTypes({ types: [{ id: draftReminderActionType,
    actions: [{ id: 'finish', title: actions.finish }, { id: 'stop', title: actions.stop }] }] });
  const exact = allowed && (await LocalNotifications.checkExactNotificationSetting()).exact_alarm === 'granted';
  const plan = await syncDraftReminders(LocalNotifications as unknown as NotificationsPort, drafts,
    { now: new Date(), enabled: enabled && allowed, exact, text });
  if (!enabled || !drafts.some(draft => !draft.remindersOff)) return undefined;
  if (permission === 'denied') return 'notifications';
  return plan.length && allowed && !exact ? 'exact' : undefined;
}

/** Asks for the notification permission when Android has not been asked yet. */
export async function askForReminders() {
  if (!isAndroidApp) return true;
  const { LocalNotifications } = await localNotifications();
  let permission = (await LocalNotifications.checkPermissions()).display;
  if (permission !== 'granted' && permission !== 'denied') permission = (await LocalNotifications.requestPermissions()).display;
  return permission === 'granted';
}

/** Opens Android's exact alarm setting and says whether it is on afterwards. */
export async function openExactAlarmSetting() {
  if (!isAndroidApp) return true;
  const { LocalNotifications } = await localNotifications();
  await LocalNotifications.changeExactNotificationSetting();
  return (await LocalNotifications.checkExactNotificationSetting()).exact_alarm === 'granted';
}

/** "Dokończ" (or a tap on the reminder) and "Nie przypominaj", with the Drafts the reminder covered. */
export async function watchDraftReminderActions(onAction: (action: 'finish' | 'stop', draftIds: string[]) => void) {
  if (!isAndroidApp) return () => {};
  const { LocalNotifications } = await localNotifications();
  const listener = await LocalNotifications.addListener('localNotificationActionPerformed', ({ actionId, notification }) => {
    const reminder = reminderExtra(notification.extra);
    if (!reminder) return;
    // An action button, unlike a tap on the body, leaves the reminder in the shade.
    void LocalNotifications.removeDeliveredNotificationsById({ ids: [notification.id] }).catch(() => {});
    onAction(actionId === 'stop' ? 'stop' : 'finish', reminder.draftIds);
  });
  return () => { void listener.remove(); };
}

export async function reconcileSignedNoticeCheckIns(reports: LocalReport[]) {
  if (!isAndroidApp) return true;
  const { LocalNotifications } = await localNotifications();
  const pending = await LocalNotifications.getPending();
  const current = new Map((checkInEnabled ? reports : []).flatMap(report => (report.notices ?? []).flatMap(notice => {
    const at = signedNoticeCheckInAt(notice);
    return at ? [[notice.id, at] as const] : [];
  })));
  const obsolete = pending.notifications.filter(item => typeof item.extra?.followUpNoticeId === 'string' &&
    !current.has(item.extra.followUpNoticeId));
  if (obsolete.length) await LocalNotifications.cancel({ notifications: obsolete.map(item => ({ id: item.id })) });
  const delivered = await LocalNotifications.getDeliveredNotifications();
  const dismissed = delivered.notifications.filter(item => typeof item.extra?.followUpNoticeId === 'string' &&
    !current.has(item.extra.followUpNoticeId));
  if (dismissed.length) await LocalNotifications.removeDeliveredNotificationsById({ ids: dismissed.map(item => item.id) });
  const scheduled = new Map(pending.notifications.map(item => [item.extra?.followUpNoticeId, item] as const));
  let scheduledExactly = true;
  for (const [id, at] of current) {
    // "No reply yet" moves the check-in, so a reminder pending for the old time is scheduled again over its id.
    const existing = scheduled.get(id);
    const pendingAt = existing?.schedule?.at ? new Date(existing.schedule.at).getTime() : NaN;
    // An unreadable pending time keeps the reminder rather than rescheduling it on every start.
    if ((existing?.title === reminderTitle && (Number.isNaN(pendingAt) || Math.abs(pendingAt - at.getTime()) < 60_000)) || at.getTime() <= Date.now()) continue;
    const result = await LocalNotifications.schedule({ notifications: [{
      id: notificationId(`follow-up:${id}`), title: reminderTitle,
      body: 'Sprawdź, czy urząd odpowiedział na Twoje powiadomienie.',
      channelId: 'follow-up-checks', schedule: { at }, isExactNotification: false,
      extra: { followUpNoticeId: id }
    }] });
    if (result.warning) scheduledExactly = false;
  }
  return scheduledExactly;
}

export async function watchAppState(onBackground: () => void, onForeground: () => void) {
  if (!isAndroidApp) return () => {};
  const { App } = await import('@capacitor/app');
  const listener = await App.addListener('appStateChange', state => {
    if (state.isActive) onForeground();
    else onBackground();
  });
  return () => { void listener.remove(); };
}

export async function watchAndroidBack(onBack: () => boolean) {
  if (!isAndroidApp) return () => {};
  const { App } = await import('@capacitor/app');
  const listener = await App.addListener('backButton', () => {
    if (!onBack()) void App.exitApp();
  });
  return () => { void listener.remove(); };
}

export async function openAndroidMail(address: string, subject: string, body: string, photos: LocalPhoto[]) {
  const recipient = handoffRecipient(address);
  const notice = handoffNotice({ subject, body });
  const encoded = await Promise.all(photos.map(photo => blobBase64(photo.jpeg)));
  const NoticeMail = registerPlugin<{ open(options: { address: string; subject: string; body: string; photos: string[] }): Promise<void> }>('NoticeMail');
  await NoticeMail.open({ address: recipient, subject: notice.subject, body: notice.body, photos: encoded });
}

export async function decodeAndroidPhoto(file: File): Promise<Blob | undefined> {
  if (!isAndroidApp) return undefined;
  const Photos = registerPlugin<{ decode(options: { base64: string }): Promise<{ base64: string }> }>('Photos');
  const result = await Photos.decode({ base64: await blobBase64(file) });
  const bytes = Uint8Array.from(atob(result.base64), character => character.charCodeAt(0));
  return new Blob([bytes], { type: 'image/jpeg' });
}

export async function clearAndroidMailCopies() {
  if (!isAndroidApp) return;
  const NoticeMail = registerPlugin<{ clear(): Promise<void> }>('NoticeMail');
  await NoticeMail.clear();
}

function blobBase64(blob: Blob) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(',')[1]);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

export async function saveLocalFile(blob: Blob, filename: string): Promise<boolean> {
  if (isAndroidApp) {
    const NoticeFiles = registerPlugin<{
      save(options: { filename: string; mimeType: string; base64: string }): Promise<{ saved: boolean }>
    }>('NoticeFiles');
    const result = await NoticeFiles.save({ filename, mimeType: blob.type, base64: await blobBase64(blob) });
    return result.saved;
  }
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  return true;
}

/** Checks startup access without asking for a platform permission. */
export async function startupLocationPermission(): Promise<PermissionState | undefined> {
  if (isAndroidApp) {
    const LocationAccess = registerPlugin<{ prepare(): Promise<{ granted: boolean }> }>('LocationAccess');
    try { return (await LocationAccess.prepare()).granted ? 'granted' : 'prompt'; }
    catch { return undefined; }
  }
  try { return (await navigator.permissions?.query({ name: 'geolocation' }))?.state; }
  catch { return undefined; }
}

export type CompassProblem = 'unavailable' | 'denied' | 'permission';

type PermissionOrientation = typeof DeviceOrientationEvent & { requestPermission?: (absolute?: boolean) => Promise<string> };
let orientationAllowed = false;

export async function enableCompass() {
  const orientation = window.DeviceOrientationEvent as PermissionOrientation | undefined;
  orientationAllowed = await orientation?.requestPermission?.(true) === 'granted';
  return orientationAllowed;
}

// Offered on every touch device. Without a usable sensor the target works by hand alone.
export const compassOffered = typeof window !== 'undefined' && (isAndroidApp || matchMedia('(pointer: coarse)').matches);

const screenAngle = () => screen.orientation?.angle ?? 0;

/** Streams north-referenced headings of where the phone points until the returned stop is called. */
export function watchCompass(onSample: (sample: HeadingSample) => void, onProblem: (problem: CompassProblem | undefined) => void) {
  let stopped = false;
  let received = false;
  let late = false;
  const fail = (problem: CompassProblem) => { if (!stopped) { stop(); onProblem(problem); } };
  // Chrome sends nothing when a site's motion sensors are blocked, and one empty event without a magnetometer.
  // A sensor that is only slow keeps being listened to, and clears the problem when it speaks.
  const timeout = setTimeout(() => { if (!stopped) { late = true; onProblem('unavailable'); } }, 3000);
  const sample = (heading: number, spread: number) => {
    if (stopped) return;
    received = true;
    clearTimeout(timeout);
    if (late) { late = false; onProblem(undefined); }
    onSample({ heading, spread, at: performance.now() });
  };
  let stopSource = () => {};
  if (isAndroidApp) {
    const Compass = registerPlugin<{
      start(): Promise<void>; stop(): Promise<void>;
      addListener(event: 'reading', listener: (reading: NativeReading) => void): Promise<{ remove(): Promise<void> }>;
    }>('Compass');
    const listener = Compass.addListener('reading', reading =>
      sample(deviceHeading(reading.matrix, screenAngle()), nativeSpread(reading)))
      .catch(() => { fail('unavailable'); return undefined; });
    Compass.start().catch(() => fail('unavailable'));
    stopSource = () => { void listener.then(handle => handle?.remove()).catch(() => {}); void Compass.stop().catch(() => {}); };
  } else if (Reflect.has(window, 'ondeviceorientationabsolute')) {
    const listener = (event: DeviceOrientationEvent) => {
      if (event.alpha === null || event.beta === null || event.gamma === null) { if (!received) fail('unavailable'); return; }
      sample(deviceHeading(rotationFromEuler(event.alpha, event.beta, event.gamma), screenAngle()), beamSpread);
    };
    window.addEventListener('deviceorientationabsolute', listener);
    stopSource = () => window.removeEventListener('deviceorientationabsolute', listener);
    void navigator.permissions?.query({ name: 'magnetometer' as PermissionName })
      .then(status => {
        if (status.state === 'denied') fail('denied');
        else if (status.state === 'prompt' && !orientationAllowed &&
          (window.DeviceOrientationEvent as PermissionOrientation | undefined)?.requestPermission) fail('permission');
      }, () => {});
  } else if ((window.DeviceOrientationEvent as PermissionOrientation | undefined)?.requestPermission && !orientationAllowed) {
    queueMicrotask(() => fail('permission'));
  } else if (orientationAllowed) {
    const listener = (event: DeviceOrientationEvent & { webkitCompassHeading?: number; webkitCompassAccuracy?: number }) => {
      if (event.webkitCompassHeading === undefined) { if (!received) fail('unavailable'); return; }
      const reliable = event.webkitCompassAccuracy !== undefined && event.webkitCompassAccuracy >= 0 && event.webkitCompassAccuracy <= 40;
      sample((event.webkitCompassHeading + screenAngle() + 360) % 360, reliable ? beamSpread : lowAccuracySpread);
    };
    window.addEventListener('deviceorientation', listener);
    stopSource = () => window.removeEventListener('deviceorientation', listener);
  } else {
    queueMicrotask(() => fail('unavailable'));
  }
  function stop() {
    if (stopped) return;
    stopped = true;
    clearTimeout(timeout);
    stopSource();
  }
  return stop;
}
