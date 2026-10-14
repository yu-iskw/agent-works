import { createHash } from 'node:crypto';

import * as z from 'zod';

import { opaqueId } from '../../telemetry/events-redaction.js';

import type { Redactor } from '../../telemetry/events-redaction.js';
import type { AuditEvent } from '@agent-works/domain';

const protectedId = z.string().transform(opaqueId);
export const siemEventSchema = z.strictObject({
  version: z.literal('1'),
  destination: z.literal('PLACEHOLDER'),
  event_id: protectedId,
  event_type: protectedId,
  occurred_at: z.iso.datetime(),
  task_id: protectedId,
  step_id: protectedId,
  trace_id: protectedId,
  user_subject: protectedId,
  agent_principal: protectedId,
  tool: protectedId.nullable(),
  policy_decision_id: protectedId.nullable(),
  approval_id: protectedId.nullable(),
  request_digest: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .nullable(),
  outcome: z.enum(['success', 'denied', 'review']),
  receipt_ref: protectedId.nullable(),
});
export type SiemEvent = z.infer<typeof siemEventSchema>;
export type SealedExport = {
  readonly sequence: number;
  readonly previous: string | null;
  readonly digest: string;
  readonly event: SiemEvent;
};
const digestPattern = z.string().regex(/^[a-f0-9]{64}$/);
export const sealedExportSchema = z.strictObject({
  sequence: z.number().int().positive().safe(),
  previous: digestPattern.nullable(),
  digest: digestPattern,
  event: siemEventSchema,
});

export function projectAudit(event: AuditEvent, redactor: Redactor): SiemEvent {
  const protectNullable = (value: string | null) =>
    value === null ? null : redactor.protect(value);
  return Object.freeze(
    siemEventSchema.parse({
      version: '1',
      destination: 'PLACEHOLDER',
      event_id: redactor.protect(event.eventId),
      event_type: redactor.protect(event.eventType),
      occurred_at: event.occurredAt,
      task_id: redactor.protect(event.taskId),
      step_id: redactor.protect(event.stepId),
      trace_id: redactor.protect(event.traceId),
      user_subject: redactor.protect(event.initiatorSubject),
      agent_principal: redactor.protect(event.agentPrincipal),
      tool: protectNullable(event.tool),
      policy_decision_id: protectNullable(event.policyDecisionId),
      approval_id: protectNullable(event.approvalId),
      request_digest: event.requestDigestSha256,
      outcome:
        event.outcome === 'SUCCESS' ? 'success' : event.outcome === 'DENIED' ? 'denied' : 'review',
      receipt_ref: protectNullable(event.externalObjectRef),
    }),
  );
}
export function sealExport(event: SiemEvent, previous?: SealedExport): SealedExport {
  const body = {
    sequence: previous === undefined ? 1 : previous.sequence + 1,
    previous: previous?.digest ?? null,
    event: siemEventSchema.parse(event),
  };
  return Object.freeze({ ...body, event: Object.freeze(body.event), digest: exportDigest(body) });
}
function exportDigest(value: {
  sequence: number;
  previous: string | null;
  event: SiemEvent;
}): string {
  // Schema projection fixes field order before hashing, including inputs read from JSON.
  return createHash('sha256')
    .update(
      JSON.stringify({
        sequence: value.sequence,
        previous: value.previous,
        event: siemEventSchema.parse(value.event),
      }),
    )
    .digest('hex');
}
export function verifyExports(input: readonly SealedExport[]): void {
  const seen = new Set<string>();
  let previous: SealedExport | undefined;
  for (const value of input) {
    const link = sealedExportSchema.parse(value);
    if (
      link.sequence !== (previous?.sequence ?? 0) + 1 ||
      link.previous !== (previous?.digest ?? null) ||
      link.digest !== exportDigest(link)
    )
      throw new Error('SIEM chain integrity');
    if (seen.has(link.event.event_id)) throw new Error('SIEM duplicate event');
    seen.add(link.event.event_id);
    previous = link;
  }
}
