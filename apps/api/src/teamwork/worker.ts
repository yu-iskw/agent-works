import { canonicalPayloadSha256 } from '@agent-works/domain';
import { SOURCE_CAPABILITY, publishProposalSchema } from '@agent-works/domain/teamwork';
import { diffRevisions, missingSections } from '@agent-works/domain/teamwork-evidence';
import { capabilityStates, deniedSources } from '@agent-works/domain/teamwork-policy';

import { createScheduleWorker } from '../scheduling/worker.js';
import { ModelError, modelRemediation } from '../workbench/model-port.js';

import { capabilitiesFor, memberCapabilities, teammateSkills } from './catalog.js';
import { connectedProviders, tokenSource } from './connections.js';
import { audit } from './context.js';
import {
  WORKFLOW_SOURCES,
  contributionRequest,
  parseArtifact,
  parseContribution,
  parsePlan,
  planRequest,
  replyRequest,
  synthesisRequest,
} from './prompts.js';
import { isStale } from './sources/http.js';
import { SourceError, sourceRemediation } from './sources/port.js';
import {
  appendEvent,
  assignmentsFor,
  calculationsFor,
  enqueue,
  evidenceFor,
  latestPlanVersion,
  moveAssignment,
  moveTask,
  postMessage,
  readTask,
  supersedeLivePlan,
  touchTask,
  withTask,
} from './store.js';
import { checkPlan, planDigest, publishDigest, synthesisSkill } from './tasks.js';

import type { TeammateSkill } from './catalog.js';
import type { Deps, Member, Tx } from './context.js';
import type { CallContext, GatedResult } from './model.js';
import type { ContributionInput } from './prompts.js';
import type { SourceItem, TokenSource } from './sources/port.js';
import type { AssignmentRow, TaskRow } from './store.js';
import type {
  ArtifactContent,
  Calculation,
  Capability,
  EvidenceView,
  PlanContent,
  SkillDefinition,
  SourceKind,
} from '@agent-works/domain/teamwork';
import type { SupportSource } from '@agent-works/domain/teamwork-evidence';

type Job = {
  id: number;
  task_id: string | null;
  kind: 'plan' | 'assignment' | 'synthesis' | 'publish' | 'reply';
  ref: string;
  attempts: number;
  lease_token: string;
};

const LEASE_SECONDS = 240;
/** A job reclaimed after this many crashed attempts is failed instead of retried again. */
const MAX_JOB_ATTEMPTS = 3;

const memberOf = (task: TaskRow): Member => ({
  sub: task.owner_sub,
  email: (task.owner_email ?? '').toLowerCase(),
});

function modelFailure(error: unknown): Failure | undefined {
  if (error instanceof ModelError)
    return { code: error.code, message: modelRemediation[error.code] };
  return undefined;
}

async function claim(deps: Deps): Promise<Job | undefined> {
  const rows = await deps.sql<Job[]>`
    update tw_jobs set state = 'running', attempts = attempts + 1, lease_token = gen_random_uuid(),
      lease_until = now() + make_interval(secs => ${LEASE_SECONDS}), updated_at = now()
    where id = (
      select id from tw_jobs
      where state = 'queued' or (state = 'running' and lease_until < now())
      order by created_at limit 1 for update skip locked
    )
    returning id, task_id, kind, ref, attempts, lease_token
  `;
  return rows.at(0);
}

async function finish(deps: Deps, job: Job): Promise<void> {
  await deps.sql`
    update tw_jobs set state = 'done', lease_until = null, updated_at = now()
    where id = ${job.id} and lease_token = ${job.lease_token}
  `;
}

/** Moves a task whose cancellation was requested to cancelled once nothing of it is running. */
async function settleCancel(deps: Deps, tx: Tx, task: TaskRow): Promise<boolean> {
  if (task.status !== 'cancel_requested') return false;
  const running =
    await tx`select 1 from tw_assignments where task_id = ${task.id} and status = 'running'`;
  if (running.length === 0)
    await moveTask(deps, tx, task, {
      to: 'cancelled',
      events: [
        {
          type: 'task.cancelled',
          summary: 'Task cancelled at a safe step boundary. Nothing was published.',
        },
      ],
    });
  return true;
}

/**
 * After an assignment settles: wait while others run; ask the member when any is missing or has
 * a question; synthesize only when every contribution succeeded. Never synthesizes silently from
 * an incomplete set.
 */
async function dependencyOutputs(
  deps: Deps,
  assignment: AssignmentRow,
): Promise<ContributionInput[]> {
  if (assignment.depends_on.length === 0) return [];
  const rows = await deps.sql<AssignmentRow[]>`
    select * from tw_assignments where task_id = ${assignment.task_id} and status = 'succeeded'
      and key = any(${assignment.depends_on}::text[])
  `;
  return rows.flatMap((row) =>
    row.output === null
      ? []
      : [{ key: row.key, teammateName: row.teammate_snapshot.name, output: row.output }],
  );
}

/**
 * Starts each waiting assignment whose dependencies all succeeded, and fails each one whose
 * dependency can no longer succeed, so an approved plan runs in the order it was reviewed.
 * Returns the assignments as it left them.
 */
async function releaseDependents(
  deps: Deps,
  tx: Tx,
  taskId: string,
  live: readonly AssignmentRow[],
): Promise<readonly AssignmentRow[]> {
  const byKey = new Map(live.map((a) => [a.key, a]));
  const changed = new Map<string, AssignmentRow>();
  for (const waiting of live.filter(
    (a) => a.status === 'queued' && a.attempt === 1 && a.depends_on.length > 0,
  )) {
    const needs = waiting.depends_on.map((key) => byKey.get(key)?.status);
    if (needs.every((status) => status === 'succeeded')) {
      await enqueue(deps, tx, taskId, 'assignment', waiting.id);
      continue;
    }
    if (
      needs.some(
        (status) =>
          status === undefined ||
          !['queued', 'running', 'needs_input', 'succeeded'].includes(status),
      )
    ) {
      const failed = await moveAssignment(deps, tx, waiting, 'failed', {
        error: {
          code: 'dependency_failed',
          message: `It waits for ${waiting.depends_on.join(', ')}, which did not finish.`,
        },
      });
      if (failed !== undefined) changed.set(failed.id, failed);
    }
  }
  return live.map((a) => changed.get(a.id) ?? a);
}

