import {
  TEAMWORK_API_VERSION,
  UUID_PATTERN,
  type AssignmentStatus,
  type PlanContent,
} from '@agent-works/domain/teamwork';
import {
  STAGE_STATUS_LOGICAL,
  graphMutationSchema,
  graphProjectionSchema,
  logicalNodeState,
  reasonFor,
  visibleNodes,
  GRAPH_CONTRACT_VERSION,
} from '@agent-works/domain/teamwork-graph-contract';

import { Conflict, audit } from './context.js';
import { assertGraphCas } from './graph.js';
import { readTask } from './store.js';
import { cancelTask, decidePlan } from './tasks.js';

import type { Deps, Member, Reply, Request, Tx } from './context.js';
import type {
  CandidateNode,
  GraphProjection,
  NodeFacts,
  NodeReason,
  NodeState,
  ProjectionNode,
} from '@agent-works/domain/teamwork-graph-contract';
import type postgres from 'postgres';

/**
 * Read-only projection of a task's dependency graph for the status UI, plus the two guarded
 * mutations the UI offers. The browser gets only what `graphProjectionSchema` lists: titles, closed
 * state and reason codes, retry time, approval needs and a same-origin result link. Briefs, outputs,
 * questions and error text never leave the database. A node the caller may not know exists is
 * omitted by `visibleNodes`, with no placeholder and no count.
 */

type PlanRow = { version: number; digest: string; state: 'proposed' | 'approved' };

type NodeRow = {
  key: string;
  teammate_id: string;
  deliverable: string;
  status: AssignmentStatus;
  attempt: number;
  error_code: string | null;
  depends_on: string[];
  retry_not_before: Date | null;
  updated_at: Date;
  has_output: boolean;
};

const iso = (date: Date): string => date.toISOString();
const clip = (text: string): string => text.trim().slice(0, 200) || 'Untitled step';

/** The graph revision a UI mutation or a status view is about: the newest live plan. */
async function livePlan(db: postgres.Sql | Tx, taskId: string): Promise<PlanRow | undefined> {
  const rows = await db<PlanRow[]>`
    select version, digest, state from tw_plans
    where task_id = ${taskId} and state in ('proposed', 'approved') order by version desc limit 1
  `;
  return rows.at(0);
}

/** Which teammates' nodes the caller may know about. Anything else is dropped from the response. */
async function accessibleTeammates(db: postgres.Sql, member: Member): Promise<Set<string>> {
  const rows = await db<
    { id: string }[]
  >`select id from tw_teammates where owner_sub = ${member.sub}`;
  return new Set(rows.map((row) => row.id));
}

function candidateFrom(
  row: NodeRow,
  allDone: ReadonlySet<string>,
  context: { taskId: string; segment: string; revision: number; now: string; resultReady: boolean },
  accessible: boolean,
): CandidateNode {
  const facts: NodeFacts = {
    status: row.status,
    errorCode: row.error_code,
    dependenciesSatisfied: row.depends_on.every((key) => allDone.has(key)),
    retryNotBefore: row.retry_not_before === null ? null : iso(row.retry_not_before),
    effectUnconfirmed: false,
    now: context.now,
  };
  const state = logicalNodeState(facts);
  if (state === null) throw new Error('superseded nodes are filtered before projection');
  const result =
    state === 'succeeded' && row.has_output && context.resultReady
      ? {
          href: `/s/${context.segment}/tasks/${context.taskId}/results/${context.revision}`,
          label: 'Open result',
        }
      : null;
  const node: ProjectionNode = {
    key: row.key,
    title: clip(row.deliverable),
    state,
    reason: reasonFor(state, facts),
    dependsOn: row.depends_on,
    attempt: row.attempt,
    retryAt: state === 'retry_wait' && row.retry_not_before ? iso(row.retry_not_before) : null,
    approval:
      state === 'awaiting_approval'
        ? { id: `input-${row.key}`, kind: 'input', requestedAt: iso(row.updated_at) }
        : null,
    updatedAt: iso(row.updated_at),
    result,
  };
  return { node, accessible, resultAuthorized: result !== null };
}

/** A plan node that has no assignment yet: the member has not approved this revision. */
function proposedCandidate(
  planned: PlanContent['assignments'][number],
  accessible: boolean,
  at: string,
): CandidateNode {
  return {
    accessible,
    resultAuthorized: false,
    node: {
      key: planned.key,
      title: clip(planned.deliverable),
      state: 'blocked',
      reason: 'plan_not_approved',
      dependsOn: planned.dependsOn,
      attempt: 1,
      retryAt: null,
      approval: null,
      updatedAt: at,
      result: null,
    },
  };
}

