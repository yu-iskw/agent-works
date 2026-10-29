import { existsSync } from 'node:fs';

import {
  WORKBENCH_API_VERSION,
  canTransition,
  workbenchActionProposalSchema,
} from '@agent-works/domain/workbench';

import { ModelError, modelRemediation } from './model-port.js';
import { approvalDigest } from './report.js';

import type { ModelPort } from './model-port.js';
import type { DocumentBody } from './report.js';
import type { WorkspacePort } from './workspace.js';
import type {
  WorkbenchAction,
  WorkbenchApproval,
  WorkbenchArtifact,
  WorkbenchCreate,
  WorkbenchDecision,
  WorkbenchEvent,
  WorkbenchEventType,
  WorkbenchEvidence,
  WorkbenchReadiness,
  WorkbenchStatus,
  WorkbenchTaskDetail,
  WorkbenchTaskSummary,
} from '@agent-works/domain/workbench';
import type postgres from 'postgres';

export type Owner = { readonly sub: string; readonly email: string | null };

export type ModelSetup =
  | { readonly kind: 'ready'; readonly model: ModelPort }
  | { readonly kind: 'not_configured'; readonly missing: readonly string[] };

export type WorkbenchDeps = {
  readonly sql: postgres.Sql;
  readonly model: ModelSetup;
  readonly workspace: WorkspacePort;
  readonly faultsEnabled: boolean;
  readonly maxModelCalls: number;
  readonly vertex: { readonly project: string; readonly location: string };
  readonly credentialsPath: string | undefined;
  readonly now: () => Date;
  readonly newId: () => string;
};

export type EventInput = {
  readonly type: WorkbenchEventType;
  readonly summary: string;
  readonly detail?: Readonly<Record<string, string | number | boolean | null>>;
  readonly durationMs?: number;
};

type TaskError = { readonly code: string; readonly message: string };

/** One state-machine edge. `error` undefined keeps the stored error, null clears it, a value replaces it. */
export type Change = {
  readonly to: WorkbenchStatus;
  readonly events: readonly EventInput[];
  readonly error?: TaskError | null;
};

export type ModelCall = {
  readonly outcome: string;
  /** False when the failure happened before any request left the process. */
  readonly sent: boolean;
  readonly modelVersion?: string;
  readonly responseId?: string;
  readonly latencyMs?: number;
  readonly promptTokens?: number;
  readonly outputTokens?: number;
};

export class WorkbenchConflict extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = 'WorkbenchConflict';
  }
}

export const approvalTtlMs = 24 * 60 * 60 * 1000;

type TaskRow = {
  id: string;
  owner_sub: string;
  owner_email: string | null;
  title: string;
  objective: string;
  status: WorkbenchStatus;
  version: number;
  attempt: number;
  llm_mode: 'vertex' | 'stub';
  model_id: string;
  error_code: string | null;
  error_message: string | null;
  created_at: Date;
  updated_at: Date;
};

export type Tx = postgres.TransactionSql;

type ModelInfo = { readonly mode: 'vertex' | 'stub'; readonly modelId: string };

function titleFor(objective: string): string {
  const first = objective.split(/(?<=[.!?])\s|\n/)[0]?.trim() ?? objective.trim();
  return first.length > 90 ? `${first.slice(0, 87).trimEnd()}...` : first;
}

function modelInfo(setup: ModelSetup): ModelInfo {
  return setup.kind === 'ready'
    ? { mode: setup.model.mode, modelId: setup.model.modelId }
    : { mode: 'vertex', modelId: 'unconfigured' };
}

export async function lockTask(
  tx: Tx,
  ownerSub: string | undefined,
  id: string,
): Promise<TaskRow | undefined> {
  const rows = await tx<TaskRow[]>`
    select * from wb_tasks where id = ${id} and kind = 'flagship'
    ${ownerSub === undefined ? tx`` : tx`and owner_sub = ${ownerSub}`}
    for update
  `;
  return rows.at(0);
}

export async function appendEvent(
  deps: WorkbenchDeps,
  tx: Tx,
  taskId: string,
  event: EventInput,
): Promise<void> {
  await tx`
    insert into wb_events (task_id, seq, type, summary, detail, duration_ms, at)
    select ${taskId}, coalesce(max(seq), 0) + 1, ${event.type}, ${event.summary},
           ${tx.json(event.detail ?? {})}, ${event.durationMs ?? null},
           ${deps.now()}
    from wb_events where task_id = ${taskId}
  `;
}

