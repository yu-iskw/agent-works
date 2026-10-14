import * as z from 'zod';

import { canonicalPayloadSha256 } from './canonical-hash.js';
export const scheduleRunSchema = z.strictObject({
  id: z.string().regex(/^[a-f0-9]{64}$/),
  scheduleId: z.uuid(),
  fireAt: z.iso.datetime(),
  status: z.enum(['dispatching', 'accepted', 'denied', 'cancelled', 'completed']),
  taskId: z.string().min(1).nullable(),
  reason: z.string().min(1).nullable(),
  leaseOwner: z.string().min(1),
  leaseUntil: z.iso.datetime(),
  fence: z.number().int().positive(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
  eventKey: z.string().nullable(),
});
export type ScheduleRun = z.infer<typeof scheduleRunSchema>;
export function scheduleRunId(
  scheduleId: string,
  fireAt: string,
  eventKey: string | null = null,
): string {
  return canonicalPayloadSha256({ scheduleId, fireAt, eventKey });
}
export const scheduleAuditSchema = z.strictObject({
  id: z.string().min(1),
  scheduleId: z.uuid(),
  actorSub: z.string().min(1),
  at: z.iso.datetime(),
  kind: z.enum([
    'created',
    'paused',
    'resumed',
    'revoked',
    'claimed',
    'accepted',
    'denied',
    'cancelled',
    'completed',
    'event-received',
  ]),
  reason: z.string().nullable(),
  runId: z.string().nullable(),
  digest: z.string().regex(/^[a-f0-9]{64}$/),
});
export type ScheduleAudit = z.infer<typeof scheduleAuditSchema>;