const STAGE_REASON: Partial<Record<NodeState, NodeReason>> = {
  awaiting_approval: 'publish_approval',
  uncertain: 'effect_unconfirmed',
};

/** The publish step has no assignment row; it is derived from the task status and its approval. */
function publishStage(
  stage: NodeState,
  task: { id: string; updated_at: Date },
  rows: readonly NodeRow[],
  pending: { id: string; requested_at: Date } | undefined,
): CandidateNode {
  const waiting = stage === 'awaiting_approval';
  return {
    accessible: true,
    resultAuthorized: false,
    node: {
      key: 'publish',
      title: 'Publish the result',
      state: stage,
      // eslint-disable-next-line security/detect-object-injection -- stage is a closed NodeState
      reason: STAGE_REASON[stage] ?? null,
      dependsOn: rows.map((row) => row.key),
      attempt: 1,
      retryAt: null,
      approval: waiting
        ? {
            id: pending?.id ?? task.id,
            kind: 'publish',
            requestedAt: iso(pending?.requested_at ?? task.updated_at),
          }
        : null,
      updatedAt: iso(task.updated_at),
      result: null,
    },
  };
}

/**
 * Builds the projection for one owned task, or undefined when the task is not the caller's. `plan`
 * is null while no live plan exists (planning, declined); the UI shows an empty state.
 */
export async function buildProjection(
  deps: Deps,
  member: Member,
  taskId: string,
): Promise<{ projection: GraphProjection | null; taskVersion: number } | undefined> {
  const task = await readTask(deps.sql, member.sub, taskId);
  if (task === undefined) return undefined;
  const plan = await livePlan(deps.sql, taskId);
  if (plan === undefined) return { projection: null, taskVersion: task.version };
  const now = iso(deps.now());
  const [rows, accessibleIds, planContent, approval] = await Promise.all([
    deps.sql<NodeRow[]>`
      select key, teammate_id, deliverable, status, attempt, error_code, depends_on,
        retry_not_before, updated_at, output is not null as has_output
      from tw_assignments
      where task_id = ${taskId} and status <> 'superseded' order by created_at, key
    `,
    accessibleTeammates(deps.sql, member),
    deps.sql<
      { content: PlanContent }[]
    >`select content from tw_plans where task_id = ${taskId} and version = ${plan.version}`,
    deps.sql<
      { id: string; requested_at: Date }[]
    >`select id, requested_at from wb_approvals where task_id = ${taskId} and subject = 'publish' and state = 'pending'`,
  ]);
  const done = new Set(rows.filter((row) => row.status === 'succeeded').map((row) => row.key));
  const context = {
    taskId,
    segment: deps.config.segment,
    revision: task.latest_revision,
    now,
    resultReady: task.latest_revision > 0,
  };
  const candidates: CandidateNode[] = rows.map((row) =>
    candidateFrom(row, done, context, accessibleIds.has(row.teammate_id)),
  );
  if (plan.state === 'proposed') {
    const present = new Set(rows.map((row) => row.key));
    for (const planned of planContent.at(0)?.content.assignments ?? [])
      if (!present.has(planned.key))
        candidates.push(
          proposedCandidate(planned, accessibleIds.has(planned.teammateId), iso(task.updated_at)),
        );
  }
  const stage = STAGE_STATUS_LOGICAL[task.status];
  if (stage !== undefined) candidates.push(publishStage(stage, task, rows, approval.at(0)));
  const projection = graphProjectionSchema.parse({
    contractVersion: GRAPH_CONTRACT_VERSION,
    taskId,
    serverRevision: plan.version,
    taskVersion: task.version,
    digest: plan.digest,
    updatedAt: iso(task.updated_at),
    nodes: visibleNodes(candidates),
  });
  return { projection, taskVersion: task.version };
}

/**
 * The same deps with the open transaction standing in for the pool, so `cancelTask` and `decidePlan`
 * (which open their own `begin`) join the transaction that already holds the task lock.
 */
