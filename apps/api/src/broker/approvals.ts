import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { approvalDecidedSchema, approvalSchema } from '@agent-works/domain';

import type { Approval, ApprovalDecided } from '@agent-works/domain';
import type postgres from 'postgres';

const migrationName = '0003_approvals.sql';
const migrationLock = 7003;
const migrationPath = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../migrations/0003_approvals.sql',
);
const migrations = new WeakMap<postgres.Sql, Promise<void>>();
const approvalRequired = {
  ok: false,
  status: 422,
  code: 'APPROVAL_REQUIRED',
} as const;

export type DecisionCommand = {
  readonly actorSub: string;
  readonly decision: 'approve' | 'reject';
  readonly expectedPayloadSha256: string;
};

export type BindResult =
  | { readonly ok: true; readonly decided: ApprovalDecided }
  | typeof approvalRequired;

export type ClaimRequest = {
  readonly approvalId: string;
  readonly callId: string;
  readonly taskId: string;
  readonly stepId: string;
  readonly toolRef: string;
  readonly idempotencyKey: string;
  readonly targetResource: string;
  readonly payloadSha256: string;
  readonly policyDecisionId: string;
  readonly intendedAt: Date;
  readonly traceId: string;
  readonly actorSub: string;
  readonly approverAuthorized: (sub: string) => boolean;
  readonly now: Date;
};

export type ClaimOutcome =
  | { readonly kind: 'replay'; readonly receipt: string }
  | {
      readonly kind: 'resume';
      readonly policyDecisionId: string;
      readonly intendedAt: string;
      readonly traceId: string;
      readonly actorSub: string;
    }
  | { readonly kind: 'duplicate' }
  | { readonly kind: 'missing' }
  | { readonly kind: 'deny'; readonly code: 'APPROVAL_REQUIRED' | 'APPROVAL_EXPIRED' }
  | { readonly kind: 'intended' };

export type ApprovalStore = {
  save(approval: Approval): Promise<void>;
  read(id: string): Promise<Approval | undefined>;
  bind(id: string, command: DecisionCommand): Promise<BindResult>;
  claim(request: ClaimRequest): Promise<ClaimOutcome>;
  complete(callId: string, receipt: string): Promise<void>;
};

type CallRow = {
  readonly id: string;
  readonly taskId: string;
  readonly stepId: string;
  readonly toolRef: string;
  readonly idempotencyKey: string;
  readonly approvalId: string;
  readonly status: 'INTENDED' | 'COMPLETED';
  readonly externalReceipt: string | null;
  readonly payloadSha256: string;
  readonly policyDecisionId: string;
  readonly intendedAt: string;
  readonly traceId: string;
  readonly actorSub: string;
};

type ClaimEffect =
  | Exclude<ClaimOutcome, { kind: 'intended' }>
  | { readonly kind: 'intended'; readonly approval: Approval; readonly call: CallRow };

type ApprovalSql = {
  id: string;
  task_id: string;
  step_id: string;
  tool: string;
  target_resource: string;
  payload_sha256: string;
  requested_by_sub: string;
  approver_sub: string | null;
  state: string;
  expires_at: Date;
  max_executions: number;
  executions_used: number;
};

type CallSql = {
  id: string;
  task_id: string;
  step_id: string;
  tool_ref: string;
  idempotency_key: string;
  approval_id: string;
  status: string;
  external_receipt: string | null;
  payload_sha256: string;
  policy_decision_id: string;
  intended_at: Date;
  trace_id: string;
  actor_sub: string;
};

type Query = postgres.Sql | postgres.TransactionSql;

export async function applyApprovalsMigration(sql: postgres.Sql): Promise<void> {
  const body = readFileSync(migrationPath, 'utf8');
  await sql.begin(async (tx) => {
    await tx`select pg_advisory_xact_lock(${migrationLock})`;
    await tx`create table if not exists schema_migrations (
      name text primary key,
      applied_at timestamptz not null default now()
    )`;
    const applied = await tx<{ name: string }[]>`
      select name from schema_migrations where name = ${migrationName}
    `;
    if (applied.length > 0) return;
    await tx.unsafe(body);
    await tx`insert into schema_migrations (name) values (${migrationName})`;
  });
}

export function createPostgresApprovalStore(sql: postgres.Sql): ApprovalStore {
  const ready = ensureMigration(sql);
  return {
    save(approval) {
      return ready.then(() => insertApproval(sql, approval));
    },
    read(id) {
      return ready.then(() => selectApproval(sql, id));
    },
    bind(id, command) {
      return ready.then(() => bindPostgres(sql, id, command));
    },
    claim(request) {
      return ready.then(() => claimPostgres(sql, request));
    },
    complete(callId, receipt) {
      return ready.then(() => completePostgres(sql, callId, receipt));
    },
  };
}

