/// <reference types="vite/client" />

import { resolveDemoTestRecipient } from './demo-policy.js';
import { buildConfiguration } from './build-configuration.js';

export const demoTestRecipient = resolveDemoTestRecipient(buildConfiguration.mode,
  buildConfiguration.demoTestRecipient);

/** Never fall back to a directory address in a configured demo, including old saved Notices. */
export function handoffRecipient<T extends string | null | undefined>(address: T): T | string {
  return demoTestRecipient ?? address;
}

/** Remove mailbox routing from free text too, including percent-encoded mailto destinations. */
export function handoffText(text: string): string {
  if (!demoTestRecipient) return text;
  return text.replace(/[^\s<>(),;:"„“”]+(?:@|%40)[^\s<>(),;:"„“”]+/giu, demoTestRecipient);
}

export function handoffNotice<T extends { subject: string; body: string }>(notice: T): T {
  if (!demoTestRecipient) return notice;
  const heading = `TEST — fikcyjne zgłoszenie. Nie wysyłaj do urzędu.\nOdbiorca testowy: ${demoTestRecipient}\n\n`;
  const subject = handoffText(notice.subject);
  const body = handoffText(notice.body);
  return { ...notice, subject: subject.startsWith('[TEST] ') ? subject : `[TEST] ${subject}`,
    body: body.startsWith(heading) ? body : `${heading}${body}` };
}

export function noticeFilename(recipient: { kind: string; id: string }): string {
  return demoTestRecipient ? 'test-powiadomienie.pdf' : `powiadomienie-${recipient.kind}-${recipient.id}.pdf`;
}

export function photoFilename(index: number): string {
  return `${demoTestRecipient ? 'test-' : ''}zgloszenie-${index + 1}.jpg`;
}
