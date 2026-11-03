# SCH-05 evidence: resumable worker, retries, effect ledger, sweeper

Base: origin/epv1/integration f9abbdb. Branch `epv1/sch-05-worker`. Migration 0028 (expand, plus one index swap). Fault matrix: [fault-matrix.md](fault-matrix.md).

## Shape

- `worker_executions` (one row per schedule run): state queued | running | awaiting-reconciliation | succeeded | failed | denied | cancelled | quarantined, `fence` bumped per claim, lease, attempt and deadline budget, checkpoint version and ref. A trigger freezes succeeded, failed, denied and cancelled rows.
- `execution_attempts`: one row per claim with class outcome retryable | permanent | denied | uncertain | succeeded | lease-expired | cancelled and an error class (never provider text).
- `execution_effects`: effect key (PK), payload digest, provider target, state pending | succeeded | uncertain | reconciled | failed, `writes`, resolution, `resolved_by`, `evidence_ref`. `failed` is one state beyond the spec list: a definite provider rejection, safe to write again.
- `delivery_rejections`: poison deliveries, class and caller subject only.
- Code in `apps/api/src/worker/`: `store.ts` (handoff, claim, fenced checkpoint, complete, fail, cancel, stats), `effects.ts` (ledger runner, `resolveEffect`), `sweeper.ts`, `runner.ts` (`createExecutionWorker`), `gate.ts` (reuses broker `resolveAuthority` and `SuspensionEnforcer`), `delivery-store.ts` (SCH-03 `DeliveryStore`), `migration.ts` (`workerReady`, lock 7014).
- Handoff takes no lease. It creates or finds the work row and acks; a runner claims with a fence. Acknowledging a message therefore never depends on work finishing.

## Criteria

| Criterion                                                       | Test                                                                                                       | Result            | Local/live                |
| --------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- | ----------------- | ------------------------- |
| Old worker cannot commit after takeover                         | "an old worker cannot checkpoint, complete or fail ..."; "stale worker cannot start a new external effect" | PASS              | local, Docker Postgres 16 |
| Provider write succeeded, response lost is uncertain, no replay | "succeeded but lost its response ..."; mutation check below                                                | PASS              | local                     |
| Read-back or manual resolution                                  | 2 read-back tests, "inconclusive", "manual resolution" (applied, not-applied)                              | PASS              | local                     |
| Queue loss recoverable from DB                                  | "published dispatch with no work row ...", "queue message loss end to end"                                 | PASS              | local                     |
| Exhausted retries visible in DB                                 | "exhausted attempts", "time budget", "poison handler", lease-expiry quarantine                             | PASS              | local                     |
| Permanent denial or cancel acked, transport stops               | "permanent/denied is persisted", delivery handler tests, "cancel wins"                                     | PASS              | local                     |
| Revoke, pause, suspension rechecked per effect                  | "a denial stops the effect ...", `gate.test.ts` (5 tests)                                                  | PASS              | local                     |
| Simultaneous claim, duplicate and reordered delivery            | "simultaneous claimers", "duplicate and reordered deliveries"                                              | PASS              | local                     |
| Live Cloud Tasks, real IAM, DB failover                         | not run                                                                                                    | AWAITING_OPERATOR | live                      |

## Mutation checks (each turned a test red, then reverted)

- Remove `fence = ${claim.fence}` from `lockHeld` (complete and fail): fails "an old worker cannot checkpoint, complete or fail ...".
- Remove it from `commitCheckpoint`: same test fails. Remove it from the effect `begin`: "a stale worker cannot start a new external effect" fails.
- Make an `uncertain` or orphaned `pending` effect return `write` instead of `unresolved`: 4 tests fail ("succeeded but lost its response ...", "read-back applied", "read-back not applied", "inconclusive").

## Commands

From the worktree root.

- `pnpm exec vitest run apps/api` 1 on the first run: one unrelated 5 s timeout in `teamwork/installations.test.ts` under full-suite load (203 files passed, 2671 tests). That file plus `worker` and `outbox` re-run alone: exit 0, 64 passed.
- `pnpm exec vitest run apps/api/src/worker` 0 (gate 5, worker 36)
- `pnpm build` 0, `pnpm typecheck` 0, `pnpm knip` 0 (one pre-existing configuration hint)
- `pnpm exec eslint apps/api/src/worker` 0, prettier clean.

## Rollback and compatibility

- 0028 adds four tables, a function and a trigger. It also drops `dispatch_outbox_live_execution` (one non-abandoned row per execution, ever) and creates `dispatch_outbox_pending_execution` (one pending row per execution). Reason: queue-loss recovery must append a row beside an already published one, which the 0027 index forbids. No SCH-02 test depends on the old index; double-pending is still impossible (tested).
- Rollback: stop calling the worker and sweeper, re-create the 0027 index only if no execution has more than one non-abandoned dispatch row, then drop the new tables. Work rows are forward-only data.
- No applied migration edited; 0027 itself is untouched.

## Residual risks

- Nothing mirrors worker outcomes into `schedule_runs.status` or the task ledger; consumers read `worker_executions`.
- `maxRedrives` replays a possibly delivered message; handoff is idempotent so a late duplicate is harmless.
- Operator replay of quarantined or `redrive-exhausted` executions is not built. The terminal trigger leaves `quarantined` movable for it.
- `resolveEffect` has no authorization of its own; the caller (admin route) must enforce current operator authority.
- Backoff units are the SCH-03 `RetryConfig` seconds; `maxRetryDurationSeconds` is the per-execution time budget.

## Wiring the coordinator must do

1. Mount `createDeliveryHandler({ ..., store: createPostgresDeliveryStore(sql, { budget }) })` (already described in `sch-03/delivery-contract.md`).
2. Run `createExecutionWorker({ sql, owner, budget, gate, handler }).runOnce()` in a loop. `handler` runs the real step and must route every provider write through `ctx.effect` with a stable key.
3. Run `sweep(sql, { now, budget, redriveAfterMs, maxRedrives, limit })` on an interval, and alert on `workerStats` (`quarantined`, `awaitingReconciliation`, `uncertainEffects`, `oldestQueuedMs`).
4. Build the gate with `createAuthorityEffectGate({ resolver, enforcer, identify })` using the server's real `AuthorityResolver` and `createSuspensionEnforcer`.
5. Add an admin route for `resolveEffect` and `cancelExecution` behind operator authorization.
6. Update `apps/api/migrations/README.md` with 0028. `workerReady` applies 0013, 0026, 0027, 0028 on demand under lock 7014.
