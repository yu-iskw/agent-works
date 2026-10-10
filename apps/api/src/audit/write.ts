import { auditEventSchema } from '@agent-works/domain';

import type { AuditEvent } from '@agent-works/domain';
import type postgres from 'postgres';

export type AppendResult =
  | { readonly kind: 'recorded' }
  | { readonly kind: 'replay' }
  | { readonly kind: 'conflict' };

export interface AuditLog {
  append(event: AuditEvent): Promise<AppendResult>;
}

export const AUDIT_COLUMNS: readonly string[] = Object.keys(auditEventSchema.shape).map(
  camelToSnake,
);

export function createPostgresAuditLog(sql: postgres.Sql): AuditLog {
  return {
    async append(event) {
      const row = toRow(event);
      const inserted = await sql<{ event_id: string }[]>`
        insert into audit_events ${sql(row, ...AUDIT_COLUMNS)}
        on conflict (event_id) do nothing
        returning event_id
      `;
      if (inserted.length > 0) return { kind: 'recorded' };
      const existing = await sql<
        { request_digest_sha256: string | null; initiator_subject: string; outcome: string }[]
      >`
        select request_digest_sha256, initiator_subject, outcome
        from audit_events where event_id = ${event.eventId}
      `;
      if (existing.length === 0) throw new Error('audit row missing');
      return sameAsk(existing[0], event) ? { kind: 'replay' } : { kind: 'conflict' };
    },
  };
}

function sameAsk(
  existing: { request_digest_sha256: string | null; initiator_subject: string; outcome: string },
  event: AuditEvent,
): boolean {
  return (
    existing.request_digest_sha256 === event.requestDigestSha256 &&
    existing.initiator_subject === event.initiatorSubject &&
    existing.outcome === event.outcome
  );
}

function toRow(event: AuditEvent): Record<string, string | null> {
  const row = {
    event_id: event.eventId,
    event_type: event.eventType,
    schema_version: event.schemaVersion,
    occurred_at: event.occurredAt,
    task_id: event.taskId,
    step_id: event.stepId,
    trace_id: event.traceId,
    initiator_subject: event.initiatorSubject,
    agent_principal: event.agentPrincipal,
    tool: event.tool,
    policy_decision_id: event.policyDecisionId,
    approval_id: event.approvalId,
    request_digest_sha256: event.requestDigestSha256,
    outcome: event.outcome,
    external_object_ref: event.externalObjectRef,
    prev_digest: event.prevDigest,
  };
  const actual = Object.keys(row).sort(compare);
  const expected = [...AUDIT_COLUMNS].sort(compare);
  if (actual.join('\0') !== expected.join('\0')) throw new Error('audit columns');
  return row;
}

function camelToSnake(name: string): string {
  return name.replaceAll(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);
}

function compare(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}
