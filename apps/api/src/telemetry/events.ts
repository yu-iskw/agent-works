import * as z from 'zod';

import { opaqueId } from './events-redaction.js';

import type { Redactor } from './events-redaction.js';

export const EVENT_KINDS = [
  'task.accepted',
  'approval.persisted',
  'tool.receipt',
  'audit.captured',
  'budget.charged',
  'budget.exceeded',
  'retry.scheduled',
  'task.completed',
  'task.result.accepted',
  'dlq.reviewed',
] as const;
const protectedId = z.string().transform(opaqueId);
export const structuredEventSchema = z.strictObject({
  schema_version: z.literal('1'),
  event_id: protectedId,
  kind: z.enum(EVENT_KINDS),
  occurred_at: z.iso.datetime(),
  task_id: protectedId,
  session_id: protectedId,
  trace_id: protectedId,
  user_subject: protectedId,
  agent_principal: protectedId,
  skill_version: protectedId,
  model: protectedId,
  tool: protectedId.nullable(),
  policy_version: protectedId,
  sponsor: protectedId,
  latency_ms: z.number().finite().nonnegative(),
  cost_estimate_micros: z.number().int().nonnegative().safe(),
  retries: z.number().int().nonnegative().safe(),
  outcome: z.enum(['success', 'denied', 'unavailable', 'review']),
  side_effect_key: protectedId.nullable(),
});
export type StructuredEvent = z.infer<typeof structuredEventSchema>;
export type EventInput = {
  readonly eventId: string;
  readonly kind: StructuredEvent['kind'];
  readonly occurredAt: string;
  readonly taskId: string;
  readonly sessionId: string;
  readonly traceId: string;
  readonly userSubject: string;
  readonly agentPrincipal: string;
  readonly skillVersion: string;
  readonly model: string;
  readonly tool: string | null;
  readonly policyVersion: string;
  readonly sponsor: string;
  readonly latencyMs: number;
  readonly costEstimateMicros: number;
  readonly retries: number;
  readonly outcome: StructuredEvent['outcome'];
  readonly sideEffectKey: string | null;
};
/** Construct an allowlisted record. Unknown prompt, token and provider fields cannot be copied. */
export function structuredEvent(input: EventInput, redactor: Redactor): StructuredEvent {
  return Object.freeze(
    structuredEventSchema.parse({
      schema_version: '1',
      event_id: redactor.protect(input.eventId),
      kind: input.kind,
      occurred_at: input.occurredAt,
      task_id: redactor.protect(input.taskId),
      session_id: redactor.protect(input.sessionId),
      trace_id: redactor.protect(input.traceId),
      user_subject: redactor.protect(input.userSubject),
      agent_principal: redactor.protect(input.agentPrincipal),
      skill_version: redactor.protect(input.skillVersion),
      model: redactor.protect(input.model),
      tool: input.tool === null ? null : redactor.protect(input.tool),
      policy_version: redactor.protect(input.policyVersion),
      sponsor: redactor.protect(input.sponsor),
      latency_ms: input.latencyMs,
      cost_estimate_micros: input.costEstimateMicros,
      retries: input.retries,
      outcome: input.outcome,
      side_effect_key: input.sideEffectKey === null ? null : redactor.protect(input.sideEffectKey),
    }),
  );
}
export function eventJsonLines(events: readonly StructuredEvent[]): string {
  return (
    events.map((event) => JSON.stringify(structuredEventSchema.parse(event))).join('\n') +
    (events.length === 0 ? '' : '\n')
  );
}
export function parseEventJsonLines(body: string): readonly StructuredEvent[] {
  return body
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => structuredEventSchema.parse(JSON.parse(line)));
}