async function settleTask(deps: Deps, taskId: string): Promise<void> {
  await withTask(deps, undefined, taskId, async (tx, task) => {
    if (await settleCancel(deps, tx, task)) return;
    if (task.status !== 'running') return;
    const live = (await assignmentsFor(tx, taskId)).filter(
      (a) => a.status !== 'superseded' && a.status !== 'cancelled',
    );
    const after = await releaseDependents(deps, tx, taskId, live);
    if (after.some((a) => a.status === 'queued' || a.status === 'running')) {
      await touchTask(deps, tx, taskId);
      return;
    }
    const blocked = after.filter((a) => a.status !== 'succeeded');
    if (blocked.length > 0) {
      await moveTask(deps, tx, task, {
        to: 'needs_input',
        events: [
          {
            type: 'task.needs_input',
            summary: `${blocked.length} assignment${blocked.length === 1 ? ' needs' : 's need'} your decision before the result is written`,
          },
        ],
      });
      return;
    }
    await moveTask(deps, tx, task, {
      to: 'synthesizing',
      events: [
        {
          type: 'synthesis.started',
          summary: `All ${live.length} contributions are in; writing the combined result`,
        },
      ],
    });
    await enqueue(deps, tx, taskId, 'synthesis', `${taskId}:${task.latest_revision + 1}`);
  });
}

type Failure = { readonly code: string; readonly message: string };

async function failTask(
  deps: Deps,
  taskId: string,
  from: TaskRow['status'],
  stage: 'planning' | 'synthesis' | 'publish',
  { code, message }: Failure,
): Promise<void> {
  await withTask(deps, undefined, taskId, async (tx, task) => {
    if (await settleCancel(deps, tx, task)) return;
    if (task.status !== from) return;
    await moveTask(deps, tx, task, {
      to: 'failed',
      events: [{ type: 'task.failed', summary: message, detail: { code, stage } }],
      error: { code, message, stage },
    });
  });
}

async function plan(deps: Deps, job: Job): Promise<void> {
  const task = await readTask(deps.sql, undefined, job.task_id ?? '');
  if (task?.status !== 'planning') return;
  const member = memberOf(task);
  const teammates = await deps.sql<
    {
      id: string;
      name: string;
      role: string;
      instructions: string;
      capability_requests: Capability[];
    }[]
  >`
    select id, name, role, instructions, capability_requests from tw_teammates where owner_sub = ${task.owner_sub} and not archived order by created_at
  `;
  const coordinator = teammates.find((t) => t.id === task.result_owner);
  if (coordinator === undefined)
    return failTask(deps, task.id, 'planning', 'planning', {
      code: 'teammate_not_found',
      message: 'The coordinator teammate no longer exists.',
    });
  const skills = await teammateSkills(
    deps.sql,
    teammates.map((t) => t.id),
  );
  const connected = await connectedProviders(deps, member.sub);
  const entitled = memberCapabilities(deps, member);
  const allowed = new Set(WORKFLOW_SOURCES[task.workflow]);
  const effectiveFor = new Map(
    teammates.map((t) => [
      t.id,
      new Set(
        capabilityStates({
          segment: deps.config.capabilities,
          member: entitled,
          teammate: new Set(t.capability_requests),
          connected,
        })
          .filter((s) => s.effective)
          .map((s) => s.capability),
      ),
    ]),
  );
  const roster = teammates
    .filter((t) => t.id !== coordinator.id)
    .map((t) => ({
      id: t.id,
      name: t.name,
      role: t.role,
      skills: (skills.get(t.id) ?? []).map((s) => s.name),
      capabilities: [...(effectiveFor.get(t.id) ?? [])],
    }));
  await appendEventTx(deps, task.id, {
    type: 'plan.requested',
    summary: `${coordinator.name} is drafting a plan (no work is dispatched yet)`,
  });
  let raw;
  try {
    raw = await deps.gate.generate(
      { taskId: task.id, assignmentId: null, purpose: 'plan' },
      planRequest({
        workflow: task.workflow,
        scope: task.scope,
        coordinator,
        roster,
        feedback: task.revision_request,
      }),
    );
  } catch (error) {
    const failure = modelFailure(error);
    if (failure === undefined) throw error;
    return failTask(deps, task.id, 'planning', 'planning', failure);
  }
  let proposal;
  try {
    proposal = parsePlan(raw.text);
  } catch {
    return failTask(deps, task.id, 'planning', 'planning', {
      code: 'invalid_output',
      message: modelRemediation.invalid_output,
    });
  }
  const seen = new Set<string>();
  const assignments = proposal.assignments
    .filter((a) => roster.some((r) => r.id === a.teammateId))
    .map((a) => ({
      ...a,
      sources: a.sources.filter(
        (s) =>
          // eslint-disable-next-line security/detect-object-injection
          allowed.has(s) && (effectiveFor.get(a.teammateId)?.has(SOURCE_CAPABILITY[s]) ?? false),
      ),
    }))
    .filter((a) => a.sources.length > 0)
    .map((a, index) => {
      const key = seen.has(a.key) ? `${a.key.slice(0, 26)}-${index + 1}` : a.key;
      seen.add(key);
      return { ...a, key };
    });
  const keys = new Set(assignments.map((a) => a.key));
  const content: PlanContent = {
    summary: proposal.summary || 'Coordinator plan',
    assignments: assignments.map((a) => ({
      ...a,
      dependsOn: a.dependsOn.filter((k) => keys.has(k) && k !== a.key),
    })),
    synthesisOwner: task.result_owner,
    expectedEffects: proposal.expectedEffects,
  };
  if (content.assignments.length === 0)
    return failTask(deps, task.id, 'planning', 'planning', {
      code: 'plan_unusable',
      message:
        'The coordinator proposed no assignment your teammates can do with their current capabilities. Check Connections, then retry.',
    });
  await withTask(deps, undefined, task.id, async (tx, locked) => {
    if (locked.status !== 'planning') return;
    const capabilities = await checkPlan(deps, tx, locked, member, content);
    const version = (await latestPlanVersion(tx, task.id)) + 1;
    await supersedeLivePlan(tx, task.id);
    await tx`
      insert into tw_plans (task_id, version, author, content, capabilities, digest, state, created_at)
      values (${task.id}, ${version}, 'coordinator', ${tx.json(content)}, ${tx.json([...capabilities])},
        ${planDigest(content, capabilities)}, 'proposed', ${deps.now()})
    `;
    await moveTask(deps, tx, locked, {
      to: 'plan_review',
      patch: { revision_request: null },
      events: [
        {
          type: 'plan.proposed',
          summary: `Plan version ${version} is ready for your review: ${content.assignments.length} assignment${content.assignments.length === 1 ? '' : 's'}`,
          detail: {
            planVersion: version,
            responseId: raw.responseId ?? null,
            modelVersion: raw.modelVersion,
            callId: raw.callId,
          },
        },
      ],
    });
  });
}

