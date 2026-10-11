import { auditEventSchema } from '@agent-works/domain';

import type { AuditEvent } from '@agent-works/domain';
import type postgres from 'postgres';

export class AuditWriteError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'AuditWriteError';
  }
}

type Produced<Reply> = {
  readonly event: AuditEvent;
  readonly reply: Reply;
};

type AskRunResult<Reply> =
  { readonly kind: 'done'; readonly reply: Reply } | { readonly kind: 'conflict' };

export interface AuditLog {
  run<Reply>(
    requestId: string,
    execute: () => Promise<Produced<Reply>>,
  ): Promise<AskRunResult<Reply>>;
}

export type MemoryAuditLog = AuditLog & { rows(): readonly AuditEvent[] };

export const AUDIT_COLUMNS: readonly string[] = Object.keys(auditEventSchema.shape).map(
  camelToSnake,
);

export function createMemoryAuditLog(legacy: readonly AuditEvent[] = []): MemoryAuditLog {
  const rows = [...legacy];
  const claims = new Set(legacy.map((event) => event.eventId));
  return {
    run(requestId, execute) {
      const owned = !claims.has(requestId);
      if (owned) claims.add(requestId);
      return settle(
        owned,
        execute,
        (produced) => {
          rows.push(produced.event);
          return Promise.resolve();
        },
        () => {
          claims.delete(requestId);
          return Promise.resolve();
        },
      );
    },
    rows() {
      return rows;
    },
  };
}

export function createPostgresAuditLog(sql: postgres.Sql): AuditLog {
  const abandoned = new Set<string>();
  return {
    async run(requestId, execute) {
      await releaseAbandoned(sql, abandoned, requestId);
      const owned = await reserve(sql, requestId);
      return settle(
        owned,
        execute,
        (produced) => finish(sql, produced.event),
        () => release(sql, abandoned, requestId),
      );
    },
  };
}

async function settle<Reply>(
  owned: boolean,
  execute: () => Promise<Produced<Reply>>,
  finishRun: (produced: Produced<Reply>) => Promise<void>,
  releaseRun: () => Promise<void>,
): Promise<AskRunResult<Reply>> {
  if (!owned) return { kind: 'conflict' };
  let produced: Produced<Reply>;
  try {
    produced = await execute();
  } catch (error) {
    await releaseRun();
    throw error;
  }
  await finishRun(produced);
  return { kind: 'done', reply: produced.reply };
}

async function reserve(sql: postgres.Sql, requestId: string): Promise<boolean> {
  try {
    const inserted = await sql<{ request_id: string }[]>`
      insert into ask_reservations (request_id)
      select ${requestId}
      where not exists (
        select 1 from audit_events where event_id = ${requestId}
      )
      on conflict (request_id) do nothing
      returning request_id
    `;
    return inserted.length > 0;
  } catch (error) {
    throw new AuditWriteError('audit write', { cause: error });
  }
}

async function finish(sql: postgres.Sql, event: AuditEvent): Promise<void> {
  try {
    await sql`insert into audit_events ${sql(toRow(event), ...AUDIT_COLUMNS)}`;
  } catch (error) {
    throw new AuditWriteError('audit write', { cause: error });
  }
}

async function releaseAbandoned(
  sql: postgres.Sql,
  abandoned: Set<string>,
  requestId: string,
): Promise<void> {
  if (!abandoned.delete(requestId)) return;
  try {
    await sql`delete from ask_reservations where request_id = ${requestId}`;
  } catch {
    abandoned.add(requestId);
  }
}

async function release(
  sql: postgres.Sql,
  abandoned: Set<string>,
  requestId: string,
): Promise<void> {
  try {
    await sql`delete from ask_reservations where request_id = ${requestId}`;
    abandoned.delete(requestId);
  } catch {
    abandoned.add(requestId);
  }
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