/** Moves a locked task only along an allowed edge; returns false if the row moved on. */
export async function move(
  deps: WorkbenchDeps,
  tx: Tx,
  task: TaskRow,
  change: Change,
): Promise<boolean> {
  const { to, events, error } = change;
  if (!canTransition(task.status, to)) return false;
  const rows = await tx`
    update wb_tasks set status = ${to}, version = version + 1, updated_at = ${deps.now()},
      error_code = ${error === undefined ? task.error_code : (error?.code ?? null)},
      error_message = ${error === undefined ? task.error_message : (error?.message ?? null)}
    where id = ${task.id} and status = ${task.status}
    returning id
  `;
  if (rows.length === 0) return false;
  for (const event of events) await appendEvent(deps, tx, task.id, event);
  return true;
}

export async function transition(
  deps: WorkbenchDeps,
  taskId: string,
  from: WorkbenchStatus,
  change: Change,
): Promise<boolean> {
  return deps.sql.begin(async (tx) => {
    const task = await lockTask(tx, undefined, taskId);
    if (task?.status !== from) return false;
    return move(deps, tx, task, change);
  });
}

export async function event(deps: WorkbenchDeps, taskId: string, input: EventInput): Promise<void> {
  await deps.sql.begin(async (tx) => {
    await lockTask(tx, undefined, taskId);
    await appendEvent(deps, tx, taskId, input);
  });
}

async function create(
  deps: WorkbenchDeps,
  owner: Owner,
  input: WorkbenchCreate,
): Promise<{ readonly task: WorkbenchTaskSummary; readonly created: boolean }> {
  const info = modelInfo(deps.model);
  return deps.sql.begin(async (tx) => {
    const id = deps.newId();
    const at = deps.now();
    const inserted = await tx<TaskRow[]>`
      insert into wb_tasks (id, owner_sub, owner_email, client_request_id, title, objective,
        status, version, llm_mode, model_id, created_at, updated_at)
      values (${id}, ${owner.sub}, ${owner.email}, ${input.clientRequestId},
        ${titleFor(input.objective)}, ${input.objective}, 'queued', 1, ${info.mode},
        ${info.modelId}, ${at}, ${at})
      on conflict (owner_sub, client_request_id) do nothing
      returning *
    `;
    const row = inserted.at(0);
    if (row !== undefined) {
      await appendEvent(deps, tx, row.id, {
        type: 'task.created',
        summary: 'Task submitted',
        detail: { mode: info.mode, model: info.modelId },
      });
      return { task: summary(row), created: true };
    }
    const existing = await tx<TaskRow[]>`
      select * from wb_tasks
      where owner_sub = ${owner.sub} and client_request_id = ${input.clientRequestId}
        and kind = 'flagship'
    `;
    const prior = existing.at(0);
    if (prior === undefined || prior.objective !== input.objective)
      throw new WorkbenchConflict('client_request_reused');
    return { task: summary(prior), created: false };
  });
}

async function list(sql: postgres.Sql, ownerSub: string): Promise<readonly WorkbenchTaskSummary[]> {
  const rows = await sql<TaskRow[]>`
    select * from wb_tasks where owner_sub = ${ownerSub} and kind = 'flagship'
    order by created_at desc limit 100
  `;
  return rows.map(summary);
}

async function taskRow(
  sql: postgres.Sql,
  ownerSub: string,
  id: string,
): Promise<TaskRow | undefined> {
  const rows = await sql<TaskRow[]>`
    select * from wb_tasks where id = ${id} and owner_sub = ${ownerSub} and kind = 'flagship'
  `;
  return rows.at(0);
}

async function task(
  sql: postgres.Sql,
  ownerSub: string,
  id: string,
): Promise<WorkbenchTaskSummary | undefined> {
  const row = await taskRow(sql, ownerSub, id);
  return row === undefined ? undefined : summary(row);
}

