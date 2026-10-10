import { auditEventSchema } from '@agent-works/domain';

import type { AuditEvent } from '@agent-works/domain';
import type postgres from 'postgres';

export class AuditWriteError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'AuditWriteError';
  }
}

type StoredReply = {
  readonly status: number;
  readonly body: unknown;
};

type ClaimKey = {
  readonly eventId: string;
  readonly initiatorSubject: string;
  readonly requestDigestSha256: string;
};

type AskExecution = {
  readonly event: AuditEvent;
  readonly reply: StoredReply;
};

type AskRunResult =
  { readonly kind: 'done'; readonly reply: StoredReply } | { readonly kind: 'conflict' };

type ReplayRecord = {
  readonly initiatorSubject: string;
  readonly requestDigestSha256: string;
  readonly reply?: StoredReply;
};

type Reservation =
  | AskRunResult
  | {
      readonly kind: 'owned';
      finish(produced: AskExecution): Promise<void>;
      release(): Promise<void>;
    };

export interface AuditLog {
  run(key: ClaimKey, execute: () => Promise<AskExecution>): Promise<AskRunResult>;
}

export type MemoryAuditLog = AuditLog & { rows(): readonly AuditEvent[] };

type ReplayRow = {
  initiator_subject: string;
  request_digest_sha256: string;
  response_status: number | null;
  response_body: string | null;
};

export const AUDIT_COLUMNS: readonly string[] = Object.keys(auditEventSchema.shape).map(
  camelToSnake,
);

export function createMemoryAuditLog(): MemoryAuditLog {
  const rows: AuditEvent[] = [];
  const saved = new Map<string, ReplayRecord>();
  const inflight = new Map<string, Promise<ReplayRecord | undefined>>();
  return {
    run(key, execute) {
      return settle(() => reserveMemory(saved, inflight, rows, key), execute);
    },
    rows() {
      return rows;
    },
  };
}

export function createPostgresAuditLog(sql: postgres.Sql): AuditLog {
  return {
    run(key, execute) {
      return settle(() => reservePostgres(sql, key), execute);
    },
  };
}

async function settle(
  reserve: () => Promise<Reservation>,
  execute: () => Promise<AskExecution>,
): Promise<AskRunResult> {
  const reservation = await reserve();
  if (reservation.kind !== 'owned') return reservation;
  try {
    const produced = await execute();
    await reservation.finish(produced);
    return { kind: 'done', reply: produced.reply };
  } finally {
    await reservation.release();
  }
}

function reserveMemory(
  saved: Map<string, ReplayRecord>,
  inflight: Map<string, Promise<ReplayRecord | undefined>>,
  rows: AuditEvent[],
  key: ClaimKey,
): Promise<Reservation> {
  const decision = storedDecision(saved.get(key.eventId), key);
  if (decision !== undefined) return Promise.resolve(decision);
  const pending = inflight.get(key.eventId);
  if (pending !== undefined) return waitFor(pending, key);
  let publish!: (record: ReplayRecord | undefined) => void;
  let settled = false;
  const gate = new Promise<ReplayRecord | undefined>((resolve) => {
    publish = (record) => {
      if (settled) return;
      settled = true;
      resolve(record);
    };
  });
  inflight.set(key.eventId, gate);
  return Promise.resolve({
    kind: 'owned',
    finish(produced) {
      const record = remember(rows, saved, key, produced);
      publish(record);
      return Promise.resolve();
    },
    release() {
      publish(undefined);
      inflight.delete(key.eventId);
      return Promise.resolve();
    },
  });
}

function waitFor(pending: Promise<ReplayRecord | undefined>, key: ClaimKey): Promise<AskRunResult> {
  return pending.then((record) => storedDecision(record, key) ?? { kind: 'conflict' });
}

