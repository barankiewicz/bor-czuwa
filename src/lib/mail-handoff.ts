import { demoTestRecipient, handoffNotice, handoffRecipient } from './demo-handoff.js';

// Mail clients truncate or refuse long mailto: links; Outlook on Windows stops near 2083 characters.
export const mailtoLimit = 2000;

export function mailto(address: string, subject: string, body: string) {
  const recipient = handoffRecipient(address);
  const notice = handoffNotice({ subject, body });
  const destination = demoTestRecipient ? encodeURIComponent(recipient).replace(/%40/g, '@') : recipient;
  const head = `mailto:${destination}?subject=${encodeURIComponent(notice.subject)}`;
  const full = `${head}&body=${encodeURIComponent(notice.body.replace(/\r?\n/g, '\r\n'))}`;
  return full.length <= mailtoLimit ? { href: full, withBody: true } : { href: head, withBody: false };
}