async function detail(
  sql: postgres.Sql,
  ownerSub: string,
  id: string,
): Promise<WorkbenchTaskDetail | undefined> {
  const row = await taskRow(sql, ownerSub, id);
  if (row === undefined) return undefined;
  const [events, evidence, artifact, approval, action] = await Promise.all([
    sql<EventRow[]>`select * from wb_events where task_id = ${id} order by seq`,
    evidenceFor(sql, id, row.attempt),
    sql<ArtifactRow[]>`select * from wb_artifacts where task_id = ${id}`,
    sql<ApprovalRow[]>`select * from wb_approvals where task_id = ${id}`,
    sql<ActionRow[]>`select * from wb_actions where task_id = ${id}`,
  ]);
  const artifactRow = artifact.at(0);
  const approvalRow = approval.at(0);
  const actionRow = action.at(0);
  return {
    apiVersion: WORKBENCH_API_VERSION,
    task: summary(row),
    events: events.map(eventView),
    evidence,
    artifact: artifactRow === undefined ? null : artifactView(artifactRow),
    approval: approvalRow === undefined ? null : approvalView(approvalRow),
    action: actionRow === undefined ? null : actionView(actionRow),
  };
}

async function cancel(deps: WorkbenchDeps, ownerSub: string, id: string): Promise<boolean> {
  return deps.sql.begin(async (tx) => {
    const task = await lockTask(tx, ownerSub, id);
    if (task === undefined) return false;
    const requested: EventInput = {
      type: 'task.cancel_requested',
      summary: 'Cancellation requested by the owner',
    };
    if (task.status === 'queued') {
      return move(deps, tx, task, {
        to: 'cancelled',
        events: [requested, { type: 'task.cancelled', summary: 'Task cancelled' }],
      });
    }
    if (task.status === 'running') {
      return move(deps, tx, task, { to: 'cancel_requested', events: [requested] });
    }
    if (task.status === 'waiting_approval') {
      await tx`update wb_approvals set state = 'void' where task_id = ${id} and state = 'pending'`;
      return move(deps, tx, task, {
        to: 'cancelled',
        events: [
          requested,
          {
            type: 'task.cancelled',
            summary: 'Task cancelled. The pending approval was voided; nothing was written.',
          },
        ],
      });
    }
    throw new WorkbenchConflict(`cannot_cancel_${task.status}`);
  });
}

async function retry(deps: WorkbenchDeps, ownerSub: string, id: string): Promise<boolean> {
  return deps.sql.begin(async (tx) => {
    const task = await lockTask(tx, ownerSub, id);
    if (task === undefined) return false;
    if (task.status !== 'failed') throw new WorkbenchConflict(`cannot_retry_${task.status}`);
    const action = await tx`
      update wb_actions set status = 'intended', updated_at = ${deps.now()}
      where task_id = ${id} returning task_id
    `;
    if (action.length > 0) {
      return move(deps, tx, task, {
        to: 'executing',
        events: [
          {
            type: 'task.retried',
            summary: 'Retrying the approved write with the same idempotency key',
          },
        ],
        error: null,
      });
    }
    await tx`update wb_tasks set attempt = attempt + 1 where id = ${id}`;
    return move(deps, tx, task, {
      to: 'queued',
      events: [{ type: 'task.retried', summary: `Retry requested (attempt ${task.attempt + 1})` }],
      error: null,
    });
  });
}

