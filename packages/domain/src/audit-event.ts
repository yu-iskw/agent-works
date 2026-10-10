import * as z from 'zod';

import { sha256DigestSchema } from './canonical-hash.js';

const label = z.string().min(1);

export const auditEventSchema = z.strictObject({
  eventId: label,
  eventType: label,
  schemaVersion: label,
  occurredAt: z.iso.datetime(),
  taskId: label,
  stepId: label,
  traceId: label,
  initiatorSubject: label,
  agentPrincipal: label,
  tool: label.nullable(),
  policyDecisionId: label.nullable(),
  approvalId: label.nullable(),
  requestDigestSha256: sha256DigestSchema.nullable(),
  outcome: label,
  externalObjectRef: label.nullable(),
  prevDigest: sha256DigestSchema.nullable(),
});

export type AuditEvent = z.infer<typeof auditEventSchema>;
