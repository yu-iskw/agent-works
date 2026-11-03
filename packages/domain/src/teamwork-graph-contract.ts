import * as z from 'zod';

import { sha256DigestSchema } from './canonical-hash.js';

import type { AssignmentStatus, TeamworkStatus } from './teamwork.js';

/**
 * AGT-00 frozen contract for the versioned task graph (AGT-01 execution, AGT-02 proposals, AGT-07
 * projection). It adds no stored status: every logical state is derived from names that already
 * exist (`tw_assignments.status`, `depends_on`, `attempt`, the task status and `tw_plans`).
 * The tenancy boundary is the segment process and database; nothing here carries a workspace id.
 */
export const GRAPH_CONTRACT_VERSION = 'teamwork.graph.v1';

const key = z.string().regex(/^[a-z][a-z0-9-]{0,30}$/);
const at = z.iso.datetime({ offset: true });

// ---------------------------------------------------------------------------------------------
// Graph revision and compare-and-swap. A graph revision is a `tw_plans` row: `revision` is
// `tw_plans.version`, `digest` is `tw_plans.digest`, `state` is `tw_plans.state`.

const GRAPH_REVISION_STATES = ['proposed', 'approved', 'rejected', 'superseded'] as const;

export const graphRevisionSchema = z.strictObject({
  taskId: z.uuid(),
  revision: z.number().int().positive(),
  digest: sha256DigestSchema,
  parentRevision: z.number().int().positive().nullable(),
  state: z.enum(GRAPH_REVISION_STATES),
});
export type GraphRevision = z.infer<typeof graphRevisionSchema>;

/** Every graph write and every UI mutation names the revision it was based on. */
export const graphCasSchema = z.strictObject({
  taskId: z.uuid(),
  baseRevision: z.number().int().positive(),
  expectedDigest: sha256DigestSchema,
});
export type GraphCas = z.infer<typeof graphCasSchema>;

export const CAS_OUTCOMES = ['apply', 'stale_revision', 'digest_mismatch', 'not_live'] as const;
export type CasOutcome = (typeof CAS_OUTCOMES)[number];

const LIVE_STATES: ReadonlySet<GraphRevision['state']> = new Set(['proposed', 'approved']);

/**
 * The pure rule a SQL `update ... where version = $base and digest = $digest and state in live`
 * must agree with. Only `apply` may write; every other outcome leaves the graph untouched.
 */
export function evaluateGraphCas(current: GraphRevision, request: GraphCas): CasOutcome {
  if (current.taskId !== request.taskId || current.revision !== request.baseRevision)
    return 'stale_revision';
  if (current.digest !== request.expectedDigest) return 'digest_mismatch';
  return LIVE_STATES.has(current.state) ? 'apply' : 'not_live';
}

// ---------------------------------------------------------------------------------------------
// Logical node states.

export const NODE_STATES = [
  'blocked',
  'ready',
  'running',
  'succeeded',
  'retry_wait',
  'failed',
  'awaiting_approval',
  'uncertain',
  'cancelled',
] as const;
export const nodeStateSchema = z.enum(NODE_STATES);
export type NodeState = z.infer<typeof nodeStateSchema>;

/**
 * Legal moves. `ready -> running` is the fenced claim. A completed effect is immutable, so
 * `succeeded` and `cancelled` have no way out; `failed -> ready` is the explicit new attempt.
 * `uncertain` resolves only by reconciling the same effect, never by replaying it.
 */
export const NODE_STATE_TRANSITIONS: Readonly<Record<NodeState, readonly NodeState[]>> = {
  blocked: ['ready', 'cancelled'],
  ready: ['running', 'blocked', 'cancelled'],
  running: [
    'succeeded',
    'retry_wait',
    'failed',
    'awaiting_approval',
    'uncertain',
    'cancelled',
    'ready',
  ],
  retry_wait: ['ready', 'failed', 'cancelled'],
  awaiting_approval: ['ready', 'cancelled', 'failed'],
  uncertain: ['succeeded', 'failed', 'running'],
  failed: ['ready', 'cancelled'],
  succeeded: [],
  cancelled: [],
};

export function canNodeTransition(from: NodeState, to: NodeState): boolean {
  // eslint-disable-next-line security/detect-object-injection
  return NODE_STATE_TRANSITIONS[from].includes(to);
}

export const TERMINAL_NODE_STATES: ReadonlySet<NodeState> = new Set(['succeeded', 'cancelled']);

