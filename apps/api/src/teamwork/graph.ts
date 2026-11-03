import { canonicalPayloadSha256 } from '@agent-works/domain';
import { evaluateGraphCas } from '@agent-works/domain/teamwork-graph-contract';

import { Conflict } from './context.js';

import type { Deps } from './context.js';
import type { AssignmentRow } from './store.js';
import type { PlanContent } from '@agent-works/domain/teamwork';
import type { GraphCas, GraphRevision } from '@agent-works/domain/teamwork-graph-contract';
import type postgres from 'postgres';

type Db = postgres.Sql | postgres.TransactionSql;
type PlanNode = PlanContent['assignments'][number];

/**
 * The committed propagation policy of the task graph. It is data so a test can pin it and a reader
 * can find it in one place; the code paths named here are the only ones that apply it.
 *
 * - `failure`: a node that can no longer succeed (failed, timed out, cancelled or retired) fails every
 *   unfinished dependent with `dependency_failed` (logical state `blocked`, reason
 *   `prerequisite_failed`), transitively. A dependent that already succeeded keeps its effect.
 *   Nothing is skipped silently: when no node can run, the task moves to `needs_input` so the member
 *   can retry, proceed without the node, or replan.
 * - `cancel`: a cancelled task cancels every queued, retrying and waiting node and its queued jobs. A
 *   running node finishes its step and is cancelled at the boundary; nothing is published.
 * - `rerun`: a completed node is never reset. A rerun supersedes it and creates a new node.
 */
export const PROPAGATION_POLICY = {
  failure: 'block_unfinished_dependents',
  cancel: 'cancel_unstarted_finish_step',
  rerun: 'new_node_supersede_old',
} as const;

/** The most nodes a plan may hold (`planContentSchema`). */
export const MAX_PLAN_NODES = 4;

/** Automatic retry of a node whose model call failed transiently. Member retry is unaffected. */
export const RETRY_POLICY = {
  maxAutomaticAttempts: 3,
  baseDelayMs: 30_000,
  factor: 2,
  retryableModelCodes: ['rate_limited', 'timeout', 'unreachable', 'unavailable'],
} as const;

export function isAutomaticallyRetryable(code: string, attempt: number): boolean {
  return (
    (RETRY_POLICY.retryableModelCodes as readonly string[]).includes(code) &&
    attempt < RETRY_POLICY.maxAutomaticAttempts
  );
}

/** The earliest time the next attempt may start, after `attempt` attempts have failed. */
export function retryNotBefore(now: Date, attempt: number): Date {
  const delay = RETRY_POLICY.baseDelayMs * RETRY_POLICY.factor ** (attempt - 1);
  return new Date(now.getTime() + delay);
}

// ---------------------------------------------------------------------------------------------
// Compare-and-swap.

/** Runs the frozen CAS rule against the live revision and refuses with its outcome as the code. */
export function assertGraphCas(current: GraphRevision | undefined, request: GraphCas): void {
  if (current === undefined) throw new Conflict('not_live');
  const outcome = evaluateGraphCas(current, request);
  if (outcome !== 'apply') throw new Conflict(outcome);
}

// ---------------------------------------------------------------------------------------------
// Completed effects are immutable.

const withoutAttachments = (sources: readonly string[]): string[] =>
  sources.filter((source) => source !== 'member_file').sort();

/** What a node means to the member: changing any of it is a different effect. */
function nodeDigest(node: {
  readonly teammateId: string;
  readonly brief: string;
  readonly deliverable: string;
  readonly sources: readonly string[];
  readonly dependsOn: readonly string[];
}): string {
  return canonicalPayloadSha256({
    teammateId: node.teammateId,
    brief: node.brief,
    deliverable: node.deliverable,
    sources: withoutAttachments(node.sources),
    dependsOn: [...node.dependsOn].sort(),
  });
}

const rowDigest = (row: AssignmentRow): string =>
  nodeDigest({
    teammateId: row.teammate_id,
    brief: row.brief,
    deliverable: row.deliverable,
    sources: row.sources,
    dependsOn: row.depends_on,
  });

export const completedNodes = (rows: readonly AssignmentRow[]): readonly AssignmentRow[] =>
  rows.filter((row) => row.status === 'succeeded');

