# OPS-02 AgentOps and FinOps dashboards

Read-only aggregation over data that already exists. No migration (0031 unused).

## Data sources reused

| Metric                      | Source                                                                                                           |
| --------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| due-to-claim latency        | `schedule_runs.fire_at` to earliest `dispatch_outbox.created_at` (SCH-01/02)                                     |
| backlog age, running, stuck | `worker_executions` (SCH-05), same shape as `workerStats`                                                        |
| outbox lag                  | `dispatch_outbox` pending, same shape as `outboxStats`                                                           |
| retries, amplification      | `worker_executions.attempts`                                                                                     |
| quota and admission usage   | `admission_reservations`, `admission_limits` (SCH-06)                                                            |
| cost per successful task    | `admission_reservations.cost_micros` over `state = 'succeeded'`; failed and retried spend stays in the numerator |

Scope is one predicate on the admission ledger (`member`, `bot`, `segment`, `all`). Executions with no ledger row appear only at `all`.

## Three cost categories (never merged)

- `estimated`: our ledger (`estimatedMicros`, `recordedMicros`). Not a bill.
- `billed`: operator billing lines that resolve to an execution in the ledger, or carry a team label.
- `unassigned`: billing lines with no execution and no team (`noLabel`) or an execution the ledger does not know (`unknownExecution`). Visible at `all` only. `billed + unassigned` equals the export total.

Dollar ceilings are owner config: `quota.limits` reports `admission_limits` rows or `null`. Nothing is defaulted.

## Access

`POST /v1/ops/dashboard` and `POST /v1/ops/dashboard/reconcile` (body: optional `scope`, `from`, `to`). Principal grants (`memberId`, `ownedBotIds`, `adminSegmentIds`, `platformAdmin`) come from the server-side `authority` resolver, never the body. Omitted scope means own member scope. A scope outside the grants is 403 `forbidden_scope`. Unknown body keys are 400.

## Reconciliation and P08

`reconcileDashboard` re-reads raw ledger rows and sums in code, then reports a delta per total (`ok` means all zero) and `ledgerAttribution` (share of estimated usage with member, bot and segment). `reconcileBillingSample` computes the share of an operator billing export that the ledger attributes. The 0.99 threshold is the provisional P08 target, reported as `meetsProvisionalTarget`, not an approved SLO. An empty export gives `null`, not 100%.

## Billing export format

CSV header `line_id,amount_micros,execution_id,segment_id,service`. `line_id` and `amount_micros` are required. Amounts are non-negative integer micro-USD. No quoting or embedded commas. Blank execution or segment means unset.

JSON is an array or `{ "lines": [...] }` of `{ lineId, amountMicros, executionId?, segmentId?, service? }` (snake_case keys also accepted). Duplicate `lineId`, negative or fractional amounts, and short rows are rejected. Credits and refunds must be handled by the operator before export. Samples: `apps/api/src/ops-dashboard/fixtures/billing-sample.{csv,json}`.

## Alerts

`alerts.proposed.json` is a proposal. Responder name, contact, runbook and thresholds are `UNSET`/`null`, and `validateAlerts` fails until the owner names them (tested against the shipped file). No Terraform module was added.

## Wiring the coordinator must do

1. Mount `opsDashboardRoutes({ verify, authority, service })` from `apps/api/src/routes/ops-dashboard.ts` in the route table, with `service = createOpsDashboard({ sql, now, billing? })`. `authority(sub)` must return the grants for the subject.
2. Add the two routes to `packages/api-contract` (`operations.json`) and run `pnpm --filter @agent-works/api-contract generate`. Until then `pnpm build` fails the contract drift check because a new file under `routes/` changes the route fingerprints. This is expected and outside this task's write set.

## Rollback

Delete the new files and the two route mounts. No schema change.

## Operator work

Provide an approved billing export for a real period (AWAITING_OPERATOR), name the responder and runbook, set thresholds, and have the finance owner set the dollar budget through `admission_limits`.