/** Why a node is not progressing. `reason` is a closed code; free text never reaches the UI. */
export const NODE_REASONS = [
  'prerequisite_pending',
  'prerequisite_failed',
  'plan_not_approved',
  'retry_backoff',
  'member_input',
  'publish_approval',
  'effect_unconfirmed',
] as const;
export const nodeReasonSchema = z.enum(NODE_REASONS);
export type NodeReason = z.infer<typeof nodeReasonSchema>;

export const REASONS_FOR_STATE: Readonly<Record<NodeState, readonly NodeReason[]>> = {
  blocked: ['prerequisite_pending', 'prerequisite_failed', 'plan_not_approved'],
  ready: [],
  running: [],
  succeeded: [],
  retry_wait: ['retry_backoff'],
  failed: [],
  awaiting_approval: ['member_input', 'publish_approval'],
  uncertain: ['effect_unconfirmed'],
  cancelled: [],
};

// ---------------------------------------------------------------------------------------------
// Mapping onto existing names.

/**
 * Which logical states a stored `tw_assignments.status` can stand for. `queued` is the one stored
 * status that hides three logical states. `superseded` is history of an earlier graph revision
 * and is not a node of the current graph at all.
 */
export const ASSIGNMENT_STATUS_LOGICAL: Readonly<Record<AssignmentStatus, readonly NodeState[]>> = {
  queued: ['blocked', 'ready', 'retry_wait'],
  running: ['running', 'uncertain'],
  needs_input: ['awaiting_approval'],
  succeeded: ['succeeded'],
  failed: ['failed', 'blocked', 'uncertain'],
  timed_out: ['failed', 'blocked', 'uncertain'],
  cancelled: ['cancelled'],
  superseded: [],
};

/**
 * Task-level stages that have no assignment row but are nodes of the same graph (the publish
 * step). Other task statuses are not mapped: AGT-01 owns whether synthesis becomes a node.
 */
export const STAGE_STATUS_LOGICAL: Partial<Readonly<Record<TeamworkStatus, NodeState>>> = {
  awaiting_action_approval: 'awaiting_approval',
  publishing: 'running',
  outcome_uncertain: 'uncertain',
};

/** The stored error code the worker writes when a prerequisite can no longer succeed. */
const DEPENDENCY_FAILED_CODE = 'dependency_failed';

export type NodeFacts = {
  readonly status: AssignmentStatus;
  readonly errorCode: string | null;
  readonly dependenciesSatisfied: boolean;
  /**
   * Earliest next attempt. GAP: no column stores it today, so callers pass null until AGT-01 adds
   * retry scheduling; a `queued` node is then never `retry_wait`.
   */
  readonly retryNotBefore: string | null;
  /** The effect may have happened but was not confirmed (publish `outcome_uncertain`). */
  readonly effectUnconfirmed: boolean;
  readonly now: string;
};

function queuedState(facts: NodeFacts): NodeState {
  if (!facts.dependenciesSatisfied) return 'blocked';
  const waiting =
    facts.retryNotBefore !== null && Date.parse(facts.retryNotBefore) > Date.parse(facts.now);
  return waiting ? 'retry_wait' : 'ready';
}

function stoppedState(facts: NodeFacts): NodeState {
  if (facts.errorCode === DEPENDENCY_FAILED_CODE) return 'blocked';
  return facts.effectUnconfirmed ? 'uncertain' : 'failed';
}

/** The logical state of one assignment node, or null for a superseded one. */
export function logicalNodeState(facts: NodeFacts): NodeState | null {
  switch (facts.status) {
    case 'queued':
      return queuedState(facts);
    case 'running':
      return facts.effectUnconfirmed ? 'uncertain' : 'running';
    case 'needs_input':
      return 'awaiting_approval';
    case 'succeeded':
      return 'succeeded';
    case 'cancelled':
      return 'cancelled';
    case 'failed':
    case 'timed_out':
      return stoppedState(facts);
    case 'superseded':
      return null;
  }
}

const DEFAULT_REASON: Readonly<Record<NodeState, NodeReason | null>> = {
  blocked: 'prerequisite_pending',
  ready: null,
  running: null,
  succeeded: null,
  retry_wait: 'retry_backoff',
  failed: null,
  awaiting_approval: 'member_input',
  uncertain: 'effect_unconfirmed',
  cancelled: null,
};

