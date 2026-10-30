import { canonicalPayloadSha256 } from '@agent-works/domain';
import {
  TASK_LIST_STATUS_FILTER,
  TEAMWORK_API_VERSION,
  decodeCursor,
  encodeCursor,
  publishProposalSchema,
} from '@agent-works/domain/teamwork';
import { artifactMarkdown } from '@agent-works/domain/teamwork-evidence';
import {
  capabilitiesForSources,
  deniedSources,
  effectiveSet,
  hasDependencyCycle,
  repositoryAllowed,
} from '@agent-works/domain/teamwork-policy';

import { resolveAttachments } from './attachments.js';
import { capabilitiesFor, teammateSkills } from './catalog.js';
import { connectedProviders, connections } from './connections.js';
import { Conflict, audit } from './context.js';
import { WORKFLOW_SOURCES } from './prompts.js';
import {
  appendEvent,
  assignmentsFor,
  cancelJobs,
  conversationFor,
  enqueue,
  evidenceFor,
  latestPlanVersion,
  moveAssignment,
  moveTask,
  postMessage,
  readTask,
  releaseReady,
  requeue,
  supersedeLivePlan,
  syncInbox,
  touchTask,
  withTask,
} from './store.js';

import type { Provider } from './connections.js';
import type { Deps, Member, Tx } from './context.js';
import type { AssignmentRow, TaskRow } from './store.js';
import type {
  ActionApprovalView,
  ArtifactContent,
  Capability,
  Cursor,
  InboxItem,
  InboxListQuery,
  MetricsScope,
  PlanContent,
  PlanView,
  PublishProposal,
  ResultEntry,
  ResultListQuery,
  RevisionView,
  SkillDefinition,
  SourceKind,
  TaskCreate,
  TaskDetail,
  TaskListQuery,
  TaskScope,
  TaskSummary,
  Workflow,
} from '@agent-works/domain/teamwork';
import type postgres from 'postgres';

const DOCS_PUBLISH: Capability = 'docs.publish';
const APPROVAL_TTL_MS = 60 * 60 * 1000;