async function decide(
  deps: WorkbenchDeps,
  owner: Owner,
  id: string,
  decision: WorkbenchDecision,
): Promise<'approved' | 'rejected' | 'expired' | undefined> {
  return deps.sql.begin(async (tx) => {
    const task = await lockTask(tx, owner.sub, id);
    if (task === undefined) return undefined;
    const rows = await tx<
      ApprovalRow[]
    >`select * from wb_approvals where task_id = ${id} for update`;
    const approval = rows.at(0);
    if (approval === undefined) throw new WorkbenchConflict('no_approval');
    if (approval.state !== 'pending') throw new WorkbenchConflict('already_decided');
    if (task.status !== 'waiting_approval') throw new WorkbenchConflict('not_awaiting_approval');
    if (approval.payload_sha256 !== decision.expectedPayloadSha256)
      throw new WorkbenchConflict('stale_digest');
    const proposal = workbenchActionProposalSchema.parse(approval.proposal);
    if (approvalDigest(proposal, approval.document) !== approval.payload_sha256)
      throw new WorkbenchConflict('approval_tampered');
    const at = deps.now();
    if (approval.expires_at.getTime() <= at.getTime()) {
      // Expiry is a terminal outcome for this proposal; failing the task lets Retry draft a new one.
      await tx`update wb_approvals set state = 'void' where id = ${approval.id}`;
      await move(deps, tx, task, {
        to: 'failed',
        events: [
          {
            type: 'task.failed',
            summary: 'The approval expired before a decision. Nothing was written.',
          },
        ],
        error: {
          code: 'approval_expired',
          message: 'The approval expired. Retry to draft a fresh proposal.',
        },
      });
      return 'expired';
    }
    if (decision.decision === 'reject') {
      await tx`update wb_approvals set state = 'rejected', decided_by = ${owner.sub}, decided_at = ${at} where id = ${approval.id}`;
      await move(deps, tx, task, {
        to: 'declined',
        events: [
          {
            type: 'approval.rejected',
            summary:
              'Owner rejected the document write. Nothing was written; the draft stays here.',
          },
        ],
      });
      return 'rejected';
    }
    await tx`update wb_approvals set state = 'approved', decided_by = ${owner.sub}, decided_at = ${at} where id = ${approval.id}`;
    await tx`
      insert into wb_actions (task_id, approval_id, idempotency_key, status, simulated, updated_at)
      values (${id}, ${approval.id}, ${`wb:${id}:${approval.id}`}, 'intended',
              ${deps.workspace.simulated}, ${at})
    `;
    await move(deps, tx, task, {
      to: 'executing',
      events: [
        {
          type: 'approval.approved',
          summary: 'Owner approved creating one document',
          detail: { payloadSha256: approval.payload_sha256.slice(0, 12) },
        },
      ],
    });
    return 'approved';
  });
}

async function reconcile(deps: WorkbenchDeps, ownerSub: string, id: string): Promise<boolean> {
  const rows = await deps.sql<ActionRow[]>`
    select a.* from wb_actions a join wb_tasks t on t.id = a.task_id
    where a.task_id = ${id} and t.owner_sub = ${ownerSub} and t.kind = 'flagship'
  `;
  const action = rows.at(0);
  if (action === undefined) return false;
  const found = await deps.workspace.findDoc(action.idempotency_key);
  return deps.sql.begin(async (tx) => {
    const task = await lockTask(tx, ownerSub, id);
    if (task === undefined) return false;
    if (task.status !== 'outcome_uncertain')
      throw new WorkbenchConflict(`cannot_reconcile_${task.status}`);
    if (found !== undefined) {
      await tx`
        update wb_actions set status = 'succeeded', external_id = ${found.docId},
          external_url = ${found.url}, updated_at = ${deps.now()}
        where task_id = ${id}
      `;
      return move(deps, tx, task, {
        to: 'completed',
        events: [
          {
            type: 'action.reconciled',
            summary: 'Found the document from the earlier attempt. No new write was made.',
            detail: { docId: found.docId },
          },
          { type: 'task.completed', summary: 'Task completed' },
        ],
        error: null,
      });
    }
    return move(deps, tx, task, {
      to: 'executing',
      events: [
        {
          type: 'action.reconciled',
          summary: 'No document found. Retrying the write with the same idempotency key.',
        },
      ],
      error: null,
    });
  });
}

/** Every Vertex request that left the process counts against the local budget, whatever it returned. */
async function vertexCallsUsed(sql: postgres.Sql): Promise<number> {
  const rows = await sql<{ n: number }[]>`
    select count(*)::int as n from wb_model_calls where mode = 'vertex' and sent and segment is null
  `;
  return rows.at(0)?.n ?? 0;
}

async function lastModelCall(
  sql: postgres.Sql,
  info: ModelInfo,
): Promise<ModelCallRow | undefined> {
  const rows = await sql<ModelCallRow[]>`
    select * from wb_model_calls
    where mode = ${info.mode} and model_id = ${info.modelId} and segment is null
    order by id desc limit 1
  `;
  return rows.at(0);
}

