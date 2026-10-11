import * as z from 'zod';

const label = z.string().min(1);

export const IAP_ASSERTION_HEADER = 'x-goog-iap-jwt-assertion';

export const citationSchema = z.strictObject({
  sourceObjectId: label,
  title: label,
  sourceUri: z.url().regex(/^https?:\/\//),
  retrievedAt: z.iso.datetime(),
  excerpt: label,
});
export type Citation = z.infer<typeof citationSchema>;

export const askRequestSchema = z.strictObject({
  requestId: z.uuid(),
  question: z.string().trim().min(1).max(1000),
});
export type AskRequest = z.infer<typeof askRequestSchema>;

export const askResponseSchema = z.strictObject({
  requestId: z.uuid(),
  answer: label,
  citations: z.array(citationSchema),
});
export type AskResponse = z.infer<typeof askResponseSchema>;

export const ASK_ERROR_CODES = [
  'unauthenticated',
  'unavailable',
  'invalid_request',
  'conflict',
  'retrieval_failed',
  'runner_failed',
  'audit_failed',
] as const;
export const askErrorSchema = z.strictObject({ error: z.enum(ASK_ERROR_CODES) });
export type AskErrorCode = (typeof ASK_ERROR_CODES)[number];