async function appendEventTx(
  deps: Deps,
  taskId: string,
  event: Parameters<typeof appendEvent>[3],
): Promise<void> {
  await withTask(deps, undefined, taskId, (tx) => appendEvent(deps, tx, taskId, event));
}

/** Persists retrieved items with task-wide evidence IDs; an item another assignment (or a resumed attempt) already read keeps its ID. */
async function recordEvidence(
  deps: Deps,
  task: TaskRow,
  assignment: AssignmentRow,
  items: readonly SourceItem[],
): Promise<EvidenceView[]> {
  const now = deps.now();
  const recorded = await withTask(deps, undefined, task.id, async (tx) => {
    const existing = await tx<
      { id: string; source_id: string; location: string; excerpt: string }[]
    >`
      select id, source_id, location, excerpt from wb_evidence where task_id = ${task.id}
    `;
    const max =
      (
        await tx<
          { n: number }[]
        >`select coalesce(max(ordinal), 0)::int as n from wb_evidence where task_id = ${task.id}`
      ).at(0)?.n ?? 0;
    let next = max;
    const ids: string[] = [];
    for (const item of items) {
      const same = existing.find(
        (row) =>
          row.source_id === item.sourceId &&
          row.location === item.location &&
          row.excerpt === item.excerpt,
      );
      if (same !== undefined) {
        ids.push(same.id);
        continue;
      }
      next += 1;
      const id = `E${next}`;
      ids.push(id);
      await tx`
        insert into wb_evidence (id, task_id, attempt, ordinal, source_id, title, excerpt, url, modified_at, retrieved_at,
          provenance, assignment_id, source_kind, location, source_revision, stale)
        values (${id}, ${task.id}, 1, ${next}, ${item.sourceId}, ${item.title}, ${item.excerpt}, ${item.url},
          ${item.modifiedAt === null ? null : new Date(item.modifiedAt)}, ${now}, ${item.provenance}, ${assignment.id},
          ${item.sourceKind}, ${item.location}, ${item.sourceRevision}, ${isStale(item.modifiedAt, now)})
      `;
    }
    const all = await evidenceFor(tx, task.id);
    return ids
      .map((id) => all.find((e) => e.id === id))
      .filter((e): e is EvidenceView => e !== undefined);
  });
  return recorded ?? [];
}

async function failAssignment(
  deps: Deps,
  assignment: AssignmentRow,
  to: 'failed' | 'timed_out' | 'cancelled',
  code: string,
  message: string,
): Promise<void> {
  await deps.sql.begin(async (tx) => {
    const current = (
      await tx<AssignmentRow[]>`select * from tw_assignments where id = ${assignment.id} for update`
    ).at(0);
    if (current === undefined) return;
    const moved = await moveAssignment(deps, tx, current, to, {
      error: to === 'cancelled' ? null : { code, message },
    });
    if (moved !== undefined)
      await appendEvent(deps, tx, assignment.task_id, {
        type: `assignment.${to}`,
        summary:
          to === 'cancelled'
            ? `${assignment.teammate_snapshot.name} stopped: task cancelled`
            : `${assignment.teammate_snapshot.name} could not finish: ${message}`,
        detail: { assignmentId: assignment.id, code },
      });
  });
  await settleTask(deps, assignment.task_id);
}

const supportSources = (evidence: readonly EvidenceView[]): Map<string, SupportSource> =>
  new Map(
    evidence.map((e) => [
      e.id,
      { id: e.id, title: e.title, excerpt: `${e.location}\n${e.excerpt}` },
    ]),
  );

type Metrics = {
  calculations: Omit<Calculation, 'id' | 'evidenceId'>[];
  observations: SourceItem;
  definitions: SourceItem;
};
type Gathered = { readonly items: SourceItem[]; readonly metrics: Metrics | undefined };

async function loadAssignment(
  deps: Deps,
  job: Job,
): Promise<{ assignment: AssignmentRow; task: TaskRow } | undefined> {
  const assignmentId = job.ref.split(':')[0] ?? '';
  const assignment = (
    await deps.sql<AssignmentRow[]>`select * from tw_assignments where id = ${assignmentId}`
  ).at(0);
  if (assignment === undefined) return undefined;
  const task = await readTask(deps.sql, undefined, assignment.task_id);
  return task === undefined ? undefined : { assignment, task };
}

const cancelling = (task: TaskRow | undefined): boolean =>
  task?.status === 'cancel_requested' || task?.status === 'cancelled';