export async function recordModelCall(
  deps: WorkbenchDeps,
  taskId: string | null,
  call: ModelCall,
): Promise<void> {
  const info = modelInfo(deps.model);
  await deps.sql`
    insert into wb_model_calls (task_id, mode, model_id, model_version, response_id, outcome,
      sent, latency_ms, prompt_tokens, output_tokens, at)
    values (${taskId}, ${info.mode}, ${info.modelId}, ${call.modelVersion ?? null},
      ${call.responseId ?? null}, ${call.outcome}, ${call.sent}, ${call.latencyMs ?? null},
      ${call.promptTokens ?? null}, ${call.outputTokens ?? null}, ${deps.now()})
  `;
}

export async function ensureBudget(deps: WorkbenchDeps): Promise<void> {
  if (modelInfo(deps.model).mode !== 'vertex') return;
  if ((await vertexCallsUsed(deps.sql)) >= deps.maxModelCalls)
    throw new ModelError('budget_exhausted', false);
}

type Credentials = WorkbenchReadiness['model']['credentials'];

function credentialsState(info: ModelInfo, path: string | undefined): Credentials {
  if (info.mode === 'stub') return 'not_required';
  // Without an explicit file, ADC may still come from gcloud's well-known path or a metadata server.
  if (path === undefined) return 'ambient';
  // Operator-supplied credentials path from the environment, never request controlled.
  // eslint-disable-next-line security/detect-non-literal-fs-filename
  return existsSync(path) ? 'present' : 'missing';
}

type ModelHealth = Pick<WorkbenchReadiness['model'], 'state' | 'errorCode'>;

function modelHealth(
  setup: ModelSetup,
  credentials: Credentials,
  last: ModelCallRow | undefined,
): ModelHealth {
  if (setup.kind === 'not_configured')
    return { state: 'not_configured', errorCode: 'not_configured' };
  if (credentials === 'missing') return { state: 'error', errorCode: 'adc_unavailable' };
  if (setup.model.mode === 'stub') return { state: 'ready', errorCode: null };
  if (last === undefined) return { state: 'unverified', errorCode: null };
  if (last.outcome === 'ok') return { state: 'ready', errorCode: null };
  return { state: 'error', errorCode: last.outcome };
}

async function readiness(
  deps: WorkbenchDeps,
  credentials: Credentials,
  owner: Owner,
): Promise<WorkbenchReadiness> {
  const info = modelInfo(deps.model);
  const [used, last, pending] = await Promise.all([
    vertexCallsUsed(deps.sql),
    lastModelCall(deps.sql, info),
    deps.sql<{ n: number }[]>`
      select count(*)::int as n from wb_tasks
      where owner_sub = ${owner.sub} and kind = 'flagship' and status = 'waiting_approval'
    `,
  ]);
  const { state, errorCode } = modelHealth(deps.model, credentials, last);
  return {
    apiVersion: WORKBENCH_API_VERSION,
    identity: { sub: owner.sub, email: owner.email, localOnly: true },
    pendingApprovals: pending.at(0)?.n ?? 0,
    model: {
      mode: info.mode,
      state,
      modelId: info.modelId,
      project: deps.vertex.project,
      location: deps.vertex.location,
      credentials,
      lastCall:
        last === undefined
          ? null
          : { at: last.at.toISOString(), outcome: last.outcome, latencyMs: last.latency_ms },
      callsUsed: used,
      callsLimit: deps.maxModelCalls,
      errorCode,
      remediation:
        errorCode !== null && errorCode in modelRemediation
          ? modelRemediation[errorCode as keyof typeof modelRemediation]
          : null,
    },
    workspace: {
      adapter: 'fixture',
      simulated: true,
      readScope:
        'Fixture Drive corpus filtered by per-document readers (live equivalent: https://www.googleapis.com/auth/drive.readonly)',
      writeScope:
        'Fixture Docs store (live equivalent: https://www.googleapis.com/auth/drive.file, requested separately)',
      note: 'Live Google Drive and Docs integration is pending. Every document here is synthetic demo data.',
    },
  };
}

