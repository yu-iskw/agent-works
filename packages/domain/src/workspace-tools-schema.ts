import * as z from 'zod';

const label = z.string().min(1).max(512);
const text = z.string().max(100_000);
const instant = z.iso.datetime();
export const docsDraftSchema = z.strictObject({
  title: label,
  destinationId: label,
  body: text,
});
export const calendarListSchema = z
  .strictObject({
    calendarId: label.default('primary'),
    timeMin: instant,
    timeMax: instant,
    limit: z.number().int().min(1).max(100).default(20),
  })
  .refine((v) => Date.parse(v.timeMax) > Date.parse(v.timeMin));
export const calendarCreateSchema = z
  .strictObject({
    calendarId: label.default('primary'),
    summary: label,
    description: text,
    start: instant,
    end: instant,
    attendees: z.array(z.email()).max(50),
  })
  .refine((v) => Date.parse(v.end) > Date.parse(v.start));
export const gmailSearchSchema = z.strictObject({
  query: z.string().min(1).max(2048),
  limit: z.number().int().min(1).max(100).default(20),
});
export const gmailDraftSchema = z.strictObject({
  to: z.array(z.email()).min(1).max(50),
  subject: label,
  body: text,
  threadId: label.optional(),
});
export type DocsDraft = z.infer<typeof docsDraftSchema>;
export type CalendarList = z.infer<typeof calendarListSchema>;
export type CalendarCreate = z.infer<typeof calendarCreateSchema>;
export type GmailSearch = z.infer<typeof gmailSearchSchema>;
export type GmailDraft = z.infer<typeof gmailDraftSchema>;