/** Moves a queued assignment to running; a running one is resumed after a crash. False means nothing to run. */
async function startAssignment(
  deps: Deps,
  task: TaskRow,
  assignment: AssignmentRow,
  attempts: number,
): Promise<boolean> {
  if (cancelling(task)) {
    await failAssignment(deps, assignment, 'cancelled', 'cancelled', 'cancelled');
    return false;
  }
  const resumed = assignment.status === 'running';
  if (assignment.status !== 'queued' && !resumed) return false;
  if (attempts > MAX_JOB_ATTEMPTS) {
    await failAssignment(
      deps,
      assignment,
      'failed',
      'stale',
      'The worker stopped repeatedly during this assignment. Retry it.',
    );
    return false;
  }
  if (assignment.deadline_at.getTime() < deps.now().getTime()) {
    await failAssignment(
      deps,
      assignment,
      'timed_out',
      'deadline',
      'The assignment passed its deadline.',
    );
    return false;
  }
  if (resumed) return true;
  return deps.sql.begin(async (tx) => {
    const moved = await moveAssignment(deps, tx, assignment, 'running');
    if (moved !== undefined)
      await appendEvent(deps, tx, task.id, {
        type: 'assignment.started',
        summary: `${assignment.teammate_snapshot.name} started ${assignment.key}`,
        detail: {
          assignmentId: assignment.id,
          attempt: assignment.attempt,
          at: deps.now().toISOString(),
        },
      });
    return moved !== undefined;
  });
}

/** One token lookup per provider for the run; every source of the assignment shares it. */
function cachedTokens(source: TokenSource): TokenSource {
  const tokens = new Map<Parameters<TokenSource>[0], Promise<string>>();
  return (provider) => {
    const cached = tokens.get(provider) ?? source(provider);
    tokens.set(provider, cached);
    return cached;
  };
}

type SourceOutcome =
  | {
      readonly kind: SourceKind;
      readonly items: readonly SourceItem[];
      readonly metrics: Metrics | undefined;
    }
  | { readonly kind: SourceKind; readonly error: SourceError };

async function readSource(
  deps: Deps,
  task: TaskRow,
  assignment: AssignmentRow,
  token: TokenSource,
  kind: SourceKind,
): Promise<SourceOutcome> {
  const startedAt = Date.now();
  try {
    const result = await deps.sources.read({
      kind,
      token,
      query: `${task.scope.question} ${assignment.brief}`,
      metrics: task.scope.metrics,
      repository: task.scope.repository,
      issueNumber: task.scope.issueNumber,
    });
    await appendEventTx(deps, task.id, {
      type: 'retrieval.completed',
      summary: `${assignment.teammate_snapshot.name} read ${result.items.length + (result.metrics === null ? 0 : 2)} item${result.items.length === 1 ? '' : 's'} from ${kind.replaceAll('_', ' ')}`,
      detail: { assignmentId: assignment.id, source: kind, mode: deps.sources.mode },
      durationMs: Date.now() - startedAt,
    });
    const metrics =
      result.metrics === null
        ? undefined
        : {
            calculations: [...result.metrics.calculations],
            observations: result.metrics.observations,
            definitions: result.metrics.definitions,
          };
    return { kind, items: result.items, metrics };
  } catch (error) {
    if (!(error instanceof SourceError)) throw error;
    return { kind, error };
  }
}

/** Reads every source of the assignment; undefined means a source failed and the assignment was failed. */
async function gatherSources(
  deps: Deps,
  task: TaskRow,
  assignment: AssignmentRow,
  member: Member,
): Promise<Gathered | undefined> {
  const token = cachedTokens(tokenSource(deps, member.sub));
  const outcomes = await Promise.all(
    assignment.sources.map((kind) => readSource(deps, task, assignment, token, kind)),
  );
  const items: SourceItem[] = [];
  let metrics: Metrics | undefined;
  for (const outcome of outcomes) {
    if ('error' in outcome) {
      await audit(deps, deps.sql, {
        ownerSub: member.sub,
        taskId: task.id,
        assignmentId: assignment.id,
        action: `source.${outcome.kind}`,
        outcome: outcome.error.code,
      });
      await failAssignment(
        deps,
        assignment,
        'failed',
        `source_${outcome.error.code}`,
        sourceRemediation[outcome.error.code],
      );
      return undefined;
    }
    items.push(...outcome.items);
    metrics = outcome.metrics ?? metrics;
  }
  await audit(deps, deps.sql, {
    ownerSub: member.sub,
    taskId: task.id,
    assignmentId: assignment.id,
    action: 'source.read',
    outcome: 'ok',
    detail: {
      items: items.length,
      sources: assignment.sources.join(','),
      capabilities: assignment.capabilities.join(','),
    },
  });
  return { items, metrics };
}

/** Numbers the calculations after every one the task already holds, so ids stay unique across reruns. */
async function numberCalculations(
  deps: Deps,
  task: TaskRow,
  assignment: AssignmentRow,
  metrics: Metrics,
  evidence: readonly EvidenceView[],
): Promise<Calculation[]> {
  const observation = evidence.find(
    (e) =>
      e.sourceId === metrics.observations.sourceId && e.location === metrics.observations.location,
  );
  const numbered = await withTask(deps, undefined, task.id, async (tx) => {
    const prior = await calculationsFor(tx, task.id);
    const used = await tx<
      { calculations: Calculation[] }[]
    >`select calculations from tw_revisions where task_id = ${task.id}`;
    const max = Math.max(
      0,
      ...[...prior, ...used.flatMap((r) => r.calculations)].map((c) => Number(c.id.slice(1))),
    );
    const next = metrics.calculations.map((c, index) => ({
      ...c,
      id: `C${max + index + 1}`,
      evidenceId: observation?.id ?? 'E1',
    }));
    await tx`update tw_assignments set calculations = ${tx.json(next)} where id = ${assignment.id}`;
    return next;
  });
  return numbered ?? [];
}