export function summary(row: TaskRow): TaskSummary {
  return {
    id: row.id,
    title: row.title,
    workflow: row.workflow,
    mode: row.mode,
    status: row.status,
    version: row.version,
    resultOwner: row.result_owner,
    conversationId: row.conversation_id,
    latestRevision: row.latest_revision,
    errorCode: row.error_code,
    errorMessage: row.error_message,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

function titleFor(question: string): string {
  const first = question.split(/(?<=[.!?])\s|\n/)[0]?.trim() ?? question.trim();
  return first.length > 160 ? `${first.slice(0, 157).trimEnd()}...` : first;
}

/** The synthesis skill a result owner uses for a workflow: attached, multi-section, matching. */
export function synthesisSkill(
  skills: readonly { readonly definition: SkillDefinition }[],
  workflow: Workflow,
): SkillDefinition | undefined {
  return skills
    .map((skill) => skill.definition)
    .find((skill) => skill.workflows.includes(workflow) && skill.outputSections.length > 1);
}

/** Fills workflow defaults from segment configuration and checks every required input is present. */
function normalizeScope(deps: Deps, workflow: Workflow, scope: TaskScope): TaskScope {
  if (workflow === 'metrics_explanation') {
    if (scope.metrics === null) throw new Conflict('metrics_scope_required', 400);
    if (scope.metrics.baseline === scope.metrics.current)
      throw new Conflict('metrics_periods_equal', 400);
    return { ...scope, repository: null, issueNumber: null };
  }
  if (workflow === 'engineering_proposal') {
    const repository = scope.repository ?? deps.config.sources.githubRepositories.at(0) ?? null;
    const issueNumber = scope.issueNumber ?? deps.config.sources.githubIssue ?? null;
    if (repository === null) throw new Conflict('repository_required', 400);
    // Segment policy, checked before any assignment exists or any provider is called.
    if (!repositoryAllowed(repository, deps.config.sources.githubRepositories))
      throw new Conflict('repository_not_allowed', 403);
    if (issueNumber === null) throw new Conflict('issue_required', 400);
    return { ...scope, metrics: null, repository, issueNumber };
  }
  return { ...scope, metrics: null, repository: null, issueNumber: null };
}

type TeammateLite = {
  id: string;
  name: string;
  role: string;
  instructions: string;
  version: number;
  capability_requests: Capability[];
};

async function ownedTeammates(
  db: postgres.Sql | Tx,
  ownerSub: string,
  ids: readonly string[],
): Promise<Map<string, TeammateLite>> {
  const rows = await db<TeammateLite[]>`
    select id, name, role, instructions, version, capability_requests from tw_teammates
    where owner_sub = ${ownerSub} and not archived and id = any(${ids as string[]}::uuid[])
  `;
  return new Map(rows.map((row) => [row.id, row]));
}

type PlannedWork = {
  readonly key: string;
  readonly teammateId: string;
  readonly brief: string;
  readonly deliverable: string;
  readonly sources: readonly SourceKind[];
  readonly dependsOn?: readonly string[];
};

/**
 * Snapshots each teammate and its skills at dispatch and computes the assignment's capabilities
 * as the effective set narrowed to the sources it was given. Later edits never change this work.
 */
type Dispatch = {
  readonly task: TaskRow;
  readonly member: Member;
  readonly work: readonly PlannedWork[];
  readonly planVersion: number | null;
};

async function dispatch(
  deps: Deps,
  tx: Tx,
  { task, member, work, planVersion }: Dispatch,
): Promise<void> {
  const teammates = await ownedTeammates(
    tx,
    task.owner_sub,
    work.map((item) => item.teammateId),
  );
  const skills = await teammateSkills(tx, [...teammates.keys()]);
  const connected = await connectedProviders(deps, member.sub);
  const at = deps.now();
  // Files the member attached are task inputs: every assignment reads them, whatever else it reads.
  const withFiles = (task.scope.attachmentIds ?? []).length > 0;
  for (const item of work) {
    const teammate = teammates.get(item.teammateId);
    if (teammate === undefined) throw new Conflict('teammate_not_found', 400);
    const sources: readonly SourceKind[] =
      withFiles && !item.sources.includes('member_file')
        ? [...item.sources, 'member_file']
        : item.sources;
    const states = await capabilitiesFor(
      deps,
      member,
      teammate.capability_requests,
      capabilitiesForSources(sources),
      connected,
    );
    const id = deps.newId();
    await tx`
      insert into tw_assignments (id, task_id, key, teammate_id, teammate_snapshot, skills, brief, deliverable,
        sources, capabilities, plan_version, status, deadline_at, created_at, updated_at, depends_on)
      values (${id}, ${task.id}, ${item.key}, ${teammate.id},
        ${tx.json({ name: teammate.name, role: teammate.role, instructions: teammate.instructions, version: teammate.version })},
        ${tx.json((skills.get(teammate.id) ?? []).map((s) => ({ id: s.id, version: s.version, name: s.name, definition: s.definition })))},
        ${item.brief}, ${item.deliverable}, ${tx.json([...sources])}, ${tx.json([...effectiveSet(states)])},
        ${planVersion}, 'queued', ${new Date(at.getTime() + deps.config.assignmentDeadlineMs)}, ${at}, ${at},
        ${tx.json([...(item.dependsOn ?? [])])})
    `;
    await appendEvent(deps, tx, task.id, {
      type: 'assignment.queued',
      summary: `Assigned ${teammate.name}: ${item.key}`,
      detail: {
        assignmentId: id,
        teammate: teammate.name,
        planVersion,
        sources: sources.join(','),
      },
    });
  }
  await releaseReady(deps, tx, task.id);
}

function checkCreateInput(input: TaskCreate): void {
  const allowed = new Set(WORKFLOW_SOURCES[input.workflow]);
  if (input.mode === 'manual') {
    if (input.assignments.length === 0) throw new Conflict('assignments_required', 400);
    if (input.assignments.some((a) => a.sources.some((source) => !allowed.has(source))))
      throw new Conflict('source_not_allowed', 400);
  } else if (input.assignments.length > 0)
    throw new Conflict('coordinated_has_no_assignments', 400);
}

/** Resolves the result owner and checks it can synthesize; the conversation, when given, must be the member's. */
async function checkOwner(
  tx: Tx,
  member: Member,
  input: TaskCreate,
): Promise<Map<string, TeammateLite>> {
  const owners = await ownedTeammates(tx, member.sub, [
    input.resultOwner,
    ...input.assignments.map((a) => a.teammateId),
  ]);
  if (!owners.has(input.resultOwner)) throw new Conflict('teammate_not_found', 400);
  const ownerSkills = (await teammateSkills(tx, [input.resultOwner])).get(input.resultOwner) ?? [];
  if (synthesisSkill(ownerSkills, input.workflow) === undefined)
    throw new Conflict('no_synthesis_skill', 400);
  if (input.conversationId !== null) {
    const conversation =
      await tx`select 1 from tw_conversations where id = ${input.conversationId} and owner_sub = ${member.sub}`;
    if (conversation.length === 0) throw new Conflict('conversation_not_found', 400);
  }
  return owners;
}

/** Refuses a manual assignment before it starts when its teammate cannot use a chosen source. */
async function checkSourcesUsable(
  deps: Deps,
  member: Member,
  input: TaskCreate,
  owners: ReadonlyMap<string, TeammateLite>,
): Promise<void> {
  const connected = await connectedProviders(deps, member.sub);
  for (const assignment of input.assignments) {
    const teammate = owners.get(assignment.teammateId);
    if (teammate === undefined) throw new Conflict('teammate_not_found', 400);
    const states = await capabilitiesFor(
      deps,
      member,
      teammate.capability_requests,
      undefined,
      connected,
    );
    if (deniedSources(assignment.sources, states).length > 0)
      throw new Conflict('source_unavailable_for_teammate', 400);
  }
}

const slug = (name: string): string =>
  name
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 24) || 'part';

function createdSummary(input: TaskCreate): string {
  if (input.mode !== 'manual') return 'Task created; the coordinator will propose a plan';
  return `Started with ${input.assignments.length} assignment${input.assignments.length === 1 ? '' : 's'}`;
}

function manualWork(
  input: TaskCreate,
  owners: ReadonlyMap<string, TeammateLite>,
): readonly PlannedWork[] {
  return input.assignments.map((a, index) => ({
    key: `${slug(owners.get(a.teammateId)?.name ?? 'part')}-${index + 1}`,
    teammateId: a.teammateId,
    brief: a.brief,
    deliverable: 'A cited contribution for the combined result',
    sources: a.sources,
  }));
}

export async function createTask(
  deps: Deps,
  member: Member,
  input: TaskCreate,
): Promise<{ task: TaskSummary; created: boolean }> {
  const scope = normalizeScope(deps, input.workflow, input.scope);
  checkCreateInput(input);
  return deps.sql.begin(async (tx) => {
    // Serializes concurrent submits of one form, so a double click returns the same task.
    await tx`select pg_advisory_xact_lock(hashtext(${`${member.sub}:${input.clientRequestId}`}))`;
    const prior = await tx<TaskRow[]>`
      select * from wb_tasks where owner_sub = ${member.sub} and client_request_id = ${input.clientRequestId}
    `;
    if (prior.length > 0) {
      const row = prior[0];
      if (row.objective !== scope.question) throw new Conflict('client_request_reused');
      return { task: summary(row), created: false };
    }
    const owners = await checkOwner(tx, member, input);
    await checkSourcesUsable(deps, member, input, owners);
    await resolveAttachments(tx, member, input.conversationId, scope.attachmentIds ?? []);
    const id = deps.newId();
    const at = deps.now();
    const status = input.mode === 'manual' ? 'running' : 'planning';
    const inserted = await tx<TaskRow[]>`
      insert into wb_tasks (id, owner_sub, owner_email, client_request_id, title, objective, status, version,
        llm_mode, model_id, created_at, updated_at, kind, segment, workflow, mode, result_owner, conversation_id, scope)
      values (${id}, ${member.sub}, ${member.email}, ${input.clientRequestId}, ${titleFor(scope.question)}, ${scope.question},
        ${status}, 1, ${deps.gate.mode}, ${deps.gate.modelId}, ${at}, ${at}, 'teamwork', ${deps.config.segment}, ${input.workflow},
        ${input.mode}, ${input.resultOwner}, ${input.conversationId}, ${tx.json(scope)})
      returning *
    `;
    const task = inserted[0];
    await appendEvent(deps, tx, id, {
      type: 'task.created',
      summary: createdSummary(input),
      detail: { workflow: input.workflow, mode: input.mode, segment: deps.config.segment },
    });
    if (input.mode === 'manual')
      await dispatch(deps, tx, {
        task,
        member,
        work: manualWork(input, owners),
        planVersion: null,
      });
    else await enqueue(deps, tx, id, 'plan', `${id}:1`);
    if (input.conversationId !== null)
      await postMessage(deps, tx, {
        conversationId: input.conversationId,
        ownerSub: member.sub,
        role: 'system',
        body: `Task started: ${task.title}`,
        taskId: id,
        card: { kind: 'task_created', taskId: id, title: task.title },
      });
    await syncInbox(deps, tx, id);
    await audit(deps, tx, {
      ownerSub: member.sub,
      taskId: id,
      action: 'task.create',
      outcome: 'created',
      detail: { workflow: input.workflow, mode: input.mode },
    });
    return { task: summary(task), created: true };
  });
}

export type Page<T> = { readonly items: readonly T[]; readonly nextCursor: string | null };

/** The cursor a query carries, or undefined when it has none; a foreign cursor is a bad request. */
function cursorOf(raw: string | undefined): Cursor | undefined {
  if (raw === undefined) return undefined;
  const cursor = decodeCursor(raw);
  if (cursor === undefined) throw new Conflict('invalid_cursor', 400);
  return cursor;
}

/** `limit + 1` rows tell whether a next page exists without a count query. */
function page<R, T>(
  rows: readonly R[],
  limit: number,
  view: (row: R) => T,
  cursor: (row: R) => Cursor,
): Page<T> {
  const held = rows.slice(0, limit);
  const last = held.at(-1);
  return {
    items: held.map(view),
    nextCursor: rows.length > limit && last !== undefined ? encodeCursor(cursor(last)) : null,
  };
}

/** A case-insensitive substring pattern with the member's wildcards escaped. */
const likePattern = (q: string): string => `%${q.replaceAll(/[\\%_]/g, (c) => `\\${c}`)}%`;

const rowCursor = (row: { updated_at: Date; id: string }): Cursor => ({
  at: row.updated_at.toISOString(),
  id: row.id,
});

/** Newest first by (updated_at, id). Timestamps are written at millisecond precision, so the cursor loses nothing. */
export async function listTasks(
  deps: Deps,
  member: Member,
  query: TaskListQuery,
): Promise<Page<TaskSummary>> {
  const sql = deps.sql;
  const cursor = cursorOf(query.cursor);
  const statuses =
    query.status === 'all' || query.status === 'attention'
      ? undefined
      : [...TASK_LIST_STATUS_FILTER[query.status]];
  const rows = await sql<TaskRow[]>`
    select t.* from wb_tasks t where t.kind = 'teamwork' and t.owner_sub = ${member.sub}
    ${statuses === undefined ? sql`` : sql`and t.status = any(${statuses}::text[])`}
    ${query.status === 'attention' ? sql`and exists (select 1 from tw_inbox i where i.task_id = t.id and i.state = 'open')` : sql``}
    ${query.q === '' ? sql`` : sql`and (t.title ilike ${likePattern(query.q)} or t.objective ilike ${likePattern(query.q)})`}
    ${cursor === undefined ? sql`` : sql`and (t.updated_at, t.id) < (${cursor.at}::timestamptz, ${cursor.id}::uuid)`}
    order by t.updated_at desc, t.id desc limit ${query.limit + 1}
  `;
  return page(rows, query.limit, summary, rowCursor);
}

type ResultRow = {
  task_id: string;
  task_title: string;
  revision: number;
  latest_revision: number;
  title: string;
  owner_id: string;
  owner_name: string | null;
  conversation_id: string | null;
  created_at: Date;
};

/** Every artifact revision of the member's tasks, newest first; `q` matches task and artifact titles. */
export async function listResults(
  deps: Deps,
  member: Member,
  query: ResultListQuery,
): Promise<Page<ResultEntry>> {
  const sql = deps.sql;
  const raw = cursorOf(query.cursor);
  // The results cursor id is `<taskId>:<revision>`, the rest of the sort key after created_at.
  const cursor =
    raw === undefined
      ? undefined
      : { at: raw.at, taskId: raw.id.split(':')[0], revision: Number(raw.id.split(':')[1]) };
  const rows = await sql<ResultRow[]>`
    select r.task_id, t.title as task_title, r.revision, t.latest_revision, r.content->>'title' as title,
      t.result_owner as owner_id, tm.name as owner_name, t.conversation_id, r.created_at
    from tw_revisions r
    join wb_tasks t on t.id = r.task_id and t.kind = 'teamwork' and t.owner_sub = ${member.sub}
    left join tw_teammates tm on tm.id = t.result_owner
    where true
    ${query.q === '' ? sql`` : sql`and (t.title ilike ${likePattern(query.q)} or r.content->>'title' ilike ${likePattern(query.q)})`}
    ${
      cursor === undefined
        ? sql``
        : sql`and (r.created_at < ${cursor.at}::timestamptz or (r.created_at = ${cursor.at}::timestamptz
            and (r.task_id, r.revision) > (${cursor.taskId}::uuid, ${cursor.revision})))`
    }
    order by r.created_at desc, r.task_id, r.revision limit ${query.limit + 1}
  `;
  return page(
    rows,
    query.limit,
    (row): ResultEntry => ({
      taskId: row.task_id,
      taskTitle: row.task_title,
      revision: row.revision,
      latestRevision: row.latest_revision,
      title: row.title,
      producedBy: { id: row.owner_id, name: row.owner_name ?? 'Teammate' },
      conversationId: row.conversation_id,
      createdAt: row.created_at.toISOString(),
    }),
    (row) => ({ at: row.created_at.toISOString(), id: `${row.task_id}:${row.revision}` }),
  );
}

type PlanRow = {
  version: number;
  author: PlanView['author'];
  content: PlanContent;
  capabilities: Capability[];
  digest: string;
  state: PlanView['state'];
  created_at: Date;
  decided_at: Date | null;
};
type RevisionRow = {
  revision: number;
  parent: number | null;
  request: string | null;
  content: ArtifactContent;
  evidence_ids: string[];
  calculations: RevisionView['calculations'];
  unsupported: number;
  dropped_citations: number;
  missing_assignments: string[];
  generation: RevisionView['generation'];
  diff: RevisionView['diff'];
  digest: string;
  created_at: Date;
};
type ApprovalRow = {
  id: string;
  state: ActionApprovalView['state'];
  proposal: unknown;
  payload_sha256: string;
  requested_at: Date;
  expires_at: Date;
  decided_at: Date | null;
  subject_ref: number | null;
  action_status: NonNullable<ActionApprovalView['action']>['status'] | null;
  attempts: number | null;
  external_id: string | null;
  external_url: string | null;
  confirmed_at: Date | null;
};

function assignmentView(row: AssignmentRow): TaskDetail['assignments'][number] {
  return {
    id: row.id,
    key: row.key,
    teammateId: row.teammate_id,
    teammateName: row.teammate_snapshot.name,
    skills: row.skills.map(({ id, version, name }) => ({ id, version, name })),
    brief: row.brief,
    deliverable: row.deliverable,
    sources: row.sources,
    status: row.status,
    attempt: row.attempt,
    planVersion: row.plan_version,
    question: row.question,
    errorCode: row.error_code,
    errorMessage: row.error_message,
    startedAt: row.started_at?.toISOString() ?? null,
    finishedAt: row.finished_at?.toISOString() ?? null,
    deadlineAt: row.deadline_at.toISOString(),
    output: row.output,
    model: row.model,
  };
}

export async function taskDetail(
  deps: Deps,
  member: Member,
  id: string,
): Promise<TaskDetail | undefined> {
  const row = await readTask(deps.sql, member.sub, id);
  if (row === undefined) return undefined;
  const [plans, assignments, evidence, revisions, approvals, messages, events] = await Promise.all([
    deps.sql<PlanRow[]>`select * from tw_plans where task_id = ${id} order by version`,
    assignmentsFor(deps.sql, id),
    evidenceFor(deps.sql, id),
    deps.sql<RevisionRow[]>`select * from tw_revisions where task_id = ${id} order by revision`,
    deps.sql<ApprovalRow[]>`
      select ap.id, ap.state, ap.proposal, ap.payload_sha256, ap.requested_at, ap.expires_at, ap.decided_at, ap.subject_ref,
        ac.status as action_status, ac.attempts, ac.external_id, ac.external_url, ac.confirmed_at
      from wb_approvals ap left join wb_actions ac on ac.approval_id = ap.id
      where ap.task_id = ${id} and ap.subject = 'publish' order by ap.requested_at
    `,
    deps.sql<
      {
        id: string;
        role: 'member' | 'teammate' | 'system';
        body: string;
        task_id: string | null;
        card: TaskDetail['messages'][number]['card'];
        reply_state: string | null;
        created_at: Date;
      }[]
    >`
      select id, role, body, task_id, card, reply_state, created_at from tw_messages where task_id = ${id} and owner_sub = ${member.sub} order by created_at
    `,
    deps.sql<
      {
        seq: number;
        type: string;
        summary: string;
        at: Date;
        duration_ms: number | null;
        detail: Record<string, string | number | boolean | null>;
      }[]
    >`
      select seq, type, summary, at, duration_ms, detail from wb_events where task_id = ${id} order by seq
    `,
  ]);
  return {
    apiVersion: TEAMWORK_API_VERSION,
    segment: deps.config.segment,
    task: summary(row),
    scope: row.scope,
    plans: plans.map((plan) => ({
      version: plan.version,
      state: plan.state,
      author: plan.author,
      content: plan.content,
      capabilities: plan.capabilities,
      digest: plan.digest,
      createdAt: plan.created_at.toISOString(),
      decidedAt: plan.decided_at?.toISOString() ?? null,
    })),
    assignments: assignments.map(assignmentView),
    evidence,
    revisions: revisions.map((rev) => ({
      revision: rev.revision,
      parent: rev.parent,
      request: rev.request,
      content: rev.content,
      evidenceIds: rev.evidence_ids,
      calculations: rev.calculations,
      unsupported: rev.unsupported,
      droppedCitations: rev.dropped_citations,
      missingAssignments: rev.missing_assignments,
      generation: rev.generation,
      diff: rev.diff,
      digest: rev.digest,
      createdAt: rev.created_at.toISOString(),
    })),
    approvals: approvals.map((ap) => ({
      id: ap.id,
      state: ap.state,
      proposal: publishProposalSchema.parse(ap.proposal),
      digest: ap.payload_sha256,
      requestedAt: ap.requested_at.toISOString(),
      expiresAt: ap.expires_at.toISOString(),
      decidedAt: ap.decided_at?.toISOString() ?? null,
      action:
        ap.action_status === null
          ? null
          : {
              status: ap.action_status,
              attempts: ap.attempts ?? 0,
              externalId: ap.external_id,
              externalUrl: ap.external_url,
              confirmedAt: ap.confirmed_at?.toISOString() ?? null,
            },
    })),
    messages: messages.map((m) => ({
      id: m.id,
      role: m.role,
      text: m.body,
      taskId: m.task_id,
      card: m.card,
      pending: m.reply_state === 'pending',
      at: m.created_at.toISOString(),
    })),
    events: events.map((e) => ({
      seq: e.seq,
      type: e.type,
      summary: e.summary,
      at: e.at.toISOString(),
      durationMs: e.duration_ms,
      detail: e.detail,
    })),
  };
}

/**
 * Runs a member command against the locked task and answers with the task as the command left
 * it. A returned code is a refusal raised after the commit, so the refusal's own writes persist.
 */
async function locked(
  deps: Deps,
  member: Member,
  id: string,
  run: (tx: Tx, task: TaskRow) => Promise<string | void>,
): Promise<TaskSummary> {
  const outcome = await withTask(deps, member.sub, id, async (tx, task) => {
    const refusal = await run(tx, task);
    return { refusal, task: await readTask(tx, member.sub, id) };
  });
  if (outcome?.task === undefined) throw new Conflict('not_found', 404);
  if (typeof outcome.refusal === 'string') throw new Conflict(outcome.refusal);
  return summary(outcome.task);
}

export function planDigest(content: PlanContent, capabilities: readonly Capability[]): string {
  return canonicalPayloadSha256({ content, capabilities: [...capabilities].sort() });
}

type PlanAssignment = PlanContent['assignments'][number];

function checkAssignment(
  assignment: PlanAssignment,
  teammates: ReadonlyMap<string, TeammateLite>,
  allowed: ReadonlySet<SourceKind>,
  keys: Set<string>,
): void {
  if (!teammates.has(assignment.teammateId)) throw new Conflict('teammate_not_found', 400);
  if (assignment.sources.some((source) => !allowed.has(source)))
    throw new Conflict('source_not_allowed', 400);
  if (keys.has(assignment.key)) throw new Conflict('duplicate_assignment_key', 400);
  keys.add(assignment.key);
}

/** Validates a plan against this member's teammates and the workflow; returns its capabilities. */
export async function checkPlan(
  deps: Deps,
  tx: Tx,
  task: TaskRow,
  member: Member,
  content: PlanContent,
): Promise<readonly Capability[]> {
  const allowed = new Set(WORKFLOW_SOURCES[task.workflow]);
  const teammates = await ownedTeammates(tx, member.sub, [
    content.synthesisOwner,
    ...content.assignments.map((a) => a.teammateId),
  ]);
  if (content.synthesisOwner !== task.result_owner) throw new Conflict('result_owner_changed', 400);
  const keys = new Set<string>();
  for (const assignment of content.assignments)
    checkAssignment(assignment, teammates, allowed, keys);
  for (const assignment of content.assignments)
    if (assignment.dependsOn.some((key) => !keys.has(key) || key === assignment.key))
      throw new Conflict('bad_dependency', 400);
  if (hasDependencyCycle(content.assignments)) throw new Conflict('bad_dependency', 400);
  const capabilities = new Set(
    content.assignments.flatMap((assignment) => [...capabilitiesForSources(assignment.sources)]),
  );
  return [...capabilities].sort();
}

export async function decidePlan(
  deps: Deps,
  member: Member,
  id: string,
  input: {
    readonly version: number;
    readonly expectedDigest: string;
    readonly decision: 'approve' | 'reject';
  },
): Promise<TaskSummary> {
  return locked(deps, member, id, async (tx, task) => {
    if (task.status !== 'plan_review') throw new Conflict('not_in_plan_review');
    const plans = await tx<
      PlanRow[]
    >`select * from tw_plans where task_id = ${id} and version = ${input.version} for update`;
    const plan = plans.at(0);
    if (plan === undefined) throw new Conflict('plan_not_found', 404);
    if (plan.state !== 'proposed') throw new Conflict('plan_not_current');
    if (
      plan.digest !== input.expectedDigest ||
      planDigest(plan.content, plan.capabilities) !== plan.digest
    )
      throw new Conflict('stale_plan');
    const at = deps.now();
    if (input.decision === 'reject') {
      await tx`update tw_plans set state = 'rejected', decided_at = ${at}, decided_by = ${member.sub} where task_id = ${id} and version = ${input.version}`;
      await moveTask(deps, tx, task, {
        to: 'declined',
        events: [
          {
            type: 'plan.rejected',
            summary: `You rejected plan version ${input.version}. Nothing was dispatched.`,
          },
        ],
      });
    } else {
      await tx`update tw_plans set state = 'approved', decided_at = ${at}, decided_by = ${member.sub} where task_id = ${id} and version = ${input.version}`;
      await appendEvent(deps, tx, id, {
        type: 'plan.approved',
        summary: `You approved plan version ${input.version}`,
        detail: { planVersion: input.version, digest: plan.digest.slice(0, 12) },
      });
      await dispatch(deps, tx, {
        task,
        member,
        work: plan.content.assignments,
        planVersion: input.version,
      });
      await moveTask(deps, tx, task, {
        to: 'running',
        events: [
          {
            type: 'task.dispatched',
            summary: `Dispatched ${plan.content.assignments.length} assignments from plan version ${input.version}`,
          },
        ],
      });
    }
    await audit(deps, tx, {
      ownerSub: member.sub,
      taskId: id,
      action: 'plan.decide',
      outcome: input.decision,
      detail: { version: input.version },
    });
  });
}

/** A member edit is a new plan version; the previous one is superseded and needs no decision. */
export async function editPlan(
  deps: Deps,
  member: Member,
  id: string,
  input: { readonly baseVersion: number; readonly content: PlanContent },
): Promise<TaskSummary> {
  return locked(deps, member, id, async (tx, task) => {
    if (task.status !== 'plan_review') throw new Conflict('not_in_plan_review');
    const current = (
      await tx<
        PlanRow[]
      >`select * from tw_plans where task_id = ${id} and state = 'proposed' for update`
    ).at(0);
    if (current === undefined || current.version !== input.baseVersion)
      throw new Conflict('stale_plan');
    const capabilities = await checkPlan(deps, tx, task, member, input.content);
    await supersedeLivePlan(tx, id);
    const version = current.version + 1;
    await tx`
      insert into tw_plans (task_id, version, author, content, capabilities, digest, state, created_at)
      values (${id}, ${version}, 'member', ${tx.json(input.content)}, ${tx.json([...capabilities])},
        ${planDigest(input.content, capabilities)}, 'proposed', ${deps.now()})
    `;
    await appendEvent(deps, tx, id, {
      type: 'plan.edited',
      summary: `You edited the plan (version ${version}). Review it before anything runs.`,
      detail: { planVersion: version },
    });
    await touchTask(deps, tx, id);
  });
}

export async function replan(
  deps: Deps,
  member: Member,
  id: string,
  feedback: string,
): Promise<TaskSummary> {
  return locked(deps, member, id, async (tx, task) => {
    if (task.status !== 'plan_review' && task.status !== 'needs_input')
      throw new Conflict('cannot_replan');
    await supersedeLivePlan(tx, id);
    // A new plan defines all remaining work; nothing from the old plan may still run or be answered.
    for (const assignment of await assignmentsFor(tx, id))
      await moveAssignment(deps, tx, assignment, 'superseded');
    await tx`update tw_jobs set state = 'cancelled', updated_at = ${deps.now()} where task_id = ${id} and kind = 'assignment' and state = 'queued'`;
    const latest = await latestPlanVersion(tx, id);
    await moveTask(deps, tx, task, {
      to: 'planning',
      patch: { revision_request: feedback },
      events: [
        { type: 'plan.replan_requested', summary: 'You asked the coordinator for a new plan' },
      ],
    });
    await enqueue(deps, tx, id, 'plan', `${id}:${latest + 1}`);
  });
}

type FollowUpInput = {
  readonly clientRequestId: string;
  readonly kind: 'revise' | 'answer' | 'question' | 'rescope';
  readonly text: string;
  readonly assignmentId: string | null;
  readonly metrics?: MetricsScope | null;
};
type FollowUpContext = {
  readonly tx: Tx;
  readonly task: TaskRow;
  readonly id: string;
  readonly input: FollowUpInput;
  readonly messageId: string;
};

async function followUpQuestion(deps: Deps, { tx, id, messageId }: FollowUpContext): Promise<void> {
  await enqueue(deps, tx, id, 'reply', messageId);
  await touchTask(deps, tx, id);
}

function assertRevisable(task: TaskRow): void {
  if (task.status !== 'ready' && task.status !== 'completed')
    throw new Conflict(`cannot_revise_${task.status}`);
}

async function followUpRevise(deps: Deps, { tx, task, id, input }: FollowUpContext): Promise<void> {
  assertRevisable(task);
  await moveTask(deps, tx, task, {
    to: 'synthesizing',
    patch: { revision_request: input.text },
    events: [
      {
        type: 'revision.requested',
        summary: 'You requested a revision',
        detail: { fromRevision: task.latest_revision },
      },
    ],
  });
  await enqueue(deps, tx, id, 'synthesis', `${id}:${task.latest_revision + 1}`);
}

/** `roots` plus every candidate that `joins` the growing set, repeated until nothing joins. */
function closure(
  roots: readonly AssignmentRow[],
  candidates: readonly AssignmentRow[],
  joins: (candidate: AssignmentRow, keys: ReadonlySet<string>) => boolean,
): readonly AssignmentRow[] {
  const keys = new Set(roots.map((a) => a.key));
  let grew = true;
  while (grew) {
    grew = false;
    for (const a of candidates)
      if (!keys.has(a.key) && joins(a, keys)) {
        keys.add(a.key);
        grew = true;
      }
  }
  return candidates.filter((a) => keys.has(a.key));
}

async function followUpRescope(
  deps: Deps,
  { tx, task, id, input }: FollowUpContext,
): Promise<void> {
  const metrics = input.metrics;
  if (task.workflow !== 'metrics_explanation' || metrics === undefined || metrics === null)
    throw new Conflict('rescope_not_supported', 400);
  assertRevisable(task);
  if (metrics.baseline === metrics.current) throw new Conflict('metrics_periods_equal', 400);
  const comparison = `Comparison changed to ${metrics.baseline} vs ${metrics.current} by ${metrics.groupBy}`;
  const succeeded = (await assignmentsFor(tx, id)).filter((a) => a.status === 'succeeded');
  const data = succeeded.filter((a) => a.sources.includes('bigquery_metrics'));
  if (data.length === 0) throw new Conflict('no_data_assignment');
  // The rerun is a new attempt of the same reviewed assignment; sources and capabilities are
  // unchanged. Assignments built on the data's output re-run too, after it, for the new periods.
  const dependents = closure(data, succeeded, (a, keys) => a.depends_on.some((k) => keys.has(k)));
  for (const assignment of dependents)
    await requeue(deps, tx, assignment, { output: null, calculations: [] });
  await releaseReady(deps, tx, id);
  await moveTask(deps, tx, task, {
    to: 'running',
    patch: {
      scope: { ...task.scope, metrics },
      revision_request: `${input.text} (${comparison.toLowerCase()})`,
    },
    events: [
      {
        type: 'scope.changed',
        summary: `${comparison}; re-running ${data.length} data assignment${data.length === 1 ? '' : 's'}`,
      },
    ],
  });
}

async function followUpAnswer(deps: Deps, { tx, task, id, input }: FollowUpContext): Promise<void> {
  const assignment = (await assignmentsFor(tx, id)).find((a) => a.id === input.assignmentId);
  if (assignment === undefined) throw new Conflict('not_found', 404);
  if (assignment.status !== 'needs_input') throw new Conflict('not_waiting_for_answer');
  await requeue(deps, tx, assignment, { answer: input.text });
  await releaseReady(deps, tx, id);
  await appendEvent(deps, tx, id, {
    type: 'assignment.answered',
    summary: `You answered ${assignment.teammate_snapshot.name}`,
    detail: { assignmentId: assignment.id },
  });
  if (task.status === 'needs_input') await moveTask(deps, tx, task, { to: 'running', events: [] });
}

export async function followUp(
  deps: Deps,
  member: Member,
  id: string,
  input: FollowUpInput,
): Promise<TaskSummary> {
  return locked(deps, member, id, async (tx, task) => {
    const duplicate =
      await tx`select 1 from tw_messages where owner_sub = ${member.sub} and client_request_id = ${input.clientRequestId}`;
    if (duplicate.length > 0) return;
    const conversationId = await conversationFor(tx, task);
    if (conversationId === undefined) throw new Conflict('not_found', 404);
    const messageId = await postMessage(deps, tx, {
      conversationId,
      ownerSub: member.sub,
      role: 'member',
      body: input.text,
      taskId: id,
      clientRequestId: input.clientRequestId,
      replyState: input.kind === 'question' ? 'pending' : null,
    });
    const context: FollowUpContext = { tx, task, id, input, messageId };
    switch (input.kind) {
      case 'question':
        await followUpQuestion(deps, context);
        break;
      case 'revise':
        await followUpRevise(deps, context);
        break;
      case 'rescope':
        await followUpRescope(deps, context);
        break;
      case 'answer':
        await followUpAnswer(deps, context);
        break;
    }
  });
}

export async function decideMissing(
  deps: Deps,
  member: Member,
  id: string,
  input: { readonly decision: 'retry' | 'proceed'; readonly assignmentIds: readonly string[] },
): Promise<TaskSummary> {
  return locked(deps, member, id, async (tx, task) => {
    if (task.status !== 'needs_input') throw new Conflict(`cannot_decide_${task.status}`);
    const assignments = await assignmentsFor(tx, id);
    const missing = assignments.filter((a) => a.status === 'failed' || a.status === 'timed_out');
    if (input.decision === 'proceed') {
      if (!assignments.some((a) => a.status === 'succeeded'))
        throw new Conflict('nothing_to_synthesize');
      await moveTask(deps, tx, task, {
        to: 'synthesizing',
        events: [
          {
            type: 'task.proceed_partial',
            summary: `You chose to continue without ${missing.map((a) => a.key).join(', ')}. The result will state this limitation.`,
          },
        ],
      });
      await enqueue(deps, tx, id, 'synthesis', `${id}:${task.latest_revision + 1}`);
    } else {
      const chosen = missing.filter(
        (a) => input.assignmentIds.length === 0 || input.assignmentIds.includes(a.id),
      );
      if (chosen.length === 0) throw new Conflict('nothing_to_retry');
      // A chosen assignment that waits for another missing one needs that one re-run too.
      const needed = closure(chosen, missing, (a, keys) =>
        missing.some((r) => keys.has(r.key) && r.depends_on.includes(a.key)),
      );
      for (const assignment of needed) await requeue(deps, tx, assignment);
      await releaseReady(deps, tx, id);
      await moveTask(deps, tx, task, {
        to: 'running',
        events: [
          { type: 'task.retried', summary: `Retrying ${chosen.map((a) => a.key).join(', ')}` },
        ],
      });
    }
  });
}

export async function cancelTask(deps: Deps, member: Member, id: string): Promise<TaskSummary> {
  return locked(deps, member, id, async (tx, task) => {
    const requested = { type: 'task.cancel_requested', summary: 'You cancelled this task' };
    await cancelJobs(deps, tx, id);
    for (const assignment of await assignmentsFor(tx, id))
      if (assignment.status === 'queued' || assignment.status === 'needs_input')
        await moveAssignment(deps, tx, assignment, 'cancelled');
    await tx`update wb_approvals set state = 'void' where task_id = ${id} and subject = 'publish' and state = 'pending'`;
    const cancelled = {
      type: 'task.cancelled',
      summary: 'Task cancelled. Nothing more will run and nothing will be published.',
    };
    if (task.status === 'running' || task.status === 'synthesizing') {
      await moveTask(deps, tx, task, { to: 'cancel_requested', events: [requested] });
      // With no job in flight there is no step boundary to wait for.
      const busy =
        await tx`select 1 from tw_jobs where task_id = ${id} and state = 'running' and kind in ('assignment', 'synthesis')`;
      if (busy.length === 0)
        await moveTask(
          deps,
          tx,
          { ...task, status: 'cancel_requested' },
          { to: 'cancelled', events: [cancelled] },
        );
    } else if (
      [
        'planning',
        'plan_review',
        'needs_input',
        'ready',
        'awaiting_action_approval',
        'failed',
      ].includes(task.status)
    ) {
      await moveTask(deps, tx, task, { to: 'cancelled', events: [requested, cancelled] });
    } else throw new Conflict(`cannot_cancel_${task.status}`);
  });
}

export async function retryTask(deps: Deps, member: Member, id: string): Promise<TaskSummary> {
  return locked(deps, member, id, async (tx, task) => {
    if (task.status !== 'failed') throw new Conflict(`cannot_retry_${task.status}`);
    const retried = { type: 'task.retried', summary: 'You retried the failed step' };
    if (task.failed_stage === 'planning') {
      const latest = await latestPlanVersion(tx, id);
      await moveTask(deps, tx, task, { to: 'planning', events: [retried], error: null });
      await enqueue(deps, tx, id, 'plan', `${id}:${latest + 1}:retry`);
    } else if (task.failed_stage === 'publish') {
      const approval = (
        await tx<
          { id: string }[]
        >`select ap.id from wb_approvals ap join wb_actions ac on ac.approval_id = ap.id where ap.task_id = ${id} and ap.state = 'approved' and ac.status = 'failed' order by ap.requested_at desc limit 1`
      ).at(0);
      if (approval === undefined) throw new Conflict('nothing_to_retry');
      await tx`update wb_actions set status = 'intended', updated_at = ${deps.now()} where approval_id = ${approval.id}`;
      await moveTask(deps, tx, task, {
        to: 'publishing',
        events: [
          {
            ...retried,
            summary: 'Retrying the approved publication with the same idempotency key',
          },
        ],
        error: null,
      });
      await enqueue(deps, tx, id, 'publish', approval.id);
    } else {
      await moveTask(deps, tx, task, { to: 'synthesizing', events: [retried], error: null });
      await enqueue(deps, tx, id, 'synthesis', `${id}:${task.latest_revision + 1}:retry`);
    }
  });
}

export function publishDigest(proposal: PublishProposal): string {
  return canonicalPayloadSha256(proposal);
}

/** Builds the exact publication and asks for approval; any later revision voids it. */
export async function preparePublish(
  deps: Deps,
  member: Member,
  id: string,
  revision: number,
): Promise<TaskSummary> {
  const [views, connected] = await Promise.all([
    connections(deps, member),
    connectedProviders(deps, member.sub),
  ]);
  const google = views.find((c) => c.provider === 'google');
  const account =
    deps.config.sourceMode === 'fixture'
      ? `${member.email} (fixture Docs)`
      : google?.status === 'active'
        ? google.account
        : null;
  return locked(deps, member, id, async (tx, task) => {
    if (task.status !== 'ready' && task.status !== 'completed')
      throw new Conflict(`cannot_publish_${task.status}`);
    if (revision !== task.latest_revision) throw new Conflict('stale_revision');
    if (!(await canPublish(deps, tx, member, task, connected)) || account === null)
      throw new Conflict('capability_denied', 403);
    const rev = (
      await tx<
        RevisionRow[]
      >`select * from tw_revisions where task_id = ${id} and revision = ${revision}`
    ).at(0);
    if (rev === undefined) throw new Conflict('not_found', 404);
    const evidence = await evidenceFor(tx, id);
    const titles = new Map(evidence.map((e) => [e.id, e.title]));
    const cited = evidence.filter((e) => rev.evidence_ids.includes(e.id));
    const markdown = [
      artifactMarkdown(rev.content, titles),
      '## Sources',
      '',
      ...cited.map(
        (e) =>
          `- ${e.title}${e.modifiedAt === null ? '' : ` (dated ${e.modifiedAt.slice(0, 10)})`}${e.url === null ? '' : `: ${e.url}`}`,
      ),
      '',
      `Generated by Agent Works M1 (${deps.config.segmentName}), revision ${revision}, model ${rev.generation.modelVersion}.`,
    ].join('\n');
    const proposal: PublishProposal = {
      tool: 'google_docs.create',
      account,
      destination: `A new Google Doc in the My Drive of ${account}`,
      documentTitle: `[aw-m1 ${deps.config.segment}] ${rev.content.title} (revision ${revision})`,
      revision,
      contentMarkdown: markdown,
      wordCount: markdown.split(/\s+/).filter(Boolean).length,
      consequences: [
        'Creates exactly one new document. No existing file is changed or shared.',
        'Anyone you later share the document with can read this content.',
        'A retry or reconcile reuses the same marker, so it cannot create a second copy.',
      ],
    };
    await tx`update wb_approvals set state = 'void' where task_id = ${id} and subject = 'publish' and state = 'pending'`;
    const at = deps.now();
    await tx`
      insert into wb_approvals (id, task_id, proposal, document, payload_sha256, state, requested_at, expires_at, subject, subject_ref)
      values (${deps.newId()}, ${id}, ${tx.json(proposal)}, ${tx.json({ markdown })}, ${publishDigest(proposal)}, 'pending',
        ${at}, ${new Date(at.getTime() + APPROVAL_TTL_MS)}, 'publish', ${revision})
    `;
    await moveTask(deps, tx, task, {
      to: 'awaiting_action_approval',
      events: [
        {
          type: 'approval.requested',
          summary: `Review the exact Google Doc for revision ${revision} before it is created`,
        },
      ],
    });
  });
}

/**
 * The publish gate: segment, member entitlement, the result owner's requests and the connection.
 * Checked when a publication is prepared and again when it is approved, since either can change.
 */
async function canPublish(
  deps: Deps,
  tx: Tx,
  member: Member,
  task: TaskRow,
  connected?: ReadonlySet<Provider>,
): Promise<boolean> {
  const owner = (
    await tx<
      { capability_requests: Capability[] }[]
    >`select capability_requests from tw_teammates where id = ${task.result_owner}`
  ).at(0);
  const states = await capabilitiesFor(
    deps,
    member,
    owner?.capability_requests ?? [],
    new Set([DOCS_PUBLISH]),
    connected,
  );
  return effectiveSet(states).has(DOCS_PUBLISH);
}

export async function decideAction(
  deps: Deps,
  member: Member,
  id: string,
  input: {
    readonly approvalId: string;
    readonly expectedDigest: string;
    readonly decision: 'approve' | 'reject';
  },
): Promise<TaskSummary> {
  return locked(deps, member, id, async (tx, task) => {
    const approval = (
      await tx<
        {
          id: string;
          state: string;
          proposal: unknown;
          payload_sha256: string;
          expires_at: Date;
          subject_ref: number;
        }[]
      >`
      select id, state, proposal, payload_sha256, expires_at, subject_ref from wb_approvals
      where id = ${input.approvalId} and task_id = ${id} and subject = 'publish' for update
    `
    ).at(0);
    if (approval === undefined) throw new Conflict('not_found', 404);
    if (approval.state !== 'pending') throw new Conflict('already_decided');
    if (task.status !== 'awaiting_action_approval') throw new Conflict('not_awaiting_approval');
    if (approval.payload_sha256 !== input.expectedDigest) throw new Conflict('stale_digest');
    const proposal = publishProposalSchema.parse(approval.proposal);
    if (publishDigest(proposal) !== approval.payload_sha256)
      throw new Conflict('approval_tampered');
    // Entitlement can change between preparing and approving (for example a read-only member).
    if (input.decision === 'approve' && !(await canPublish(deps, tx, member, task)))
      throw new Conflict('capability_denied', 403);
    const at = deps.now();
    // A task that already published keeps its completed state when a later publish is declined.
    const published = await tx`
      select 1 from wb_actions where task_id = ${id} and kind = 'publish' and status = 'succeeded' limit 1
    `;
    const back = published.length > 0 ? 'completed' : 'ready';
    if (approval.subject_ref !== task.latest_revision) {
      await tx`update wb_approvals set state = 'void' where id = ${approval.id}`;
      await moveTask(deps, tx, task, {
        to: back,
        events: [
          {
            type: 'approval.void',
            summary: 'A newer revision exists, so this approval was voided. Nothing was published.',
          },
        ],
      });
      return 'stale_revision';
    }
    if (approval.expires_at.getTime() <= at.getTime()) {
      await tx`update wb_approvals set state = 'void' where id = ${approval.id}`;
      await moveTask(deps, tx, task, {
        to: back,
        events: [
          {
            type: 'approval.expired',
            summary:
              'The approval expired. Nothing was published. Prepare it again to review the current content.',
          },
        ],
      });
      return 'approval_expired';
    }
    if (input.decision === 'reject') {
      await tx`update wb_approvals set state = 'rejected', decided_by = ${member.sub}, decided_at = ${at} where id = ${approval.id}`;
      await moveTask(deps, tx, task, {
        to: back,
        events: [
          {
            type: 'approval.rejected',
            summary: 'You rejected the publication. Nothing was written.',
          },
        ],
      });
    } else {
      await tx`update wb_approvals set state = 'approved', decided_by = ${member.sub}, decided_at = ${at} where id = ${approval.id}`;
      await tx`
        insert into wb_actions (task_id, approval_id, idempotency_key, status, simulated, updated_at, kind)
        values (${id}, ${approval.id}, ${`tw:${id}:${approval.id}`}, 'intended', ${deps.config.sourceMode === 'fixture'}, ${at}, 'publish')
      `;
      await moveTask(deps, tx, task, {
        to: 'publishing',
        events: [
          {
            type: 'approval.approved',
            summary: `You approved creating "${proposal.documentTitle}" in ${proposal.account}`,
            detail: { digest: approval.payload_sha256.slice(0, 12), revision: proposal.revision },
          },
        ],
      });
      await enqueue(deps, tx, id, 'publish', approval.id);
    }
    await audit(deps, tx, {
      ownerSub: member.sub,
      taskId: id,
      action: 'publish.decide',
      outcome: input.decision,
    });
  });
}

export async function reconcileTask(
  deps: Deps,
  member: Member,
  id: string,
  find: (
    key: string,
  ) => Promise<{ documentId: string; url: string; confirmedAt: string } | undefined>,
): Promise<TaskSummary> {
  const action = (
    await deps.sql<{ approval_id: string; idempotency_key: string }[]>`
    select ac.approval_id, ac.idempotency_key from wb_actions ac join wb_tasks t on t.id = ac.task_id
    where ac.task_id = ${id} and t.owner_sub = ${member.sub} and ac.kind = 'publish' and ac.status = 'uncertain'
    order by ac.updated_at desc limit 1
  `
  ).at(0);
  if (action === undefined) throw new Conflict('nothing_to_reconcile');
  const found = await find(action.idempotency_key);
  return locked(deps, member, id, async (tx, task) => {
    if (task.status !== 'outcome_uncertain') throw new Conflict(`cannot_reconcile_${task.status}`);
    if (found !== undefined && found.url !== '') {
      await tx`update wb_actions set status = 'succeeded', external_id = ${found.documentId}, external_url = ${found.url}, confirmed_at = ${new Date(found.confirmedAt)}, updated_at = ${deps.now()} where approval_id = ${action.approval_id}`;
      await moveTask(deps, tx, task, {
        to: 'completed',
        events: [
          {
            type: 'action.reconciled',
            summary: 'Found the document from the earlier attempt. No second copy was created.',
            detail: { documentId: found.documentId },
          },
        ],
        error: null,
      });
    } else {
      await tx`update wb_actions set status = 'intended', updated_at = ${deps.now()} where approval_id = ${action.approval_id}`;
      await moveTask(deps, tx, task, {
        to: 'publishing',
        events: [
          {
            type: 'action.reconciled',
            summary: 'No document found. Publishing again with the same marker.',
          },
        ],
        error: null,
      });
      await enqueue(deps, tx, id, 'publish', action.approval_id);
    }
  });
}

type InboxRow = {
  id: string;
  kind: InboxItem['kind'];
  task_id: string;
  title: string;
  ref: string;
  summary: string;
  state: InboxItem['state'];
  created_at: Date;
  resolved_at: Date | null;
};

const inboxItem = (row: InboxRow): InboxItem => ({
  id: row.id,
  kind: row.kind,
  taskId: row.task_id,
  taskTitle: row.title,
  ref: row.ref,
  summary: row.summary,
  state: row.state,
  createdAt: row.created_at.toISOString(),
  resolvedAt: row.resolved_at?.toISOString() ?? null,
});

/** The M1 inbox page: everything open, then the last week's resolved items. */
export async function inbox(deps: Deps, member: Member): Promise<readonly InboxItem[]> {
  const rows = await deps.sql<InboxRow[]>`
    select i.id, i.kind, i.task_id, t.title, i.ref, i.summary, i.state, i.created_at, i.resolved_at
    from tw_inbox i join wb_tasks t on t.id = i.task_id
    where i.owner_sub = ${member.sub} and (i.state = 'open' or i.resolved_at > now() - interval '7 days')
    order by i.state = 'open' desc, i.created_at desc limit 200
  `;
  return rows.map(inboxItem);
}

/** One state at a time, newest first by (created_at, id); `resolved` includes dismissed items. */
export async function listInbox(
  deps: Deps,
  member: Member,
  query: InboxListQuery,
): Promise<Page<InboxItem>> {
  const sql = deps.sql;
  const cursor = cursorOf(query.cursor);
  const rows = await sql<InboxRow[]>`
    select i.id, i.kind, i.task_id, t.title, i.ref, i.summary, i.state, i.created_at, i.resolved_at
    from tw_inbox i join wb_tasks t on t.id = i.task_id
    where i.owner_sub = ${member.sub}
    ${query.state === 'open' ? sql`and i.state = 'open'` : sql`and i.state <> 'open'`}
    ${cursor === undefined ? sql`` : sql`and (i.created_at, i.id) < (${cursor.at}::timestamptz, ${cursor.id}::uuid)`}
    order by i.created_at desc, i.id desc limit ${query.limit + 1}
  `;
  return page(rows, query.limit, inboxItem, (row) => ({
    at: row.created_at.toISOString(),
    id: row.id,
  }));
}

/** Only informational items can be dismissed; decisions resolve through the task itself. */
export async function dismissInbox(deps: Deps, member: Member, itemId: string): Promise<void> {
  const rows = await deps.sql`
    update tw_inbox set state = 'dismissed', resolved_at = ${deps.now()}
    where id = ${itemId} and owner_sub = ${member.sub} and kind = 'completed' and state = 'open' returning id
  `;
  if (rows.length === 0) throw new Conflict('not_dismissable');
}
