import {
  TERMINAL_ASSIGNMENT,
  canAssignmentTransition,
  canTeamworkTransition,
} from '@agent-works/domain/teamwork';
import { desiredInbox } from '@agent-works/domain/teamwork-inbox';

import type { Deps, Tx } from './context.js';
import type {
  AssignmentStatus,
  Calculation,
  Contribution,
  EvidenceView,
  SkillDefinition,
  SourceKind,
  TaskScope,
  TeamworkStatus,
  Workflow,
} from '@agent-works/domain/teamwork';
import type postgres from 'postgres';

type Db = postgres.Sql | Tx;

const same = <T>(value: T) => value;

export type TaskRow = {
  id: string;
  owner_sub: string;
  owner_email: string | null;
  client_request_id: string;
  title: string;
  objective: string;
  status: TeamworkStatus;
  version: number;
  llm_mode: 'vertex' | 'stub';
  model_id: string;
  error_code: string | null;
  error_message: string | null;
  segment: string;
  workflow: Workflow;
  mode: 'manual' | 'coordinated';
  result_owner: string;
  conversation_id: string | null;
  scope: TaskScope;
  latest_revision: number;
  revision_request: string | null;
  failed_stage: 'planning' | 'synthesis' | 'publish' | null;
  created_at: Date;
  updated_at: Date;
};

export type AssignmentRow = {
  id: string;
  task_id: string;
  key: string;
  teammate_id: string;
  teammate_snapshot: { name: string; role: string; instructions: string; version: number };
  skills: { id: string; version: number; name: string; definition: SkillDefinition }[];
  brief: string;
  deliverable: string;
  sources: SourceKind[];
  capabilities: string[];
  plan_version: number | null;
  status: AssignmentStatus;
  attempt: number;
  question: string | null;
  answer: string | null;
  output: Contribution | null;
  calculations: Calculation[];
  depends_on: string[];
  model: { modelVersion: string; responseId: string | null; latencyMs: number } | null;
  error_code: string | null;
  error_message: string | null;
  deadline_at: Date;
  started_at: Date | null;
  finished_at: Date | null;
  created_at: Date;
};

export type EventInput = {
  readonly type: string;
  readonly summary: string;
  readonly detail?: Readonly<Record<string, string | number | boolean | null>>;
  readonly durationMs?: number;
};

/** An owner of undefined reads across members (worker side); `lock` takes the row lock in a transaction. */
export async function readTask(
  db: Db,
  ownerSub: string | undefined,
  id: string,
  options: { readonly lock?: boolean } = {},
): Promise<TaskRow | undefined> {
  const rows = await db<TaskRow[]>`
    select * from wb_tasks where id = ${id} and kind = 'teamwork'
    ${ownerSub === undefined ? db`` : db`and owner_sub = ${ownerSub}`}
    ${options.lock === true ? db`for update` : db``}
  `;
  return rows.at(0);
}

/** Runs `run` with the task row locked in one transaction; undefined means no such task. */
export async function withTask<T>(
  deps: Deps,
  ownerSub: string | undefined,
  id: string,
  run: (tx: Tx, task: TaskRow) => Promise<T>,
): Promise<T | undefined> {
  // Wrapped so a callback returning an array is never mistaken for a query pipeline by postgres.js.
  const result = await deps.sql.begin(async (tx) => {
    const task = await readTask(tx, ownerSub, id, { lock: true });
    return { value: task === undefined ? undefined : await run(tx, task) };
  });
  return result.value;
}

export async function appendEvent(
  deps: Deps,
  tx: Tx,
  taskId: string,
  event: EventInput,
): Promise<void> {
  await tx`
    insert into wb_events (task_id, seq, type, summary, detail, duration_ms, at)
    select ${taskId}, coalesce(max(seq), 0) + 1, ${event.type}, ${event.summary},
           ${tx.json(event.detail ?? {})}, ${event.durationMs ?? null}, ${deps.now()}
    from wb_events where task_id = ${taskId}
  `;
}

/** An omitted field keeps the column; null clears it; anything else is encoded into it. */
function column<T, R>(
  value: T | null | undefined,
  keep: postgres.Fragment,
  encode: (value: T) => R,
): postgres.Fragment | R | null {
  if (value === undefined) return keep;
  return value === null ? null : encode(value);
}