async function recordContribution(
  deps: Deps,
  task: TaskRow,
  assignment: AssignmentRow,
  parsed: ReturnType<typeof parseContribution>,
  result: GatedResult,
): Promise<void> {
  const model = {
    modelVersion: result.modelVersion,
    responseId: result.responseId ?? null,
    latencyMs: result.latencyMs,
  };
  await deps.sql.begin(async (tx) => {
    const current = (
      await tx<AssignmentRow[]>`select * from tw_assignments where id = ${assignment.id} for update`
    ).at(0);
    if (current?.status !== 'running') return;
    const question = parsed.value.question;
    await moveAssignment(deps, tx, current, question === null ? 'succeeded' : 'needs_input', {
      output: parsed.value,
      model,
      question,
      error: null,
    });
    await appendEvent(deps, tx, task.id, {
      type: question === null ? 'assignment.succeeded' : 'assignment.needs_input',
      summary:
        question === null
          ? `${assignment.teammate_snapshot.name} finished ${assignment.key}: ${parsed.value.statements.length} statements, ${parsed.unsupported} unverified, ${parsed.dropped} unknown citations removed`
          : `${assignment.teammate_snapshot.name} has a question for you`,
      detail: {
        assignmentId: assignment.id,
        responseId: model.responseId,
        modelVersion: model.modelVersion,
        latencyMs: model.latencyMs,
        callId: result.callId,
        finishedAt: deps.now().toISOString(),
      },
      durationMs: model.latencyMs,
    });
  });
}

async function runAssignment(deps: Deps, job: Job): Promise<void> {
  const loaded = await loadAssignment(deps, job);
  if (loaded === undefined) return;
  const { assignment, task } = loaded;
  if (!(await startAssignment(deps, task, assignment, job.attempts))) return;
  const member = memberOf(task);
  const states = await capabilitiesFor(deps, member, assignment.capabilities as Capability[]);
  const denied = deniedSources(assignment.sources, states);
  if (denied.length > 0)
    return failAssignment(
      deps,
      assignment,
      'failed',
      'source_denied',
      denied.map((d) => `${d.source}: ${d.reason}`).join(' '),
    );
  const gathered = await gatherSources(deps, task, assignment, member);
  if (gathered === undefined) return;
  const evidence = await recordEvidence(deps, task, assignment, [
    ...gathered.items,
    ...(gathered.metrics === undefined
      ? []
      : [gathered.metrics.observations, gathered.metrics.definitions]),
  ]);
  const calculations =
    gathered.metrics === undefined
      ? []
      : await numberCalculations(deps, task, assignment, gathered.metrics, evidence);
  if (cancelling(await readTask(deps.sql, undefined, task.id)))
    return failAssignment(deps, assignment, 'cancelled', 'cancelled', 'cancelled');
  const context: CallContext = {
    taskId: task.id,
    assignmentId: assignment.id,
    purpose: 'contribution',
  };
  let result;
  try {
    result = await deps.gate.generate(
      context,
      contributionRequest({
        teammate: assignment.teammate_snapshot,
        skills: assignment.skills.map((s) => s.definition),
        scope: task.scope,
        brief: assignment.brief,
        deliverable: assignment.deliverable,
        answer: assignment.answer,
        evidence,
        calculations,
        dependencies: await dependencyOutputs(deps, assignment),
      }),
    );
  } catch (error) {
    const failure = modelFailure(error);
    if (failure === undefined) throw error;
    return failAssignment(deps, assignment, 'failed', failure.code, failure.message);
  }
  let parsed;
  try {
    parsed = parseContribution(
      result.text,
      supportSources(evidence),
      new Map(calculations.map((c) => [c.id, c])),
    );
  } catch {
    return failAssignment(
      deps,
      assignment,
      'failed',
      'invalid_output',
      modelRemediation.invalid_output,
    );
  }
  await recordContribution(deps, task, assignment, parsed, result);
  await settleTask(deps, task.id);
}

type Previous = { revision: number; content: ArtifactContent; evidence_ids: string[] };
type SynthesisInputs = {
  readonly done: AssignmentRow[];
  readonly missing: string[];
  readonly owner: { id: string; name: string; instructions: string };
  readonly ownerSkills: readonly TeammateSkill[];
  readonly skill: SkillDefinition;
  readonly evidence: EvidenceView[];
  readonly calculations: Calculation[];
  readonly previous: Previous | undefined;
};

/** Everything a synthesis call reads; undefined means the owner cannot synthesize and the task was failed. */
async function synthesisInputs(deps: Deps, task: TaskRow): Promise<SynthesisInputs | undefined> {
  const assignments = (await assignmentsFor(deps.sql, task.id)).filter(
    (a) => a.status !== 'superseded',
  );
  const done = assignments.filter((a) => a.status === 'succeeded' && a.output !== null);
  const missing = assignments
    .filter((a) => a.status !== 'succeeded')
    .map((a) => `${a.key} (${a.teammate_snapshot.name}, ${a.status.replaceAll('_', ' ')})`);
  const owner = (
    await deps.sql<
      { id: string; name: string; instructions: string }[]
    >`select id, name, instructions from tw_teammates where id = ${task.result_owner}`
  ).at(0);
  const ownerSkills =
    (await teammateSkills(deps.sql, [task.result_owner])).get(task.result_owner) ?? [];
  const skill = synthesisSkill(ownerSkills, task.workflow);
  if (owner === undefined || skill === undefined) {
    await failTask(deps, task.id, 'synthesizing', 'synthesis', {
      code: 'no_synthesis_skill',
      message: 'The result owner has no synthesis skill for this workflow. Attach one, then retry.',
    });
    return undefined;
  }
  const evidence = await evidenceFor(deps.sql, task.id);
  const calculations = await calculationsFor(deps.sql, task.id);
  const previous = (
    await deps.sql<Previous[]>`
    select revision, content, evidence_ids from tw_revisions where task_id = ${task.id} order by revision desc limit 1
  `
  ).at(0);
  return { done, missing, owner, ownerSkills, skill, evidence, calculations, previous };
}

type ParsedArtifact = ReturnType<typeof parseArtifact>;

function revisionContent(
  parsed: ParsedArtifact,
  missing: readonly string[],
  outputSections: readonly string[],
): ArtifactContent {
  const absent = missingSections(parsed.value, outputSections);
  return {
    ...parsed.value,
    limitations: [
      ...parsed.value.limitations,
      ...missing
        .map((m) => `Missing contribution: ${m}.`)
        .filter((m) => !parsed.value.limitations.includes(m)),
      ...absent.map((heading) => `The required section "${heading}" was not produced.`),
    ].slice(0, 10),
  };
}