/** Keys of completed nodes that the content drops or redefines. A non-empty result refuses the edit. */
export function completedViolations(
  content: PlanContent,
  completed: readonly AssignmentRow[],
): string[] {
  const proposed = new Map(content.assignments.map((node) => [node.key, nodeDigest(node)]));
  return completed.filter((row) => proposed.get(row.key) !== rowDigest(row)).map((row) => row.key);
}

/**
 * Forces every completed node back to its stored definition, appending any the content dropped.
 * Used for a coordinator replan, which cannot be made to respect completed work any other way.
 * Over the node limit, new nodes are the ones dropped.
 */
export function pinCompleted(
  content: PlanContent,
  completed: readonly AssignmentRow[],
  limit: number,
): PlanContent {
  const done = new Set(completed.map((row) => row.key));
  const pinned: PlanNode[] = completed.map((row) => ({
    key: row.key,
    teammateId: row.teammate_id,
    brief: row.brief,
    deliverable: row.deliverable,
    sources: withoutAttachments(row.sources) as PlanNode['sources'],
    dependsOn: row.depends_on,
  }));
  const rest = content.assignments.filter((node) => !done.has(node.key));
  const assignments = [...pinned, ...rest].slice(0, limit);
  const keys = new Set(assignments.map((node) => node.key));
  return {
    ...content,
    assignments: assignments.map((node) => ({
      ...node,
      dependsOn: node.dependsOn.filter((key) => keys.has(key)),
    })),
  };
}

// ---------------------------------------------------------------------------------------------
// Failure propagation.

const WAITING = new Set(['queued', 'running', 'needs_input', 'succeeded']);

/**
 * The queued nodes that can no longer run because a prerequisite failed, timed out, was cancelled or
 * is gone. A blocked node blocks its own dependents, so this runs to a fixed point.
 */
export function blockedDependents(live: readonly AssignmentRow[]): readonly AssignmentRow[] {
  const status = new Map(live.map((row) => [row.key, row.status as string]));
  const blocked: AssignmentRow[] = [];
  let grew = true;
  while (grew) {
    grew = false;
    for (const row of live) {
      if (status.get(row.key) !== 'queued' || row.depends_on.length === 0) continue;
      const lost = row.depends_on.some((key) => !WAITING.has(status.get(key) ?? ''));
      if (!lost) continue;
      status.set(row.key, 'failed');
      blocked.push(row);
      grew = true;
    }
  }
  return blocked;
}

// ---------------------------------------------------------------------------------------------
// Fenced node claim. This is the port a lease-based claimer (SCH-05) plugs into: it hands out at
// most one token per running node, and a writer without the current token cannot settle the node.

export type NodeClaims = {
  /** Queued to running, once. Undefined means another owner holds it or it is not claimable. */
  claim(nodeId: string, now: Date): Promise<AssignmentRow | undefined>;
  /** Replaces the token of a running node after its owner died. The old owner is fenced out. */
  takeOver(nodeId: string): Promise<AssignmentRow | undefined>;
};

/** A node is claimable only when its prerequisites all succeeded and its backoff has passed. */
export function createNodeClaims(sql: Db, deps: Pick<Deps, 'config'>): NodeClaims {
  return {
    async claim(nodeId, now) {
      const rows = await sql<AssignmentRow[]>`
        update tw_assignments a set status = 'running', owner_token = gen_random_uuid(),
          retry_not_before = null, started_at = ${now}, updated_at = ${now}, finished_at = null,
          deadline_at = ${new Date(now.getTime() + deps.config.assignmentDeadlineMs)}
        where a.id = ${nodeId} and a.status = 'queued'
          and (a.retry_not_before is null or a.retry_not_before <= ${now})
          and not exists (
            select 1 from jsonb_array_elements_text(a.depends_on) as dep(key)
            where not exists (
              select 1 from tw_assignments p
              where p.task_id = a.task_id and p.key = dep.key and p.status = 'succeeded'
            )
          )
        returning a.*
      `;
      return rows.at(0);
    },
    async takeOver(nodeId) {
      const rows = await sql<AssignmentRow[]>`
        update tw_assignments set owner_token = gen_random_uuid(), updated_at = now()
        where id = ${nodeId} and status = 'running'
        returning *
      `;
      return rows.at(0);
    },
  };
}