type TaskError = {
  readonly code: string;
  readonly message: string;
  readonly stage?: TaskRow['failed_stage'];
};

export type TaskPatch = {
  readonly status?: TeamworkStatus;
  /** undefined keeps the stored error, null clears it. */
  readonly error?: TaskError | null;
  readonly revision_request?: string | null;
  readonly scope?: TaskScope;
  readonly latest_revision?: number;
};

/**
 * The one writer of a task row: applies the patch, bumps the version pollers watch, and re-derives
 * the inbox. `from` makes the write conditional on the status the caller read. False means the
 * row was not written.
 */
export async function touchTask(
  deps: Deps,
  tx: Tx,
  taskId: string,
  patch: TaskPatch = {},
  from?: TeamworkStatus,
): Promise<boolean> {
  const rows = await tx`
    update wb_tasks set version = version + 1, updated_at = ${deps.now()},
      status = ${column(patch.status, tx`status`, same)},
      error_code = ${column(patch.error, tx`error_code`, (error) => error.code)},
      error_message = ${column(patch.error, tx`error_message`, (error) => error.message)},
      failed_stage = ${column(patch.error, tx`failed_stage`, (error) => error.stage ?? null)},
      revision_request = ${column(patch.revision_request, tx`revision_request`, same)},
      scope = ${column(patch.scope, tx`scope`, (scope) => tx.json(scope))},
      latest_revision = ${column(patch.latest_revision, tx`latest_revision`, same)}
    where id = ${taskId} ${from === undefined ? tx`` : tx`and status = ${from}`}
    returning id
  `;
  if (rows.length === 0) return false;
  await syncInbox(deps, tx, taskId);
  return true;
}

export type Move = {
  readonly to: TeamworkStatus;
  readonly events: readonly EventInput[];
  readonly error?: TaskPatch['error'];
  readonly patch?: Omit<TaskPatch, 'status' | 'error'>;
};

/** Moves a locked task along an allowed edge and records events. */
export async function moveTask(deps: Deps, tx: Tx, task: TaskRow, change: Move): Promise<boolean> {
  if (!canTeamworkTransition(task.status, change.to)) return false;
  const patch = { ...change.patch, status: change.to, error: change.error };
  if (!(await touchTask(deps, tx, task.id, patch, task.status))) return false;
  for (const event of change.events) await appendEvent(deps, tx, task.id, event);
  return true;
}

type AssignmentFields = {
  readonly question?: string | null;
  readonly answer?: string | null;
  readonly output?: Contribution | null;
  readonly calculations?: readonly Calculation[];
  readonly model?: AssignmentRow['model'];
  readonly error?: { readonly code: string; readonly message: string } | null;
  readonly attemptIncrement?: boolean;
};

/** Whether entering the status stops the assignment's clock; a question pauses it like an end. */
const stopsWork = (status: AssignmentStatus): boolean =>
  TERMINAL_ASSIGNMENT.has(status) || status === 'needs_input';

/**
 * Moves an assignment along an allowed edge. Its deadline starts when it starts running, so waiting
 * for a dependency or a free worker never counts against it. Undefined means it was not moved.
 */
export async function moveAssignment(
  deps: Deps,
  tx: Tx,
  assignment: Pick<AssignmentRow, 'id' | 'status'>,
  to: AssignmentStatus,
  fields: AssignmentFields = {},
): Promise<AssignmentRow | undefined> {
  if (!canAssignmentTransition(assignment.status, to)) return undefined;
  const at = deps.now();
  const rows = await tx<AssignmentRow[]>`
    update tw_assignments set status = ${to}, updated_at = ${at},
      attempt = attempt + ${fields.attemptIncrement === true ? 1 : 0},
      question = ${column(fields.question, tx`question`, same)},
      answer = ${column(fields.answer, tx`answer`, same)},
      output = ${column(fields.output, tx`output`, (output) => tx.json(output))},
      calculations = ${column(fields.calculations, tx`calculations`, (list) => tx.json([...list]))},
      model = ${column(fields.model, tx`model`, (model) => tx.json(model))},
      error_code = ${column(fields.error, tx`error_code`, (error) => error.code)},
      error_message = ${column(fields.error, tx`error_message`, (error) => error.message)},
      started_at = ${to === 'running' ? at : tx`started_at`},
      finished_at = ${stopsWork(to) ? at : to === 'queued' ? null : tx`finished_at`},
      deadline_at = ${to === 'running' ? new Date(at.getTime() + deps.config.assignmentDeadlineMs) : tx`deadline_at`}
    where id = ${assignment.id} and status = ${assignment.status}
    returning *
  `;
  const moved = rows.at(0);
  // Every assignment change is a task change for pollers, so views refresh without guessing.
  if (moved !== undefined) await touchTask(deps, tx, moved.task_id);
  return moved;
}

