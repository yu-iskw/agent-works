import * as z from 'zod';

import { canonicalPayloadSha256 } from './canonical-hash.js';
import { scheduleLabel, scheduleSpecSchema } from './schedule.js';
const eventPayloadFieldSchema = z.strictObject({
  type: z.enum(['string', 'number', 'boolean']),
  required: z.boolean(),
  maxLength: z.number().int().positive().max(8192).optional(),
});
export const eventPayloadSchemaSchema = z.strictObject({
  type: z.literal('object'),
  additionalProperties: z.literal(false),
  properties: z
    .record(z.string().regex(/^[a-zA-Z][a-zA-Z0-9_]{0,63}$/), eventPayloadFieldSchema)
    .refine((v) => Object.keys(v).length <= 64),
});
export const eventTriggerSchema = z.strictObject({
  id: z.uuid(),
  scheduleId: z.uuid(),
  source: scheduleLabel,
  signingKeyId: scheduleLabel,
  algorithm: z.enum(['HS256', 'RS256', 'EdDSA']),
  replayWindowSeconds: z.number().int().min(1).max(3600),
  payloadSchema: eventPayloadSchemaSchema,
});
export type EventTrigger = z.infer<typeof eventTriggerSchema>;
export const eventTriggerCreateSchema = z.strictObject({
  schedule: scheduleSpecSchema,
  trigger: eventTriggerSchema,
});
export const receivedEventSchema = z.strictObject({
  key: z.string().min(1),
  triggerId: z.uuid(),
  scheduleId: z.uuid(),
  source: scheduleLabel,
  eventId: scheduleLabel,
  timestamp: z.iso.datetime(),
  receivedAt: z.iso.datetime(),
  digest: z.string().regex(/^[a-f0-9]{64}$/),
  trust: z.literal('untrusted'),
  payload: z.record(z.string(), z.json()),
  runId: z.string().regex(/^[a-f0-9]{64}$/),
});
export type ReceivedEvent = z.infer<typeof receivedEventSchema>;
export function eventTriggerHash(value: EventTrigger): string {
  return canonicalPayloadSha256(eventTriggerSchema.parse(value));
}
export function sourceEventKey(source: string, eventId: string): string {
  return canonicalPayloadSha256({ source, eventId });
}