type StoreRevision = {
  readonly task: TaskRow;
  readonly inputs: SynthesisInputs;
  readonly content: ArtifactContent;
  readonly parsed: ParsedArtifact;
  readonly result: GatedResult;
  readonly revisionRequest: string | null;
};

async function storeRevision(
  deps: Deps,
  { task, inputs, content, parsed, result, revisionRequest }: StoreRevision,
): Promise<void> {
  const { previous, evidence, calculations, missing, ownerSkills, skill } = inputs;
  const cited = [
    ...new Set(content.sections.flatMap((s) => s.statements.flatMap((st) => st.evidenceIds))),
  ];
  const usedCalcs = new Set(
    content.sections.flatMap((s) => s.statements.flatMap((st) => st.calculationIds)),
  );
  const titleOf = (ids: readonly string[]) =>
    ids.map((id) => evidence.find((e) => e.id === id)?.title ?? id);
  const revision = (previous?.revision ?? 0) + 1;
  const diff =
    previous === undefined
      ? null
      : diffRevisions(
          { content: previous.content, sources: titleOf(previous.evidence_ids) },
          { content, sources: titleOf(cited) },
        );
  const repositoryRevision =
    evidence.find((e) => e.sourceKind === 'github_code' || e.sourceKind === 'github_issue')
      ?.sourceRevision ?? null;
  const planVersion =
    (
      await deps.sql<
        { version: number }[]
      >`select version from tw_plans where task_id = ${task.id} and state = 'approved'`
    ).at(0)?.version ?? null;
  await withTask(deps, undefined, task.id, async (tx, locked) => {
    if (locked.status === 'cancel_requested') {
      await settleCancel(deps, tx, locked);
      return;
    }
    if (locked.status !== 'synthesizing') return;
    await tx`
      insert into tw_revisions (task_id, revision, parent, request, content, evidence_ids, calculations, unsupported,
        dropped_citations, missing_assignments, generation, diff, digest, created_at)
      values (${task.id}, ${revision}, ${previous?.revision ?? null}, ${revisionRequest}, ${tx.json(content)}, ${tx.json(cited)},
        ${tx.json(calculations.filter((c) => usedCalcs.has(c.id) || task.workflow === 'metrics_explanation'))}, ${parsed.unsupported}, ${parsed.dropped},
        ${tx.json(missing)},
        ${tx.json({
          modelId: result.modelId,
          modelVersion: result.modelVersion,
          responseId: result.responseId ?? null,
          planVersion,
          skills: ownerSkills
            .filter((s) => s.definition === skill)
            .map(({ id, version, name }) => ({ id, version, name })),
          repositoryRevision: repositoryRevision === 'fixture' ? 'fixture' : repositoryRevision,
        })},
        ${diff === null ? null : tx.json(diff)}, ${canonicalPayloadSha256(content)}, ${deps.now()})
    `;
    await tx`update wb_approvals set state = 'void' where task_id = ${task.id} and subject = 'publish' and state = 'pending'`;
    await moveTask(deps, tx, locked, {
      to: 'ready',
      patch: { latest_revision: revision, revision_request: null },
      events: [
        {
          type: 'revision.created',
          summary: `Revision ${revision} ready: ${content.sections.length} sections, ${cited.length} sources cited, ${parsed.unsupported} unverified statements${missing.length > 0 ? `, ${missing.length} missing contributions stated` : ''}`,
          detail: {
            revision,
            responseId: result.responseId ?? null,
            modelVersion: result.modelVersion,
            callId: result.callId,
          },
          durationMs: result.latencyMs,
        },
      ],
      error: null,
    });
    if (locked.conversation_id !== null)
      await postMessage(deps, tx, {
        conversationId: locked.conversation_id,
        ownerSub: locked.owner_sub,
        role: 'system',
        body: `Revision ${revision} is ready: ${content.title}`,
        taskId: task.id,
        card: { kind: 'result_ready', taskId: task.id, title: content.title },
      });
  });
}

async function synthesize(deps: Deps, job: Job): Promise<void> {
  const task = await readTask(deps.sql, undefined, job.task_id ?? '');
  if (task === undefined) return;
  if (task.status === 'cancel_requested') {
    await withTask(deps, undefined, task.id, (tx, locked) => settleCancel(deps, tx, locked));
    return;
  }
  if (task.status !== 'synthesizing') return;
  const inputs = await synthesisInputs(deps, task);
  if (inputs === undefined) return;
  const { done, missing, owner, skill, evidence, calculations, previous } = inputs;
  const revisionRequest = previous === undefined ? null : task.revision_request;
  let result;
  try {
    result = await deps.gate.generate(
      {
        taskId: task.id,
        assignmentId: null,
        purpose: previous === undefined ? 'synthesis' : 'revision',
      },
      synthesisRequest({
        workflow: task.workflow,
        coordinator: owner,
        skill,
        scope: task.scope,
        contributions: done.map((a) => ({
          key: a.key,
          teammateName: a.teammate_snapshot.name,
          output: a.output as NonNullable<AssignmentRow['output']>,
        })),
        missing,
        evidence,
        calculations,
        previous: previous?.content ?? null,
        request: revisionRequest,
      }),
    );
  } catch (error) {
    const failure = modelFailure(error);
    if (failure === undefined) throw error;
    return failTask(deps, task.id, 'synthesizing', 'synthesis', failure);
  }
  let parsed;
  try {
    parsed = parseArtifact(
      result.text,
      supportSources(evidence),
      new Map(calculations.map((c) => [c.id, c])),
    );
  } catch {
    return failTask(deps, task.id, 'synthesizing', 'synthesis', {
      code: 'invalid_output',
      message: modelRemediation.invalid_output,
    });
  }
  await storeRevision(deps, {
    task,
    inputs,
    content: revisionContent(parsed, missing, skill.outputSections),
    parsed,
    result,
    revisionRequest,
  });
}