/**
 * Moves an assignment to a new queued attempt. Its job is queued by `releaseReady`, which the
 * caller runs once after all of its changes. Undefined means the assignment was not movable.
 */
export async function requeue(
  deps: Deps,
  tx: Tx,
  assignment: Pick<AssignmentRow, 'id' | 'status'>,
  fields: Omit<AssignmentFields, 'attemptIncrement'> = {},
): Promise<AssignmentRow | undefined> {
  return moveAssignment(deps, tx, assignment, 'queued', {
    ...fields,
    attemptIncrement: true,
    error: fields.error ?? null,
  });
}

/**
 * Queues the job of every queued assignment whose dependencies all succeeded, so an approved plan
 * runs in the order it was reviewed. Every path that queues work ends here; `enqueue` ignores a
 * job that is already open.
 */
export async function releaseReady(deps: Deps, tx: Tx, taskId: string): Promise<void> {
  const rows = await assignmentsFor(tx, taskId);
  const succeeded = new Set(rows.filter((a) => a.status === 'succeeded').map((a) => a.key));
  for (const a of rows)
    if (a.status === 'queued' && a.depends_on.every((key) => succeeded.has(key)))
      await enqueue(deps, tx, taskId, 'assignment', `${a.id}:${a.attempt}`);
}

export async function enqueue(
  deps: Deps,
  tx: Tx,
  taskId: string | null,
  kind: 'plan' | 'assignment' | 'synthesis' | 'publish' | 'reply',
  ref: string,
): Promise<void> {
  await tx`
    insert into tw_jobs (task_id, kind, ref, state, created_at, updated_at)
    values (${taskId}, ${kind}, ${ref}, 'queued', ${deps.now()}, ${deps.now()})
    on conflict (kind, ref) where state in ('queued', 'running') do nothing
  `;
}

export async function cancelJobs(deps: Deps, tx: Tx, taskId: string): Promise<void> {
  await tx`update tw_jobs set state = 'cancelled', updated_at = ${deps.now()} where task_id = ${taskId} and state = 'queued'`;
}

export async function assignmentsFor(db: Db, taskId: string): Promise<AssignmentRow[]> {
  return db<
    AssignmentRow[]
  >`select * from tw_assignments where task_id = ${taskId} order by created_at, key`;
}

export async function latestPlanVersion(db: Db, taskId: string): Promise<number> {
  const rows = await db<
    { v: number }[]
  >`select coalesce(max(version), 0)::int as v from tw_plans where task_id = ${taskId}`;
  return rows.at(0)?.v ?? 0;
}

/** Retires the one live plan (the `tw_plans_live` predicate), so a new version can be proposed. */
export async function supersedeLivePlan(tx: Tx, taskId: string): Promise<void> {
  await tx`update tw_plans set state = 'superseded' where task_id = ${taskId} and state in ('proposed', 'approved')`;
}

