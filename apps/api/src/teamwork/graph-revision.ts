import { Conflict, audit } from './context.js';
import { assertGraphCas } from './graph.js';
import {
  appendEvent,
  assignmentsFor,
  cancelJobs,
  latestPlanVersion,
  moveAssignment,
  moveTask,
  readTask,
  supersedeLivePlan,
  touchTask,
  withTask,
} from './store.js';
import { checkPlan, planDigest, summary } from './tasks.js';

import type { Deps, Member } from './context.js';
import type { PlanContent, TaskSummary } from '@agent-works/domain/teamwork';
import type { GraphCas, GraphRevision } from '@agent-works/domain/teamwork-graph-contract';

type LivePlan = {
  version: number;
  digest: string;
  state: GraphRevision['state'];
};

/**
 * Edits the live graph under compare-and-swap. The caller names the revision and digest it read; a
 * stale revision, a changed digest or a graph that is no longer live is refused with that outcome
 * and nothing is written. The edit is one transaction, so a coordinator that dies part way leaves
 * the last committed graph as it was.
 *
 * Allowed while the member decides (`plan_review`) or when nothing is left to run (`needs_input`).
 * Completed nodes cannot be dropped or redefined (`checkPlan` refuses with `completed_node_changed`),
 * and unfinished nodes of the previous revision are superseded, so approving the new revision runs
 * only what is new. The new revision is `proposed`: the member reviews it before anything runs.
 */
export async function reviseGraph(
  deps: Deps,
  member: Member,
  taskId: string,
  input: { readonly cas: GraphCas; readonly content: PlanContent },
): Promise<TaskSummary> {
  const outcome = await withTask(deps, member.sub, taskId, async (tx, task) => {
    if (task.status !== 'plan_review' && task.status !== 'needs_input')
      throw new Conflict(`cannot_revise_graph_${task.status}`);
    const live = (
      await tx<LivePlan[]>`
        select version, digest, state from tw_plans
        where task_id = ${taskId} and state in ('proposed', 'approved') for update
      `
    ).at(0);
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
    const capabilities = await checkPlan(deps, tx, task, member, input.content);
    await supersedeLivePlan(tx, taskId);
    const version = (await latestPlanVersion(tx, taskId)) + 1;
    await tx`
      insert into tw_plans (task_id, version, author, content, capabilities, digest, state, created_at)
      values (${taskId}, ${version}, 'member', ${tx.json(input.content)}, ${tx.json([...capabilities])},
        ${planDigest(input.content, capabilities)}, 'proposed', ${deps.now()})
    `;
    for (const node of await assignmentsFor(tx, taskId))
      if (node.status !== 'succeeded' && node.status !== 'cancelled')
        await moveAssignment(deps, tx, node, 'superseded');
    await cancelJobs(deps, tx, taskId);
    await appendEvent(deps, tx, taskId, {
      type: 'plan.edited',
      summary: `You edited the graph (version ${version}). Completed work is kept; review the rest before it runs.`,
      detail: { planVersion: version, baseRevision: input.cas.baseRevision },
    });
    if (task.status === 'needs_input')
      await moveTask(deps, tx, task, { to: 'plan_review', events: [] });
    else await touchTask(deps, tx, taskId);
    await audit(deps, tx, {
      ownerSub: member.sub,
      taskId,
      action: 'graph.revise',
      outcome: 'applied',
      detail: { version },
    });
    return true;
  });
  const row = outcome === undefined ? undefined : await readTask(deps.sql, member.sub, taskId);
  if (row === undefined) throw new Conflict('not_found', 404);
  return summary(row);
}