async function publish(deps: Deps, job: Job): Promise<void> {
  const task = await readTask(deps.sql, undefined, job.task_id ?? '');
  if (task?.status !== 'publishing') return;
  const row = (
    await deps.sql<
      {
        id: string;
        state: string;
        proposal: unknown;
        payload_sha256: string;
        subject_ref: number;
        idempotency_key: string;
        status: string;
      }[]
    >`
    select ap.id, ap.state, ap.proposal, ap.payload_sha256, ap.subject_ref, ac.idempotency_key, ac.status
    from wb_approvals ap join wb_actions ac on ac.approval_id = ap.id where ap.id = ${job.ref}
  `
  ).at(0);
  const proposal = publishProposalSchema.safeParse(row?.proposal);
  if (
    row === undefined ||
    row.state !== 'approved' ||
    !proposal.success ||
    publishDigest(proposal.data) !== row.payload_sha256 ||
    row.subject_ref !== task.latest_revision
  )
    return failTask(deps, task.id, 'publishing', 'publish', {
      code: 'approval_invalid',
      message: 'The approval no longer matches the revision to publish. Nothing was written.',
    });
  await deps.sql`update wb_actions set attempts = attempts + 1, updated_at = ${deps.now()} where approval_id = ${row.id}`;
  await appendEventTx(deps, task.id, {
    type: 'action.started',
    summary: `Creating "${proposal.data.documentTitle}" in ${proposal.data.account}`,
    detail: { mode: deps.sources.mode },
  });
  const started = Date.now();
  try {
    const published = await deps.sources.publish({
      token: tokenSource(deps, task.owner_sub),
      idempotencyKey: row.idempotency_key,
      title: proposal.data.documentTitle,
      markdown: proposal.data.contentMarkdown,
    });
    await withTask(deps, undefined, task.id, async (tx, locked) => {
      if (locked.status !== 'publishing') return;
      await tx`update wb_actions set status = 'succeeded', external_id = ${published.documentId}, external_url = ${published.url}, confirmed_at = ${new Date(published.confirmedAt)}, updated_at = ${deps.now()} where approval_id = ${row.id}`;
      await moveTask(deps, tx, locked, {
        to: 'completed',
        events: [
          {
            type: 'action.completed',
            summary: `Created 1 Google Doc${deps.sources.mode === 'fixture' ? ' (fixture store)' : ''}, confirmed by the provider`,
            detail: { documentId: published.documentId, url: published.url },
            durationMs: Date.now() - started,
          },
        ],
        error: null,
      });
      if (locked.conversation_id !== null)
        await postMessage(deps, tx, {
          conversationId: locked.conversation_id,
          ownerSub: locked.owner_sub,
          role: 'system',
          body: `Published "${proposal.data.documentTitle}"`,
          taskId: task.id,
          card: { kind: 'result_ready', taskId: task.id, title: proposal.data.documentTitle },
        });
      await audit(deps, tx, {
        ownerSub: task.owner_sub,
        taskId: task.id,
        action: 'publish.docs',
        outcome: 'succeeded',
        detail: { documentId: published.documentId },
      });
    });
  } catch (error) {
    if (!(error instanceof SourceError)) throw error;
    const uncertain = error.code === 'unavailable';
    await deps.sql`update wb_actions set status = ${uncertain ? 'uncertain' : 'failed'}, updated_at = ${deps.now()} where approval_id = ${row.id}`;
    await audit(deps, deps.sql, {
      ownerSub: task.owner_sub,
      taskId: task.id,
      action: 'publish.docs',
      outcome: uncertain ? 'uncertain' : 'failed',
      detail: { code: error.code },
    });
    if (uncertain)
      await withTask(deps, undefined, task.id, async (tx, locked) => {
        if (locked.status !== 'publishing') return;
        await moveTask(deps, tx, locked, {
          to: 'outcome_uncertain',
          events: [
            {
              type: 'action.uncertain',
              summary:
                'Google Docs did not confirm the write. It may or may not exist. Check before retrying.',
              durationMs: Date.now() - started,
            },
          ],
          error: {
            code: 'outcome_uncertain',
            message:
              'Google Docs did not confirm the write. Use "Check for the document" first; it will not be created twice.',
          },
        });
      });
    else
      await failTask(deps, task.id, 'publishing', 'publish', {
        code: `publish_${error.code}`,
        message: `Google Docs refused the write. Nothing was created. ${sourceRemediation[error.code]}`,
      });
  }
}