/** The owner-facing API the routes expose; the worker uses the exported primitives directly. */
export function createWorkbenchService(deps: WorkbenchDeps) {
  const { sql } = deps;
  const credentials = credentialsState(modelInfo(deps.model), deps.credentialsPath);
  return {
    create: (owner: Owner, input: WorkbenchCreate) => create(deps, owner, input),
    list: (ownerSub: string) => list(sql, ownerSub),
    task: (ownerSub: string, id: string) => task(sql, ownerSub, id),
    detail: (ownerSub: string, id: string) => detail(sql, ownerSub, id),
    cancel: (ownerSub: string, id: string) => cancel(deps, ownerSub, id),
    retry: (ownerSub: string, id: string) => retry(deps, ownerSub, id),
    decide: (owner: Owner, id: string, decision: WorkbenchDecision) =>
      decide(deps, owner, id, decision),
    reconcile: (ownerSub: string, id: string) => reconcile(deps, ownerSub, id),
    readiness: (owner: Owner) => readiness(deps, credentials, owner),
  };
}

export type WorkbenchService = ReturnType<typeof createWorkbenchService>;

type EventRow = {
  seq: number;
  type: WorkbenchEventType;
  summary: string;
  detail: Record<string, string | number | boolean | null>;
  duration_ms: number | null;
  at: Date;
};

type EvidenceRow = {
  id: string;
  ordinal: number;
  source_id: string;
  title: string;
  excerpt: string;
  url: string | null;
  modified_at: Date;
  retrieved_at: Date;
  provenance: string;
};

type ArtifactRow = {
  report: WorkbenchArtifact['report'];
  model: WorkbenchArtifact['model'];
  dropped_citations: number;
  created_at: Date;
};

type ApprovalRow = {
  id: string;
  proposal: unknown;
  document: DocumentBody;
  payload_sha256: string;
  state: WorkbenchApproval['state'];
  requested_at: Date;
  expires_at: Date;
  decided_by: string | null;
  decided_at: Date | null;
};

type ActionRow = {
  idempotency_key: string;
  status: WorkbenchAction['status'];
  simulated: boolean;
  attempts: number;
  external_id: string | null;
  external_url: string | null;
  updated_at: Date;
};

type ModelCallRow = { outcome: string; latency_ms: number | null; at: Date };

async function evidenceFor(
  sql: postgres.Sql,
  taskId: string,
  attempt: number,
): Promise<WorkbenchEvidence[]> {
  const rows = await sql<EvidenceRow[]>`
    select * from wb_evidence where task_id = ${taskId} and attempt = ${attempt} order by ordinal
  `;
  return rows.map((row) => ({
    id: row.id,
    ordinal: row.ordinal,
    sourceId: row.source_id,
    title: row.title,
    excerpt: row.excerpt,
    url: row.url,
    modifiedAt: row.modified_at.toISOString(),
    retrievedAt: row.retrieved_at.toISOString(),
    provenance: row.provenance,
  }));
}

function summary(row: TaskRow): WorkbenchTaskSummary {
  return {
    id: row.id,
    title: row.title,
    objective: row.objective,
    status: row.status,
    version: row.version,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
    llmMode: row.llm_mode,
    modelId: row.model_id,
    errorCode: row.error_code,
    errorMessage: row.error_message,
  };
}

function eventView(row: EventRow): WorkbenchEvent {
  return {
    seq: row.seq,
    type: row.type,
    summary: row.summary,
    at: row.at.toISOString(),
    durationMs: row.duration_ms,
    detail: row.detail,
  };
}

function artifactView(row: ArtifactRow): WorkbenchArtifact {
  return {
    report: row.report,
    model: row.model,
    droppedCitations: row.dropped_citations,
    createdAt: row.created_at.toISOString(),
  };
}

function approvalView(row: ApprovalRow): WorkbenchApproval {
  return {
    id: row.id,
    state: row.state,
    proposal: workbenchActionProposalSchema.parse(row.proposal),
    payloadSha256: row.payload_sha256,
    requestedAt: row.requested_at.toISOString(),
    expiresAt: row.expires_at.toISOString(),
    decidedBy: row.decided_by,
    decidedAt: row.decided_at?.toISOString() ?? null,
  };
}

function actionView(row: ActionRow): WorkbenchAction {
  return {
    status: row.status,
    simulated: row.simulated,
    attempts: row.attempts,
    externalId: row.external_id,
    externalUrl: row.external_url,
    updatedAt: row.updated_at.toISOString(),
  };
}
