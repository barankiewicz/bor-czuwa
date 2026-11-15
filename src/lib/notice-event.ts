import { z } from 'zod';
import { directoryVersionShape, templateVersionShape, unitIdShape } from './version-shapes.js';

// What the server learns about a Notice. Never its text, Signed details or whether it arrived.
const code = z.string().regex(/^[A-Za-z0-9._-]{1,80}$/);
export const noticeEventSchema = z.strictObject({
  id: z.uuidv4(),
  kind: z.enum(['notice_composed', 'handed_to_mail_client', 'confirmed_by_reporter']),
  notice_id: z.uuidv4().optional(),
  recipient_kind: z.enum(['police', 'psl', 'nationalPark', 'rdos', 'gmina']),
  unit_id: code,
  template_version: z.string().refine(templateVersionShape),
  directory_version: z.string().refine(directoryVersionShape),
  at: z.iso.datetime({ offset: true })
}).refine(event => unitIdShape(event.recipient_kind, event.unit_id));

export type NoticeEvent = z.infer<typeof noticeEventSchema>;

export const noticeOutcomeSchema = z.strictObject({
  id: z.uuidv4(),
  kind: z.literal('outcome_reported'),
  notice_id: z.uuidv4(),
  recipient_kind: z.enum(['police', 'psl', 'nationalPark', 'rdos', 'gmina']),
  unit_id: code,
  outcome: z.enum(['reply', 'proceedings_opened', 'refusal', 'no_answer_yet']),
  observed_on: z.iso.date(),
  at: z.iso.datetime({ offset: true })
}).refine(event => unitIdShape(event.recipient_kind, event.unit_id));

export type NoticeOutcome = z.infer<typeof noticeOutcomeSchema>;
export const reportNoticeEventSchema = z.union([noticeEventSchema, noticeOutcomeSchema]);
