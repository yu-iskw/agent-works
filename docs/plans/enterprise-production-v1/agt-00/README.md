# AGT-00: teamwork contracts, gap map and path ownership

Base: `origin/epv1/integration` 16050f5. Scope: design, frozen contracts and tests. No behavior change, no migration, no edit to `index.ts` or `package.json`.

## Readiness statement

The current teamwork runtime is a **local fake, not production-ready**. It runs on `scripted-model.ts` and `sources/fixture.ts` for review and tests. `runtime-manager.ts` offers only `unavailableRuntimeManager` and `createFakeRuntimeManager`, so connector runtimes are not deployed anywhere. `docs/connectors/marketplace.md` lists MCP and A2A entries as `coming_soon` placeholders. ADR 0006 is Proposed. Nothing here is VALIDATED.

## Tenancy

A segment is one process, one database and one member allowlist (`apps/api/migrations/0023_installations.sql` header, ADR 0006 Q1, `specs/01-architecture.md`). There is no `workspace_id` column and none of the contracts add one. Grants, graph revisions and installations live in the issuing segment's database. Combining segments needs a separate migration decision and negative isolation proof.

| Level      | Today                                                            |
| ---------- | ---------------------------------------------------------------- |
| Enterprise | One deployment; not a data boundary                              |
| Segment    | Process, database, `AW_M1_<SEG>_MEMBERS`, `..._ADMINS`, env caps |
| Team       | Not modelled; a shared bot is a catalog template, not a group    |
| User       | `owner_sub`; private conversations, connections, tasks           |
| Bot        | `tw_teammates` (versioned), snapshotted into `tw_assignments`    |

## Frozen contracts