async function reply(deps: Deps, job: Job): Promise<void> {
  const message = (
    await deps.sql<
      {
        id: string;
        conversation_id: string;
        owner_sub: string;
        task_id: string | null;
        reply_state: string | null;
      }[]
    >`
    select id, conversation_id, owner_sub, task_id, reply_state from tw_messages where id = ${job.ref}
  `
  ).at(0);
  if (message?.reply_state !== 'pending') return;
  const teammate = (
    await deps.sql<{ id: string; name: string; role: string; instructions: string }[]>`
    select t.id, t.name, t.role, t.instructions from tw_conversations c join tw_teammates t on t.id = c.teammate_id
    where c.id = ${message.conversation_id} and c.owner_sub = ${message.owner_sub}
  `
  ).at(0);
  if (teammate === undefined) return;
  const history = await deps.sql<{ role: string; body: string }[]>`
    select role, body from (select role, body, created_at from tw_messages where conversation_id = ${message.conversation_id}
      and created_at <= (select created_at from tw_messages where id = ${message.id}) order by created_at desc limit 12) recent
    order by created_at
  `;
  const linked = await deps.sql<
    { id: string; title: string; status: string; latest_revision: number }[]
  >`
    select id, title, status, latest_revision from wb_tasks where kind = 'teamwork' and owner_sub = ${message.owner_sub}
      and (conversation_id = ${message.conversation_id} or id = ${message.task_id}) order by updated_at desc limit 5
  `;
  const connected = await connectedProviders(deps, message.owner_sub);
  const tasks = [];
  for (const task of linked) {
    const sources = (
      await deps.sql<
        { sources: string[] }[]
      >`select sources from tw_assignments where task_id = ${task.id}`
    ).flatMap((r) => r.sources);
    // A summary derived from sources is shared only while the member can still read those sources.
    const needs = new Set(sources.map((s) => (s.startsWith('github') ? 'github' : 'google')));
    const readable = [...needs].every((provider) => connected.has(provider));
    const latest =
      readable && task.latest_revision > 0
        ? ((
            await deps.sql<
              { summary: string }[]
            >`select content->>'summary' as summary from tw_revisions where task_id = ${task.id} and revision = ${task.latest_revision}`
          ).at(0)?.summary ?? null)
        : null;
    tasks.push({ title: task.title, status: task.status, summary: latest });
  }
  const skills = (await teammateSkills(deps.sql, [teammate.id])).get(teammate.id) ?? [];
  try {
    const result = await deps.gate.generate(
      { taskId: message.task_id, assignmentId: null, purpose: 'reply' },
      replyRequest({
        teammate,
        skills: skills.map((s) => s.name),
        history: history.map((h) => ({ role: h.role, text: h.body })),
        tasks,
      }),
    );
    await deps.sql.begin(async (tx) => {
      await postMessage(deps, tx, {
        conversationId: message.conversation_id,
        ownerSub: message.owner_sub,
        role: 'teammate',
        body: result.text.trim().slice(0, 4000) || '(no reply)',
        taskId: message.task_id,
      });
      await tx`update tw_messages set reply_state = 'done' where id = ${message.id}`;
      if (message.task_id !== null) await touchTask(deps, tx, message.task_id);
    });
  } catch (error) {
    const failure = modelFailure(error);
    if (failure === undefined) throw error;
    await deps.sql.begin(async (tx) => {
      await postMessage(deps, tx, {
        conversationId: message.conversation_id,
        ownerSub: message.owner_sub,
        role: 'system',
        body: `${teammate.name} could not reply: ${failure.message}`,
        taskId: message.task_id,
      });
      await tx`update tw_messages set reply_state = 'failed' where id = ${message.id}`;
    });
  }
}

const HANDLERS: Record<Job['kind'], (deps: Deps, job: Job) => Promise<void>> = {
  plan,
  assignment: runAssignment,
  synthesis: synthesize,
  publish,
  reply,
};

async function quarantineAssignment(deps: Deps, ref: string): Promise<void> {
  const assignment = (
    await deps.sql<
      AssignmentRow[]
    >`select * from tw_assignments where id = ${ref.split(':')[0] ?? ''}`
  ).at(0);
  if (
    assignment !== undefined &&
    (assignment.status === 'running' || assignment.status === 'queued')
  )
    await failAssignment(
      deps,
      assignment,
      'failed',
      'internal_error',
      'An internal error stopped this assignment. Retry it; reads are safe to repeat.',
    );
}

/** An unexpected error must end the subject, or the next claim re-spends model calls forever. */
async function quarantine(deps: Deps, job: Job): Promise<void> {
  if (job.kind === 'assignment') return quarantineAssignment(deps, job.ref);
  if (job.kind === 'reply') {
    // A failed reply is the conversation's problem; the task it may mention is untouched.
    await deps.sql`update tw_messages set reply_state = 'failed' where id = ${job.ref} and reply_state = 'pending'`;
    return;
  }
  if (job.task_id === null) return;
  const task = await readTask(deps.sql, undefined, job.task_id);
  if (task === undefined) return;
  if (job.kind === 'publish' && task.status === 'publishing') {
    await deps.sql`update wb_actions set status = 'uncertain', updated_at = ${deps.now()} where approval_id = ${job.ref}`;
    await withTask(deps, undefined, task.id, async (tx, locked) => {
      if (locked.status === 'publishing')
        await moveTask(deps, tx, locked, {
          to: 'outcome_uncertain',
          events: [
            {
              type: 'action.uncertain',
              summary:
                'An internal error interrupted the write. Check for the document before retrying.',
            },
          ],
          error: { code: 'outcome_uncertain', message: 'An internal error interrupted the write.' },
        });
    });
    return;
  }
  const stage = job.kind === 'plan' ? 'planning' : 'synthesis';
  await failTask(deps, task.id, job.kind === 'plan' ? 'planning' : 'synthesizing', stage, {
    code: 'internal_error',
    message: 'An internal error stopped this step. Retry it.',
  });
}

export type Worker = { start(): void; stop(): Promise<void>; drain(): Promise<void> };

/** `concurrency` independent claim loops; each runs one job at a time, so at most N model calls fly. */
export function createWorker(deps: Deps, onError: (error: unknown) => void, pollMs = 400): Worker {
  let stopping = false;

  async function runOne(): Promise<boolean> {
    const job = await claim(deps);
    if (job === undefined) return false;
    try {
      await HANDLERS[job.kind](deps, job);
    } catch (error) {
      onError(error);
      await quarantine(deps, job).catch(onError);
    } finally {
      await finish(deps, job);
    }
    return true;
  }

  // Each loop works until the queue is empty, then sleeps `pollMs`; stop() aborts that sleep.
  const loops = Array.from({ length: deps.config.concurrency }, () =>
    createScheduleWorker(
      {
        async tick() {
          while (!stopping && (await runOne()));
        },
      },
      onError,
      pollMs,
    ),
  );

  return {
    start() {
      stopping = false;
      // One API process serves a segment, so a job still marked running at start belongs to a
      // process that died. Expiring its lease lets it resume now instead of after LEASE_SECONDS.
      void deps.sql`update tw_jobs set lease_until = now() where state = 'running'`
        .catch(onError)
        .finally(() => {
          for (const loop of loops) loop.start();
        });
    },
    async stop() {
      stopping = true;
      await Promise.all(loops.map((loop) => loop.stop()));
    },
    async drain() {
      while (await runOne());
    },
  };
}
