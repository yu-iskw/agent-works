import * as z from 'zod';

import { sha256DigestSchema } from './canonical-hash.js';
import { capabilityVersionSchema } from './capability-version.js';
import { suspensionSchema } from './suspension.js';

export const suspensionAuditSchema = z.strictObject({
  eventId: z.string().min(1),
  eventType: z.enum(['admin.suspend', 'admin.resume', 'admin.version', 'invocation.denied']),
  actorSub: z.string(),
  occurredAt: z.iso.datetime(),
  reason: z.string().min(1),
  digest: sha256DigestSchema,
  taskId: z.string().nullable(),
  traceId: z.string().min(1),
  details: z.json(),
});
export const suspensionSnapshotSchema = z.strictObject({
  suspensions: z.array(suspensionSchema),
  versions: z.array(capabilityVersionSchema),
});
export const suspensionHistorySchema = z.strictObject({ events: z.array(suspensionAuditSchema) });
export const suspensionResultSchema = z.strictObject({
  record: z.union([suspensionSchema, capabilityVersionSchema]),
  replay: z.boolean(),
});