export function createMemoryApprovalStore(): ApprovalStore {
  const approvals = new Map<string, Approval>();
  const calls = new Map<string, CallRow>();
  const callsByKey = new Map<string, CallRow>();
  const exclusive = serialize();
  return {
    save(approval) {
      return exclusive(() => {
        approvals.set(approval.id, approvalSchema.parse(approval));
      });
    },
    read(id) {
      return exclusive(() => approvals.get(id));
    },
    bind(id, command) {
      return exclusive(() => {
        const approval = approvals.get(id);
        if (approval === undefined) return approvalRequired;
        const judged = judge(approval, command);
        if (judged.kind === 'deny') return approvalRequired;
        if (judged.kind === 'updated') approvals.set(judged.approval.id, judged.approval);
        return { ok: true, decided: judged.decided };
      });
    },
    claim(request) {
      return exclusive(() => {
        const result = claimCall({
          approval: approvals.get(request.approvalId),
          calls: rowsFor(calls, callsByKey, request.callId, request.idempotencyKey),
          request,
        });
        if (result.kind !== 'intended') return result;
        approvals.set(result.approval.id, result.approval);
        remember(calls, callsByKey, result.call);
        return { kind: 'intended' };
      });
    },
    complete(callId, receipt) {
      return exclusive(() => {
        const existing = calls.get(callId);
        if (existing === undefined) throw new Error('tool call missing');
        remember(calls, callsByKey, {
          ...existing,
          status: 'COMPLETED',
          externalReceipt: receipt,
        });
      });
    },
  };
}

function rowsFor(
  calls: ReadonlyMap<string, CallRow>,
  callsByKey: ReadonlyMap<string, CallRow>,
  callId: string,
  idempotencyKey: string,
): CallRow[] {
  const byId = calls.get(callId);
  const byKey = callsByKey.get(idempotencyKey);
  if (byId !== undefined && (byKey === undefined || byId === byKey)) return [byId];
  if (byKey !== undefined && byId === undefined) return [byKey];
  if (byId !== undefined && byKey !== undefined) return [byId, byKey];
  return [];
}

function remember(
  calls: Map<string, CallRow>,
  callsByKey: Map<string, CallRow>,
  call: CallRow,
): void {
  calls.set(call.id, call);
  callsByKey.set(call.idempotencyKey, call);
}

function claimCall(input: {
  readonly approval: Approval | undefined;
  readonly calls: readonly CallRow[];
  readonly request: ClaimRequest;
}): ClaimEffect {
  const byId = input.calls.find((call) => call.id === input.request.callId);
  const byKey = input.calls.find((call) => call.idempotencyKey === input.request.idempotencyKey);
  if (byId !== undefined && byId.idempotencyKey !== input.request.idempotencyKey) {
    return { kind: 'duplicate' };
  }
  if (byKey !== undefined && byKey.id !== input.request.callId) {
    return { kind: 'duplicate' };
  }
  const existing = byId ?? byKey;
  if (existing !== undefined) return existingCall(existing, input.request);
  if (input.approval === undefined) return { kind: 'missing' };
  const verdict = classify(input.approval, input.request);
  if (verdict !== 'bound') return { kind: 'deny', code: verdict };
  const approval = approvalSchema.parse({
    ...input.approval,
    executionsUsed: input.approval.executionsUsed + 1,
  });
  return {
    kind: 'intended',
    approval,
    call: {
      id: input.request.callId,
      taskId: input.request.taskId,
      stepId: input.request.stepId,
      toolRef: input.request.toolRef,
      idempotencyKey: input.request.idempotencyKey,
      approvalId: input.request.approvalId,
      status: 'INTENDED',
      externalReceipt: null,
      payloadSha256: input.request.payloadSha256,
      policyDecisionId: input.request.policyDecisionId,
      intendedAt: input.request.intendedAt.toISOString(),
      traceId: input.request.traceId,
      actorSub: input.request.actorSub,
    },
  };
}

function existingCall(existing: CallRow, request: ClaimRequest): ClaimEffect {
  if (!sameCall(existing, request)) return { kind: 'deny', code: 'APPROVAL_REQUIRED' };
  if (existing.status === 'COMPLETED' && existing.externalReceipt !== null) {
    return { kind: 'replay', receipt: existing.externalReceipt };
  }
  return {
    kind: 'resume',
    policyDecisionId: existing.policyDecisionId,
    intendedAt: existing.intendedAt,
    traceId: existing.traceId,
    actorSub: existing.actorSub,
  };
}

