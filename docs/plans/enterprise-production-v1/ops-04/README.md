# OPS-04 capacity and fault campaign: local harness and operator handoff

Everything under `results/` and `proposals/` is `local-synthetic`: one machine, a disposable local
Postgres container, synthetic workers, no model calls. None of it is a live or cloud result.

## What exists

| Piece                                                                                                 | Path                                                                                                                           |
| ----------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| Harness (dispatcher, outbox publisher, queue stand-in, workers, sweeper, reconciler, fault injection) | `scripts/ops-04/harness.mjs`                                                                                                   |
| Pure metrics and provisional targets                                                                  | `scripts/ops-04/lib/metrics.mjs`                                                                                               |
| Workload specs                                                                                        | `scripts/ops-04/workload-full.json` (P01 at real time, 24 h), `workload-local-scaled.json` (480x), `workload-tiny.json` (test) |
| Threshold proposal (never approves)                                                                   | `scripts/ops-04/propose-thresholds.mjs`                                                                                        |
| Operator runbook and approval requests                                                                | `docs/runbooks/capacity-campaign.md`                                                                                           |
| Versioned results, kept                                                                               | `results/ops04-*.json`                                                                                                         |
| Proposals, kept                                                                                       | `proposals/proposal-*.json`                                                                                                    |

## Run

```bash
pnpm build                                                         # harness imports apps/api/dist
node scripts/ops-04/run.mjs scripts/ops-04/workload-local-scaled.json   # about 4 min wall clock
node scripts/ops-04/propose-thresholds.mjs                         # proposal from results/
```

Docker is required. The harness starts one `postgres:16-alpine` container, kills it with SIGKILL for
the DB-restart fault, and removes only that container. It never accepts a database URL.

## What the harness exercises (real code, real Postgres)

`claimDueWithOutbox` (row-claim dispatcher plus outbox write in one transaction), the outbox
publisher, `handoff`, `claimNext`/fenced commits, the effect ledger, `sweep` (lease recovery and
lost-message redrive), `resolveEffect`, and `cancelExecution`. The queue and the provider are
in-process stand-ins; the delivery HTTP handler and its OIDC check are not on the path.

Faults: worker death (in the middle of a provider write, and between steps), lost queue messages,
queue unavailable, duplicate delivery, DB crash and restart, provider unavailable, provider
acknowledgement lost, and revocations of queued and running work.

## Reading a result

- `metrics.P02..P05` give each distribution twice: `virtualMs` (schedule time, what the code saw)
  and `realMs` (wall clock). With `speed` above 1, fixed real costs such as DB round trips and poll
  ticks appear multiplied by `speed` in virtual time. Only `speed: 1` results are comparable to the
  live targets (`evaluation.comparableToLiveTargets`).
- `evaluation.*.verdict` is `insufficient-sample` until the P-row sample size is met, then
  `within-` or `exceeds-provisional-target`. It is never PASS.
- `explain` names what limits each number. `harnessProcess.eventLoopDelayP99Ms` shows whether the
  load generator itself was the limit.
- Loss means a claimed run with no worker row, or still queued or running after the drain.
  Quarantined and awaiting-reconciliation work is visible and reported apart, not counted as lost.
- Duplicates are counted three ways: provider-side writes per effect key above 1, duplicate runs per
  schedule slot, and replayed writes in the ledger.
- Uncertain effects are counted as ever uncertain, reconciled, and unresolved at the end.

## Known limits of the local harness

- Single run per result file, so no run-to-run range. Repeat runs and compare the files.
- Autoscaling and worker cold start from zero are not modeled; a dead worker is replaced after a
  fixed delay.
- Reconciliation uses the harness's own record of provider writes as ground truth. A live provider
  read-back is the operator's evidence.
- Catch-up-once means slots that were due during a stall collapse into one run; compare
  `slots.expectedByFormula` with `slots.claimedRuns`.