| File (new)                                                 | Freezes                                                                                                                                 |
| ---------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/domain/src/teamwork-graph-contract.ts`           | Graph revision and CAS rule, nine logical node states, transition table as data, reasons, mapping to stored names, UI projection, order |
| `packages/domain/src/standing-grant-contract.ts`           | Standing grant, projection to `DelegationAuthority` and `Authority`, intersection-only child issuance, chain usability                  |
| `teamwork-graph-fixtures.ts`, `standing-grant-fixtures.ts` | Shared fixtures for AGT-01..07 tests                                                                                                    |

Mapping of logical states onto existing names (no new stored status):

| Logical             | Stored today                                                                                                    |
| ------------------- | --------------------------------------------------------------------------------------------------------------- |
| `blocked`           | `tw_assignments.status = 'queued'` with unmet `depends_on`; or `failed` with `error_code = 'dependency_failed'` |
| `ready`             | `queued`, dependencies met, job not claimed                                                                     |
| `running`           | `running`                                                                                                       |
| `succeeded`         | `succeeded`                                                                                                     |
| `retry_wait`        | GAP: `queued` after a retry; no stored not-before time                                                          |
| `failed`            | `failed`, `timed_out`                                                                                           |
| `awaiting_approval` | assignment `needs_input`; task `awaiting_action_approval` for publish                                           |
| `uncertain`         | task `outcome_uncertain` (publish); no assignment equivalent                                                    |
| `cancelled`         | `cancelled`; `superseded` is history of an earlier revision, not a node                                         |

Graph revision is a `tw_plans` row: `revision` = `tw_plans.version`, `digest` = `tw_plans.digest`, `state` = `tw_plans.state`. The projection's `taskVersion` is `wb_tasks.version`. Grant mapping: `permissions` become `DelegationAuthority.grants`, `sponsor` is `subject`, `policyRevision` is `policyDecisionRef`, `auditRef` is `Authority.auditRef`; `region` and `governanceZone` come from deployment config.

Divergences kept visible by tests: `succeeded -> queued` (rerun) is a replay the contract forbids. A defect found by characterization: `releaseDependents` tries `queued -> failed`, which `ASSIGNMENT_TRANSITIONS` forbids, so the dependent of a failed prerequisite stays queued and the task stays `running`.

## Exports the coordinator must add

`packages/domain/package.json` `exports` and `index.ts` are not edited here. Add subpaths `./teamwork-graph-contract` and `./standing-grant-contract` (same `types`, `development`, `import` shape as `./delegation`). The two fixture files are test helpers; export them only if app tests need them (`./teamwork-graph-fixtures`, `./standing-grant-fixtures`). Vitest in `apps/api` may also need the alias used for `./delegation` (commit 16050f5).

Public names: graph file `GRAPH_CONTRACT_VERSION`, `graphRevisionSchema`, `graphCasSchema`, `evaluateGraphCas`, `NODE_STATES`, `nodeStateSchema`, `NODE_STATE_TRANSITIONS`, `canNodeTransition`, `TERMINAL_NODE_STATES`, `NODE_REASONS`, `nodeReasonSchema`, `REASONS_FOR_STATE`, `ASSIGNMENT_STATUS_LOGICAL`, `STAGE_STATUS_LOGICAL`, `logicalNodeState`, `reasonFor`, `KNOWN_ASSIGNMENT_DIVERGENCES`, `projectionNodeSchema`, `graphProjectionSchema`, `visibleNodes`, `isNewerProjection`, `graphMutationSchema` and their types. Grant file `STANDING_GRANT_CONTRACT_VERSION`, `standingGrantSchema`, `toDelegationAuthority`, `authorityForCall`, `chainUsable`, `deriveChildGrant` and types `StandingGrant`, `ChildGrantRequest`, `ChildDenial`, `GrantDeployment`, `GrantUse`, `GrantDenial`.

## Exact path ownership

"Serialized" means one owner at a time in the stated order. Migration numbers (0024 onward) are reserved by the coordinator; none is assumed here.

| Task   | Exclusive paths (new unless noted)                                                                                                                                                                                                           | Serialized shared paths                                                                                                                           |
| ------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| AGT-01 | `apps/api/src/teamwork/graph.ts`, `graph.test.ts`; in `store.ts` the functions `moveAssignment`, `releaseReady`; in `worker.ts` `releaseDependents`, `settleTask`, `claim`; `packages/domain/src/teamwork.ts` `ASSIGNMENT_TRANSITIONS` block | `tasks.ts` regions `editPlan`, `replan`, `cancelTask`, `followUpRescope` (first); retry and revision columns via a coordinator-reserved migration |
| AGT-02 | `apps/api/src/teamwork/graph-proposal.ts`, `graph-proposal.test.ts`; `apps/api/src/delegation/context.ts`, `orchestrator.ts` (deny, not trim, widened requests; depth and fan-out caps); `prompts.ts`                                        | `tasks.ts` regions `checkPlan`, `dispatch` (after AGT-01)                                                                                         |
| AGT-03 | `apps/api/src/teamwork/grants.ts`, `grants.test.ts`; `packages/domain/src/standing-grant-contract.ts` and its fixtures and test (contract changes need coordinator sign-off); `docs/plans/enterprise-production-v1/agt-03/**`                | New migration (reserved); `apps/api/src/broker/authority.ts` is read-only here, owned by AUTH-01 follow-up                                        |
| AGT-04 | `gateway.ts`, `diagnostics.ts`, `reconciler.ts`, `connections.ts`, `conversations.ts` under `apps/api/src/teamwork/`; `diagnostics.characterization.test.ts` (update with the fix); `gateway.test.ts`, `reconciler.test.ts`                  | `catalog.ts` bot-sharing functions; gateway authority resolution waits for AGT-03; the AUTH-01 follow-up items 1 to 5 are folded into this task   |
| AGT-05 | `apps/api/src/teamwork/sandbox/**` (adapter boundary, only after approval); `docs/plans/enterprise-production-v1/agt-05/**`; reads `docs/spikes/agent-platform/sandbox.md`                                                                   | None; capability stays disabled without evidence                                                                                                  |
| AGT-06 | `apps/api/src/teamwork/memory/**` (adapter boundary, only after a go verdict); `docs/plans/enterprise-production-v1/agt-06/**`; reads `docs/memory/**`                                                                                       | None; core recovery must pass with the adapter off                                                                                                |
| AGT-07 | `apps/web/client/workspace/store/graph-*.ts`, `apps/web/client/workspace/ui/graph/**` and tests; read-only API route `apps/api/src/teamwork/graph-routes.ts` (the factory is wired by the coordinator, not in `routes.ts`)                   | `packages/domain/src/teamwork-graph-contract.ts` projection part (change control with AGT-01); `workspace.css` additions in a separate file       |

AGT-00 owns only: the two contract files and fixtures, their tests, `apps/api/src/teamwork/graph.characterization.test.ts`, `diagnostics.characterization.test.ts`, and this directory.

See [gap-map.md](gap-map.md) and [evidence.md](evidence.md).