/** The reason for a state; a publish wait passes `publish_approval` itself. */
export function reasonFor(state: NodeState, facts: NodeFacts): NodeReason | null {
  if (state === 'blocked' && facts.errorCode === DEPENDENCY_FAILED_CODE)
    return 'prerequisite_failed';
  // eslint-disable-next-line security/detect-object-injection
  return DEFAULT_REASON[state];
}

/**
 * Edges of today's `ASSIGNMENT_TRANSITIONS` that the frozen table does not allow. Each is a
 * documented divergence, not a bug fixed here: AGT-01 removes or fences them.
 */
export const KNOWN_ASSIGNMENT_DIVERGENCES: readonly (readonly [
  AssignmentStatus,
  AssignmentStatus,
])[] = [
  // A succeeded node is re-queued by rescope/revision (`followUpRescope`, `requeue`): a replay.
  ['succeeded', 'queued'],
];

// ---------------------------------------------------------------------------------------------
// UI projection. Strict objects, so a field that is not listed here cannot reach the browser.

export const projectionNodeSchema = z
  .strictObject({
    key,
    title: z.string().trim().min(1).max(200),
    state: nodeStateSchema,
    reason: nodeReasonSchema.nullable(),
    /** Visible prerequisites only; an inaccessible one is dropped, not masked. */
    dependsOn: z.array(key).max(5),
    attempt: z.number().int().positive(),
    retryAt: at.nullable(),
    approval: z
      .strictObject({
        id: z.string().min(1),
        kind: z.enum(['publish', 'input']),
        requestedAt: at,
      })
      .nullable(),
    updatedAt: at,
    /** Present only when the caller may open the result; an href is never a bare storage path. */
    result: z
      .strictObject({ href: z.string().min(1), label: z.string().min(1).max(120) })
      .nullable(),
  })
  .refine((node) => node.reason === null || REASONS_FOR_STATE[node.state].includes(node.reason), {
    path: ['reason'],
    message: 'reason does not belong to this state',
  })
  .refine((node) => node.state !== 'awaiting_approval' || node.approval !== null, {
    path: ['approval'],
    message: 'an awaiting_approval node names what it waits for',
  });
export type ProjectionNode = z.infer<typeof projectionNodeSchema>;

export const graphProjectionSchema = z.strictObject({
  contractVersion: z.literal(GRAPH_CONTRACT_VERSION),
  taskId: z.uuid(),
  /** The graph revision (`tw_plans.version`) these nodes belong to. */
  serverRevision: z.number().int().positive(),
  /** `wb_tasks.version`, bumped by every task write; orders updates within a revision. */
  taskVersion: z.number().int().positive(),
  digest: sha256DigestSchema,
  updatedAt: at,
  nodes: z.array(projectionNodeSchema).max(200),
});
export type GraphProjection = z.infer<typeof graphProjectionSchema>;

export type CandidateNode = {
  readonly node: ProjectionNode;
  /** Whether the caller may know this node exists. */
  readonly accessible: boolean;
  readonly resultAuthorized: boolean;
};

/**
 * Builds the response the caller may see. An inaccessible node is omitted, with no placeholder or
 * count, and no remaining node names it as a prerequisite.
 */
export function visibleNodes(candidates: readonly CandidateNode[]): readonly ProjectionNode[] {
  const visible = new Set(candidates.filter((c) => c.accessible).map((c) => c.node.key));
  return candidates
    .filter((c) => c.accessible)
    .map(({ node, resultAuthorized }) => ({
      ...node,
      dependsOn: node.dependsOn.filter((dep) => visible.has(dep)),
      result: resultAuthorized ? node.result : null,
    }));
}

/** Ordering for events that arrive out of order or after a reconnect. */
export function isNewerProjection(
  held: Pick<GraphProjection, 'serverRevision' | 'taskVersion'> | undefined,
  incoming: Pick<GraphProjection, 'serverRevision' | 'taskVersion'>,
): boolean {
  if (held === undefined) return true;
  if (incoming.serverRevision !== held.serverRevision)
    return incoming.serverRevision > held.serverRevision;
  return incoming.taskVersion > held.taskVersion;
}

/** What a UI mutation carries; the server runs `evaluateGraphCas` before doing anything. */
export const graphMutationSchema = z.strictObject({
  clientRequestId: z.uuid(),
  cas: graphCasSchema,
  taskVersion: z.number().int().positive(),
});