/** Re-derives the task's open inbox items from its current state, in the caller's transaction. */
export async function syncInbox(deps: Deps, tx: Tx, taskId: string): Promise<void> {
  const task = (
    await tx<
      Pick<TaskRow, 'owner_sub' | 'status' | 'version' | 'latest_revision'>[]
    >`select owner_sub, status, version, latest_revision from wb_tasks where id = ${taskId}`
  ).at(0);
  if (task === undefined) return;
  const [assignments, planVersion, approvals] = await Promise.all([
    tx<Pick<AssignmentRow, 'id' | 'key' | 'status' | 'attempt' | 'question'>[]>`
      select id, key, status, attempt, question from tw_assignments
      where task_id = ${taskId} and status <> 'superseded' order by created_at, key
    `,
    latestPlanVersion(tx, taskId),
    tx<{ id: string; state: string; status: string | null }[]>`
      select ap.id, ap.state, ac.status from wb_approvals ap left join wb_actions ac on ac.approval_id = ap.id
      where ap.task_id = ${taskId} and ap.subject = 'publish' order by ap.requested_at desc
    `,
  ]);
  const desired = desiredInbox({
    status: task.status,
    planVersion: planVersion === 0 ? null : planVersion,
    latestRevision: task.latest_revision,
    version: task.version,
    assignments,
    pendingApproval: approvals.find((a) => a.state === 'pending') ?? null,
    publishedApproval: approvals.find((a) => a.status === 'succeeded') ?? null,
  });
  const at = deps.now();
  for (const item of desired)
    await tx`
      insert into tw_inbox (id, owner_sub, task_id, kind, ref, summary, state, created_at)
      values (${deps.newId()}, ${task.owner_sub}, ${taskId}, ${item.kind}, ${item.ref}, ${item.summary}, 'open', ${at})
      on conflict (task_id, ref) do nothing
    `;
  const refs = desired.map((item) => item.ref);
  await tx`
    update tw_inbox set state = 'resolved', resolved_at = ${at}
    where task_id = ${taskId} and state = 'open' and not (ref = any(${refs}::text[]))
  `;
}

type EvidenceRow = {
  id: string;
  assignment_id: string | null;
  source_kind: SourceKind;
  source_id: string;
  title: string;
  location: string | null;
  excerpt: string;
  url: string | null;
  source_revision: string | null;
  modified_at: Date | null;
  retrieved_at: Date;
  stale: boolean;
  provenance: string;
};

export async function evidenceFor(db: Db, taskId: string): Promise<EvidenceView[]> {
  const rows = await db<EvidenceRow[]>`
    select * from wb_evidence where task_id = ${taskId} and attempt = 1 order by ordinal
  `;
  return rows.map((row) => ({
    id: row.id,
    assignmentId: row.assignment_id,
    sourceKind: row.source_kind,
    sourceId: row.source_id,
    title: row.title,
    location: row.location ?? '',
    excerpt: row.excerpt,
    url: row.url,
    sourceRevision: row.source_revision,
    modifiedAt: row.modified_at?.toISOString() ?? null,
    retrievedAt: row.retrieved_at.toISOString(),
    stale: row.stale,
    provenance: row.provenance,
  }));
}

/** Calculations from the task's current data contributions; superseded attempts are excluded. */
export async function calculationsFor(db: Db, taskId: string): Promise<Calculation[]> {
  const rows = await db<{ calculations: Calculation[] }[]>`
    select calculations from tw_assignments
    where task_id = ${taskId} and status not in ('superseded', 'cancelled') order by created_at
  `;
  return rows.flatMap((row) => row.calculations);
}

export async function postMessage(
  deps: Deps,
  tx: Tx,
  message: {
    readonly conversationId: string;
    readonly ownerSub: string;
    readonly role: 'member' | 'teammate' | 'system';
    readonly body: string;
    readonly taskId?: string | null;
    readonly card?: {
      readonly kind: string;
      readonly taskId: string;
      readonly title: string;
    } | null;
    readonly clientRequestId?: string | null;
    readonly replyState?: 'pending' | 'done' | 'failed' | null;
  },
): Promise<string> {
  const id = deps.newId();
  await tx`
    insert into tw_messages (id, conversation_id, owner_sub, client_request_id, role, body, task_id, card, reply_state, created_at)
    values (${id}, ${message.conversationId}, ${message.ownerSub}, ${message.clientRequestId ?? null}, ${message.role},
      ${message.body}, ${message.taskId ?? null}, ${message.card === undefined || message.card === null ? null : tx.json(message.card)},
      ${message.replyState ?? null}, ${deps.now()})
  `;
  return id;
}
