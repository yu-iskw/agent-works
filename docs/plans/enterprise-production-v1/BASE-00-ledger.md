# BASE-00 planning ledger

Status: READY_FOR_REVIEW (local, read-only inventory; no GitHub writes). Recorded 2026-11-02.

## Baseline

- Checkout HEAD: `8d2dc6d3b602a4b30a9a7b4c2f0809eb4b291dcc` (branch `claude/agent-works-implementation-f24cab`, worktree clean).
- `origin/main` after fetch: same SHA. The pack's reference SHA equals current main, so pack findings were not stale at record time.
- Open PRs: none. #174 (owner task read route) is CLOSED, not merged. #185 (marketplace and segment gateway) merged 2026-11-02.

## ADRs

| ADR                                            | Status   |
| ---------------------------------------------- | -------- |
| 0001 TypeScript-first with ADK JS              | Accepted |
| 0002 Monorepo layout                           | Accepted |
| 0003 Pilot decisions                           | Accepted |
| 0004 Application core and adapter boundaries   | Proposed |
| 0005 Agent runtime package                     | Proposed |
| 0006 Curated marketplace and connector gateway | Proposed |

Only 0001 to 0003 bind. Proposed ADRs stay Proposed (FND-01 and the pack both forbid silent acceptance).

## Existing topology (evidence: directory listing at HEAD)

- Workspaces: `apps/api`, `apps/web`, `apps/incident-analysis`; `packages/{agent-runtime,api-contract,cli,common,domain,fakes,policy}`; `agents/skills/*`.
- API modules already present under `apps/api/src`: `broker`, `ledger` (postgres ledger and dispatch), `suspension`, `scheduling`, `teamwork`, `reliability` (DLQ, retry budget, restore drill), `telemetry`, `finops`, `governance`, `delegation`, `connectors`, `credentials`, `workflow`, `routes`.
- Migrations `0001` to `0023` in `apps/api/migrations`. Next free number is 0024 (coordinator reserves, per COORDINATION.md). Includes `0010_suspensions`, `0011_budgets`, `0013_schedules`, `0018_teamwork`, `0019_teamwork_dependencies`, `0023_installations`.
- Scheduler advisory lock 7013 appears in `apps/api/src/ports/schedule-postgres.ts` and `docs/scheduling/operations.md`.
- Task routes under `apps/api/src/routes/tasks*.ts`; no Cloud Tasks client found in `apps/`, `packages/` or `infra/` by name search.
- Infra: `infra/terraform`; CI workflows include `deploy-dev.yml`, `e2e.yml`, `infra.yml`, `infra-plan.yml`, `release-gates.yml`, `sbom.yml`, `publish.yml`.

## Reuse versus new (implications for the task index)

These are findings from names and directories only. Each needs a code read by its owner before the task is READY.

| Pack task                    | Existing artifact to reuse first                                                     | Likely delta                                                                       |
| ---------------------------- | ------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------- |
| FND-04 stop control          | `src/suspension`, migration 0010, `docs/runbooks/global-agent-stop.md` (#102 closed) | Check scopes (member/bot/tool), restart persistence, concurrent stop/dispatch test |
| SCH-05 effect reconciliation | `src/reliability` DLQ and retry budget, `src/ledger`                                 | Fenced checkpoints, effect ledger and uncertain state are not evidenced; confirm   |
| SCH-06 admission             | migration 0011 budgets, `src/finops`                                                 | Per-member/bot/segment atomic reservations unverified                              |
| SCH-01                       | `ports/schedule-postgres.ts` (lock 7013)                                             | Full replacement, new migration                                                    |
| SCH-02, SCH-03               | `src/ledger/postgres-dispatch.ts` (task dispatch)                                    | Outbox and Cloud Tasks adapter likely new                                          |
| TASK-01                      | #161 open, #174 closed unmerged; `routes/tasks-read.ts` exists                       | Recheck whether current route already satisfies the owner read and denial matrix   |
| OPS-01                       | `src/telemetry`                                                                      | Correlation schema and redaction extension                                         |
| AGT-00..04                   | `src/teamwork`, `src/delegation`, migrations 0018, 0019, 0023                        | Standing-grant lifecycle (AGT-03) mapping to canonical Authority                   |
| FND-01                       | `docs/plans/phase3-readiness-matrix.md`, `decisions.tsv`, closed #23                 | Reconcile D-01..D-12 and O01..O08 against artifacts                                |

## Ownership and issue reuse

Existing issues to reuse (open): #169 (AUTH-01), #161 (TASK-01), #24 (DEP-01), #22 (ACL-01), #20 (capability aggregation), #105 to #112 (probes), #1 (Renovate, FND-06), #175 (OPS-05 release gate), #167 to #171 (review only). Closed but not proof of correctness: #23, #25, #98, #101, #102.

Exact per-task write sets are NOT yet bound. Binding requires reading each issue body's exclusive scope, which this pass did not do. Until then no task other than BASE-00 is READY under the pack's rule.

## Constraints on execution

1. Agents may implement, test locally, and open draft PRs. Merge, deploy, Terraform apply, IAM/OAuth changes and live tests are operator-only (DEP-01, ACL-01 live legs, OPS-04, G1 to G4 sign-off, O01 to O08 decisions).
2. Repo `AGENTS.md` pins subagent models to a Grok-based policy and forbids Sonnet, Opus and max effort, while the user's global pstack sheet selects Sonnet. These conflict. Delegation needs one resolved policy before fan-out.
3. `pnpm m1:e2e` includes a live leg and must not be run casually.

## Wave 1 candidates (after write-set binding)

FND-01 (docs), AUTH-01 (broker, #169), FND-03 (Terraform DB and migrations), FND-06 (supply chain). Disjoint by design per COORDINATION.md. Wave 2 (FND-02, FND-04, TASK-01) follows once contracts are agreed.