function sameCall(existing: CallRow, request: ClaimRequest): boolean {
  return (
    existing.payloadSha256 === request.payloadSha256 &&
    existing.taskId === request.taskId &&
    existing.stepId === request.stepId &&
    existing.toolRef === request.toolRef &&
    existing.approvalId === request.approvalId
  );
}

function classify(
  approval: Approval,
  request: ClaimRequest,
): 'bound' | 'APPROVAL_REQUIRED' | 'APPROVAL_EXPIRED' {
  if (approval.state !== 'approved') return 'APPROVAL_REQUIRED';
  if (Date.parse(approval.expiresAt) <= request.now.getTime()) return 'APPROVAL_EXPIRED';
  if (approval.approverSub === null || approval.approverSub === approval.requestedBySub) {
    return 'APPROVAL_REQUIRED';
  }
  if (!request.approverAuthorized(approval.approverSub)) return 'APPROVAL_REQUIRED';
  if (approval.taskId !== request.taskId) return 'APPROVAL_REQUIRED';
  if (approval.stepId !== request.stepId) return 'APPROVAL_REQUIRED';
  if (approval.tool !== request.toolRef) return 'APPROVAL_REQUIRED';
  if (approval.targetResource !== request.targetResource) return 'APPROVAL_REQUIRED';
  if (approval.payloadSha256 !== request.payloadSha256) return 'APPROVAL_REQUIRED';
  if (approval.executionsUsed >= approval.maxExecutions) return 'APPROVAL_REQUIRED';
  return 'bound';
}

function judge(
  approval: Approval,
  command: DecisionCommand,
):
  | { readonly kind: 'deny' }
  | { readonly kind: 'unchanged'; readonly decided: ApprovalDecided }
  | { readonly kind: 'updated'; readonly approval: Approval; readonly decided: ApprovalDecided } {
  if (approval.state === 'approved' || approval.state === 'rejected') {
    return { kind: 'unchanged', decided: toDecided(approval) };
  }
  if (command.decision === 'approve' && command.actorSub === approval.requestedBySub) {
    return { kind: 'deny' };
  }
  if (command.expectedPayloadSha256 !== approval.payloadSha256) return { kind: 'deny' };
  const state = command.decision === 'approve' ? 'approved' : 'rejected';
  const next = approvalSchema.parse({ ...approval, state, approverSub: command.actorSub });
  return { kind: 'updated', approval: next, decided: toDecided(next) };
}

function toDecided(approval: Approval): ApprovalDecided {
  if (approval.state !== 'approved' && approval.state !== 'rejected') {
    throw new Error('approval is undecided');
  }
  return approvalDecidedSchema.parse({
    id: approval.id,
    state: approval.state,
    executionsUsed: approval.executionsUsed,
  });
}

function ensureMigration(sql: postgres.Sql): Promise<void> {
  const existing = migrations.get(sql);
  if (existing !== undefined) return existing;
  const pending = applyApprovalsMigration(sql);
  migrations.set(sql, pending);
  return pending;
}

async function bindPostgres(
  sql: postgres.Sql,
  id: string,
  command: DecisionCommand,
): Promise<BindResult> {
  return sql.begin(async (tx) => {
    const approval = await lockApproval(tx, id);
    if (approval === undefined) return approvalRequired;
    const judged = judge(approval, command);
    if (judged.kind === 'deny') return approvalRequired;
    if (judged.kind === 'updated') await updateDecision(tx, judged.approval);
    return { ok: true, decided: judged.decided };
  });
}

async function claimPostgres(sql: postgres.Sql, request: ClaimRequest): Promise<ClaimOutcome> {
  return sql.begin(async (tx) => {
    const approval = await lockApproval(tx, request.approvalId);
    const calls = await lockCalls(tx, request.callId, request.idempotencyKey);
    const result = claimCall({ approval, calls, request });
    if (result.kind !== 'intended') return result;
    await updateUsage(tx, result.approval);
    await insertCall(tx, result.call);
    return { kind: 'intended' };
  });
}

async function insertApproval(sql: postgres.Sql, approval: Approval): Promise<void> {
  const parsed = approvalSchema.parse(approval);
  await sql`
    insert into approvals (
      id, task_id, step_id, tool, target_resource, payload_sha256, requested_by_sub,
      approver_sub, state, expires_at, max_executions, executions_used
    ) values (
      ${parsed.id}, ${parsed.taskId}, ${parsed.stepId}, ${parsed.tool}, ${parsed.targetResource},
      ${parsed.payloadSha256}, ${parsed.requestedBySub}, ${parsed.approverSub}, ${parsed.state},
      ${parsed.expiresAt}, ${parsed.maxExecutions}, ${parsed.executionsUsed}
    )
  `;
}