function joinedTo(deps: Deps, tx: Tx): Deps {
  const begin = <T>(run: (inner: Tx) => Promise<T>): Promise<T> => run(tx);
  const joined = new Proxy(tx, {
    get: (target, property, receiver): unknown =>
      property === 'begin' ? begin : Reflect.get(target, property, receiver),
  });
  return { ...deps, sql: joined as unknown as postgres.Sql };
}

export type GraphAction = 'cancel' | 'approve';

/**
 * A UI mutation under compare-and-swap. The task row is locked, the caller's revision and digest
 * are checked against the live plan, and the action runs in the same transaction, so a stale view
 * can neither act on a newer graph nor run the action twice: the second attempt finds the task
 * already cancelled or the plan already decided and is refused.
 */
export async function mutateGraph(
  deps: Deps,
  member: Member,
  taskId: string,
  action: GraphAction,
  input: ReturnType<typeof graphMutationSchema.parse>,
): Promise<void> {
  if (input.cas.taskId !== taskId) throw new Conflict('stale_revision');
  try {
    const found = await deps.sql.begin(async (tx) => {
      const task = await readTask(tx, member.sub, taskId, { lock: true });
      if (task === undefined) return false;
      const live = await livePlan(tx, taskId);
      assertGraphCas(
        live === undefined
          ? undefined
          : {
              taskId,
              revision: live.version,
              digest: live.digest,
              parentRevision: null,
              state: live.state,
            },
        input.cas,
      );
      const bound = joinedTo(deps, tx);
      if (action === 'cancel') await cancelTask(bound, member, taskId);
      else
        await decidePlan(bound, member, taskId, {
          version: input.cas.baseRevision,
          expectedDigest: input.cas.expectedDigest,
          decision: 'approve',
        });
      await audit(deps, tx, {
        ownerSub: member.sub,
        taskId,
        action: `graph.${action}`,
        outcome: 'applied',
        detail: { revision: input.cas.baseRevision, clientRequestId: input.clientRequestId },
      });
      return true;
    });
    if (!found) throw new Conflict('not_found', 404);
  } catch (error) {
    if (error instanceof Conflict && error.status === 409)
      await audit(deps, deps.sql, {
        ownerSub: member.sub,
        taskId,
        action: `graph.${action}`,
        outcome: error.code,
        detail: { revision: input.cas.baseRevision, clientRequestId: input.clientRequestId },
      });
    throw error;
  }
}

type Handler = (
  ctx: { deps: Deps; member: Member; request: Request },
  params: readonly string[],
) => Promise<Reply>;
export type ProjectionRoute = {
  readonly method: 'GET' | 'POST';
  readonly path: RegExp;
  readonly handle: Handler;
};

const ok = (deps: Deps, body: object): Reply => ({
  status: 200,
  body: { apiVersion: TEAMWORK_API_VERSION, segment: deps.config.segment, ...body },
});
const notFound: Reply = { status: 404, body: { error: 'not_found' } };

function mutation(request: Request): ReturnType<typeof graphMutationSchema.parse> {
  let raw: unknown;
  try {
    raw = JSON.parse(request.body.toString('utf8')) as unknown;
  } catch {
    throw new Conflict('invalid_request', 400);
  }
  const parsed = graphMutationSchema.safeParse(raw);
  if (!parsed.success) throw new Conflict('invalid_request', 400);
  return parsed.data;
}

/**
 * Route factory. The coordinator spreads it into the table in `createRoutes`, which already
 * authenticates, checks membership and demands the CSRF header before any entry runs.
 */
export function projectionRoutes(): readonly ProjectionRoute[] {
  const prefix = `^/v1/teamwork/tasks/(${UUID_PATTERN})/graph`;
  const route = (action: GraphAction): ProjectionRoute => ({
    method: 'POST',
    // eslint-disable-next-line security/detect-non-literal-regexp
    path: new RegExp(`${prefix}/${action}$`),
    handle: async ({ deps, member, request }, [id]) => {
      await mutateGraph(deps, member, id, action, mutation(request));
      const built = await buildProjection(deps, member, id);
      return built === undefined ? notFound : ok(deps, built);
    },
  });
  return [
    {
      method: 'GET',
      // eslint-disable-next-line security/detect-non-literal-regexp
      path: new RegExp(`${prefix}$`),
      handle: async ({ deps, member }, [id]) => {
        const built = await buildProjection(deps, member, id);
        return built === undefined ? notFound : ok(deps, built);
      },
    },
    route('cancel'),
    route('approve'),
  ];
}
