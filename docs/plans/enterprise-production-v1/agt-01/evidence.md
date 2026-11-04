# AGT-01 evidence: versioned deterministic DAG execution

Base: origin/epv1/integration. All results local (Postgres via Docker). Nothing live. Not VALIDATED.

| Criterion                                               | Test (`apps/api/src/teamwork/graph.test.ts` unless noted)                                                                                    | Result |
| ------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| Cycle / dangling edge rejected                          | "rejects a stale revision, a changed digest, a cycle and a dangling edge, writing nothing"                                                   | PASS   |
| Revision conflict rejected (stale / digest / live)      | same test; pure `assertGraphCas` outcomes in "maps every CAS outcome"                                                                        | PASS   |
| Parallel claims yield one owner (12 racers x 8)         | "lets exactly one of twelve racers claim a node, in every round"; "eight workers drain together" (1 model call each)                         | PASS   |
| Dead owner fenced out                                   | "fences out a dead owner..."; "resumes a node whose worker died, once"                                                                       | PASS   |
| Coordinator crash preserves last committed graph        | "leaves the last committed graph when the editor dies inside the transaction"; `recoverGraphs` test                                          | PASS   |
| Failed prerequisite blocks dependents, task replannable | "blocks a dependent of a failed prerequisite..."; `graph.characterization.test.ts` (defect pin updated)                                      | PASS   |
| Edited graph cannot replay a completed effect           | "refuses an edit that drops or redefines a completed node"; "keeps the completed node untouched..."; coordinator replan pins completed nodes | PASS   |
| retry_wait with stored not-before                       | "stores a not-before time, holds the job until then, and ends in failure after the last attempt"; cancel while waiting                       | PASS   |
| Cancellation propagation                                | "cancels every unstarted node of a chain and its jobs"                                                                                       | PASS   |
| Rerun is a new node (divergence removed)                | "supersedes the finished node with its effect intact"; contract test now expects zero divergences                                            | PASS   |

Mutation check: removing `a.status = 'queued'` from `claim` in `graph.ts` made "lets exactly one of twelve racers" fail (more than one winner); restored, test passes.

## Decisions

- Defect fix: `ASSIGNMENT_TRANSITIONS.queued` gains `failed`. `blockedDependents` fails dependents transitively with `dependency_failed` (logical `blocked`, reason `prerequisite_failed`). The task then reaches `needs_input`, where replan and retry work.
- Divergence: `followUpRescope` now calls `rerunAsNewNode` (old node superseded, output and `finished_at` kept, fresh node attempt+1). `succeeded -> queued` removed; `KNOWN_ASSIGNMENT_DIVERGENCES` is empty. Unique index `tw_assignments_live_key` allows one live node per key.
- Committed policy is `PROPAGATION_POLICY` in `graph.ts`. Automatic retry covers model errors `rate_limited`, `timeout`, `unreachable`, `unavailable`, 3 attempts, 30 s doubling backoff (`RETRY_POLICY`).
- Graph edits: `reviseGraph` (CAS, plan_review or needs_input only; refused while running). Result is a proposed revision; approval dispatches only non-completed nodes. Coordinator replan keeps succeeded nodes and pins them in the proposed plan.
- Fencing: `NodeClaims` port (`claim`, `takeOver`) over `tw_assignments.owner_token`; settle writes carry `fence`. A SCH-05 lease claimer can implement `NodeClaims` instead of the Postgres one.

## Migration 0029 and rollback

Additive: `tw_assignments.retry_not_before`, `tw_assignments.owner_token`, `tw_jobs.run_after`, unique partial index on live `(task_id, key)`. Applied by `applyGraphMigration` (`graph-migration.ts`). Rollback: forward repair only; columns are nullable and unused by older code, drop the index to revert the key rule. Pre-existing duplicate live keys would fail the index (none expected).

## Coordinator wiring

- Domain edits outside the brief's write set but owned by AGT-01 in the AGT-00 path table: `ASSIGNMENT_TRANSITIONS`, `KNOWN_ASSIGNMENT_DIVERGENCES`. Also `apps/api/vitest.config.ts` alias for `@agent-works/domain/teamwork-graph-contract`.
- `createTeamworkRuntime` and `smoke.ts` already call `applyGraphMigration`; any other caller of `applyWorkbenchMigration` that runs the teamwork worker must too.
- Add a route for `reviseGraph(deps, member, taskId, { cas: graphCasSchema, content })` (not in `routes.ts`); `Conflict` codes: `stale_revision`, `digest_mismatch`, `not_live`, `completed_node_changed`, `bad_dependency`, `cannot_revise_graph_<status>`.

## Residual risks

- Automatic retry is model-error only; source errors still fail the node for member retry.
- Editing is refused while the task is `running`; the member cancels or waits.
- Owner-token fence is not carried by writes outside `recordContribution`/`failAssignment`/`retryAssignment`.