function remember(
  rows: AuditEvent[],
  saved: Map<string, ReplayRecord>,
  key: ClaimKey,
  produced: AskExecution,
): ReplayRecord {
  rows.push(produced.event);
  const record = {
    initiatorSubject: key.initiatorSubject,
    requestDigestSha256: key.requestDigestSha256,
    reply: produced.reply,
  };
  saved.set(key.eventId, record);
  return record;
}

function storedDecision(record: ReplayRecord | undefined, key: ClaimKey): AskRunResult | undefined {
  if (record === undefined) return undefined;
  if (!sameCaller(record, key)) return { kind: 'conflict' };
  if (record.reply === undefined) return undefined;
  if (record.reply.status === 200) return { kind: 'done', reply: record.reply };
  return { kind: 'conflict' };
}

function sameCaller(record: ReplayRecord, key: ClaimKey): boolean {
  return (
    record.initiatorSubject === key.initiatorSubject &&
    record.requestDigestSha256 === key.requestDigestSha256
  );
}

async function reservePostgres(sql: postgres.Sql, key: ClaimKey): Promise<Reservation> {
  const conn = await sql.reserve();
  const held = hold(conn, key.eventId);
  try {
    await held.lock();
    const existing = await conn<ReplayRow[]>`
      select initiator_subject, request_digest_sha256, response_status, response_body
      from ask_replays
      where request_id = ${key.eventId}
    `;
    const row = existing.length > 0 ? existing[0] : undefined;
    const decision = storedDecision(recordFrom(row), key);
    if (decision !== undefined) {
      await held.release();
      return decision;
    }
    if (row === undefined) await insertReservation(conn, key);
    return {
      kind: 'owned',
      finish: (produced) => writeCompleted(conn, key, produced),
      release: () => held.release(),
    };
  } catch (error) {
    await held.release();
    throw new AuditWriteError('audit write', { cause: error });
  }
}

function hold(
  conn: postgres.ReservedSql,
  eventId: string,
): {
  lock(): Promise<void>;
  release(): Promise<void>;
} {
  let locked = false;
  let released = false;
  return {
    async lock() {
      await conn`select pg_advisory_lock(hashtextextended(${eventId}, 0))`;
      locked = true;
    },
    async release() {
      if (released) return;
      released = true;
      try {
        if (locked) await conn`select pg_advisory_unlock(hashtextextended(${eventId}, 0))`;
      } finally {
        conn.release();
      }
    },
  };
}

function recordFrom(row: ReplayRow | undefined): ReplayRecord | undefined {
  if (row === undefined) return undefined;
  const identity = {
    initiatorSubject: row.initiator_subject,
    requestDigestSha256: row.request_digest_sha256,
  };
  if (row.response_status === null || row.response_body === null) return identity;
  return {
    ...identity,
    reply: { status: row.response_status, body: parseJson(row.response_body) },
  };
}

async function insertReservation(conn: postgres.Sql, key: ClaimKey): Promise<void> {
  await conn`
    insert into ask_replays (request_id, initiator_subject, request_digest_sha256)
    values (${key.eventId}, ${key.initiatorSubject}, ${key.requestDigestSha256})
  `;
}

async function writeCompleted(
  conn: postgres.Sql,
  key: ClaimKey,
  produced: AskExecution,
): Promise<void> {
  const responseBody = JSON.stringify(produced.reply.body);
  await conn.unsafe('begin');
  try {
    await conn`insert into audit_events ${conn(toRow(produced.event), ...AUDIT_COLUMNS)}`;
    const updated = await conn`
      update ask_replays
      set response_status = ${produced.reply.status}, response_body = ${responseBody}
      where request_id = ${key.eventId}
    `;
    if (updated.count === 0) throw new Error('replay row missing');
    await conn.unsafe('commit');
  } catch (error) {
    await conn.unsafe('rollback').catch(() => undefined);
    throw new AuditWriteError('audit write', { cause: error });
  }
}

function parseJson(body: string): unknown {
  return JSON.parse(body) as unknown;
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
