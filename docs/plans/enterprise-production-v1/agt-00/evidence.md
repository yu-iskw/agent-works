# AGT-00 evidence

- Task / owner / date / status: AGT-00, worker agent, 2026-11-03, READY_FOR_REVIEW (not VALIDATED)
- Base SHA / result SHA / draft PR: 16050f5 / see the branch head of `epv1/agt-00-teamwork-contracts` / none (no push)
- Changed files: only new files under `packages/domain/src/` (`teamwork-graph-*`, `standing-grant-*`), `apps/api/src/teamwork/*.characterization.test.ts`, this directory. No scope exceptions.

| Criterion                                                                                       | Test/command                                                                                   | Result          | Local or live |
| ----------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- | --------------- | ------------- |
| Each addition maps to code or documented gap                                                    | `gap-map.md` review                                                                            | PASS (document) | local         |
| No workspace_id assumption                                                                      | `README.md` tenancy table; schemas reject `workspaceId` (graph and grant tests)                | PASS            | local         |
| Runtime fake not called production-ready                                                        | `README.md` readiness statement                                                                | PASS (document) | local         |
| Illegal node transitions rejected                                                               | `teamwork-graph-contract.test.ts` "allows exactly the frozen edges"                            | PASS            | local         |
| Mapping onto existing names, no duplicates                                                      | same file, mapping block (cross-check against `ASSIGNMENT_TRANSITIONS`)                        | PASS            | local         |
| Graph CAS rule                                                                                  | same file, "graph revision compare-and-swap"                                                   | PASS            | local         |
| Projection omits inaccessible nodes and edges                                                   | same file, "UI projection"                                                                     | PASS            | local         |
| Grant intersection-only (resource, action, time, depth, schedule, concurrency, fan-out, budget) | `standing-grant-contract.test.ts` incl. 500-run property test                                  | PASS            | local         |
| Current behavior characterized on real Postgres                                                 | `graph.characterization.test.ts`, `diagnostics.characterization.test.ts` (disposable Postgres) | PASS            | local         |

Commands (exit codes): `pnpm build` 0; `pnpm typecheck` 0; `pnpm exec vitest run` on the four new test files, 39 tests passed, 0; `pnpm exec eslint` on all touched files 0; `pnpm exec prettier --check` 0; `pnpm knip` reports no unused exports (one pre-existing configuration hint about `apps/web`).

- Positive controls: fixture parses, CAS `apply`, owner positive for each grant call, two workers each completing one assignment.
- Negative and fault cases: each illegal transition, stale/digest/not-live CAS, each grant widening axis, expired/revoked/early grant, revoked ancestor, non-member diagnostics, failed prerequisite.
- Migration/backward compatibility: none; no applied migration edited; no stored status added.
- Rollback: delete the new files; nothing else depends on them until the coordinator adds exports.
- Open risks: (1) dependency-failure defect pinned, not fixed; (2) contract subpath exports need coordinator wiring; (3) grant budget values are unapproved placeholders (O04); (4) `retry_wait` needs a migration; (5) characterization tests pin gaps and must be updated by AGT-01/AGT-04 when they fix them.
- Operator work still required: none for AGT-00. AWAITING_OPERATOR for later live gates (O04 approval).
- Integration validation on combined revision: not run.
