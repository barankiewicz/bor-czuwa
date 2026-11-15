import { checkInEnabled } from './check-in';
import { isSynced, noticeState, signedNoticeCheckInAt, type LocalDraft, type LocalNotice, type LocalReport, type LocalWithdrawal } from './local-store';

/** Work only the Reporter can do. Each one opens its own screen and leaves the list when done. */
export type Task =
  | { kind: 'draft'; id: string; at: string; item: LocalDraft }
  | { kind: 'refused'; id: string; at: string; item: LocalReport }
  | { kind: 'confirm' | 'check_in'; id: string; at: string; item: LocalReport; notice: LocalNotice };
/** The app's own work. It never counts as waiting for the Reporter. */
export type AutomaticWork =
  | { kind: 'upload'; item: LocalReport }
  | { kind: 'withdrawal'; item: LocalWithdrawal };

const reportAt = (item: LocalReport) =>
  item.lastActivityAt ?? item.events.find(event => event.kind === 'created')?.at ?? item.report.captured_at;

/** The one classification home, the masthead count and Moje zapisy all read. Newest first. */
export function pendingWork(drafts: LocalDraft[], reports: LocalReport[], withdrawals: LocalWithdrawal[], now: number) {
  const tasks: Task[] = drafts.map(item => ({ kind: 'draft', id: item.id, at: item.lastActivityAt ?? item.capturedAt, item }));
  const automatic: AutomaticWork[] = [];
  for (const item of reports) {
    const at = reportAt(item);
    if (item.sync_error) tasks.push({ kind: 'refused', id: item.report.id, at, item });
    else if (!isSynced(item)) automatic.push({ kind: 'upload', item });
    for (const notice of item.notices ?? []) {
      if (noticeState(notice) !== 'confirmed_by_reporter') tasks.push({ kind: 'confirm', id: `confirm:${item.report.id}:${notice.id}`, at, item, notice });
      else if (checkInEnabled) {
        // A due check-in is as new as the day it fell due, not as the Report.
        const due = signedNoticeCheckInAt(notice);
        if (due && due.getTime() <= now) tasks.push({ kind: 'check_in', id: `check_in:${item.report.id}:${notice.id}`, at: due.toISOString(), item, notice });
      }
    }
  }
  for (const item of withdrawals) automatic.push({ kind: 'withdrawal', item });
  // Stored times and a computed due date differ in format, so compare instants rather than strings.
  tasks.sort((a, b) => Date.parse(b.at) - Date.parse(a.at) || a.id.localeCompare(b.id));
  return { tasks, automatic };
}