function selectApproval(sql: postgres.Sql, id: string): Promise<Approval | undefined> {
  return readApproval(sql, id, false);
}

function lockApproval(tx: postgres.TransactionSql, id: string): Promise<Approval | undefined> {
  return readApproval(tx, id, true);
}

async function readApproval(
  query: Query,
  id: string,
  lock: boolean,
): Promise<Approval | undefined> {
  const rows = lock
    ? await query<ApprovalSql[]>`
        select id, task_id, step_id, tool, target_resource, payload_sha256, requested_by_sub,
               approver_sub, state, expires_at, max_executions, executions_used
        from approvals
        where id = ${id}
        for update
      `
    : await query<ApprovalSql[]>`
        select id, task_id, step_id, tool, target_resource, payload_sha256, requested_by_sub,
               approver_sub, state, expires_at, max_executions, executions_used
        from approvals
        where id = ${id}
      `;
  const row = rows.at(0);
  if (row === undefined) return undefined;
  return toApproval(row);
}

async function lockCalls(
  tx: postgres.TransactionSql,
  callId: string,
  idempotencyKey: string,
): Promise<CallRow[]> {
  const rows = await tx<CallSql[]>`
    select id, task_id, step_id, tool_ref, idempotency_key, approval_id, status,
           external_receipt, payload_sha256, policy_decision_id, intended_at,
           trace_id, actor_sub
    from tool_calls
    where id = ${callId} or idempotency_key = ${idempotencyKey}
    for update
  `;
  return rows.map(toCall);
}

async function updateDecision(query: Query, approval: Approval): Promise<void> {
  await query`
    update approvals
    set state = ${approval.state}, approver_sub = ${approval.approverSub}
    where id = ${approval.id}
  `;
}

async function updateUsage(query: Query, approval: Approval): Promise<void> {
  await query`
    update approvals
    set executions_used = ${approval.executionsUsed}
    where id = ${approval.id}
  `;
}

async function insertCall(query: Query, call: CallRow): Promise<void> {
  await query`
    insert into tool_calls (
      id, task_id, step_id, tool_ref, idempotency_key, approval_id, status,
      external_receipt, payload_sha256, policy_decision_id, intended_at,
      trace_id, actor_sub
    ) values (
      ${call.id}, ${call.taskId}, ${call.stepId}, ${call.toolRef}, ${call.idempotencyKey},
      ${call.approvalId}, ${call.status}, ${call.externalReceipt}, ${call.payloadSha256},
      ${call.policyDecisionId}, ${call.intendedAt}, ${call.traceId}, ${call.actorSub}
    )
  `;
}

async function completePostgres(sql: postgres.Sql, callId: string, receipt: string): Promise<void> {
  await sql`
    update tool_calls
    set status = 'COMPLETED', external_receipt = ${receipt}
    where id = ${callId}
  `;
}

function toApproval(row: ApprovalSql): Approval {
  return approvalSchema.parse({
    id: row.id,
    taskId: row.task_id,
    stepId: row.step_id,
    tool: row.tool,
    targetResource: row.target_resource,
    payloadSha256: row.payload_sha256,
    requestedBySub: row.requested_by_sub,
    approverSub: row.approver_sub,
    state: row.state,
    expiresAt: row.expires_at.toISOString(),
    maxExecutions: row.max_executions,
    executionsUsed: row.executions_used,
  });
}

function toCall(row: CallSql): CallRow {
  return {
    id: row.id,
    taskId: row.task_id,
    stepId: row.step_id,
    toolRef: row.tool_ref,
    idempotencyKey: row.idempotency_key,
    approvalId: row.approval_id,
    status: callStatus(row.status),
    externalReceipt: row.external_receipt,
    payloadSha256: row.payload_sha256,
    policyDecisionId: row.policy_decision_id,
    intendedAt: row.intended_at.toISOString(),
    traceId: row.trace_id,
    actorSub: row.actor_sub,
  };
}

function callStatus(value: string): 'INTENDED' | 'COMPLETED' {
  if (value === 'INTENDED' || value === 'COMPLETED') return value;
  throw new Error('tool call status');
}

function serialize(): <T>(work: () => Promise<T> | T) => Promise<T> {
  let tail = Promise.resolve();
  return (work) => {
    const run = tail.then(work);
    tail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  };
}
