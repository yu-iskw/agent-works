# SCH-02 evidence: transactional dispatch outbox

Base: origin/epv1/integration. Branch `epv1/sch-02-outbox`. Migration 0027 (expand-only).

## Shape

- Table `dispatch_outbox` (0027): `dispatch_id` PK (`dsp:<executionId>`, stable per occurrence), `transport_name` unique (`d-` + sha256 of dispatch id), `fence` bumped per lease claim, `attempts` counted per claim, `state` pending | published | abandoned. Unique partial index on `execution_id` where not abandoned. Trigger makes published and abandoned rows immutable (SQLSTATE 55000).
- `claimDueWithOutbox` (`apps/api/src/outbox/claim-with-outbox.ts`): runs the SCH-01 `claimDue` with an `onClaimed(tx, run)` hook, so run, cursor advance and outbox row commit or roll back together.
- `createOutboxPublisher`: reconcile expired leases, lease a batch (`FOR UPDATE SKIP LOCKED`, short statement), publish through an injectable `QueuePublisher` with no transaction open, then complete by compare-and-swap on `(dispatch_id, fence, state='pending')`.
- Failures store an error class only (`^[a-z0-9._-]{1,64}$`, else `unknown`). Backoff is capped exponential with equal jitter. Quarantine is `state='abandoned'` plus `last_error_class` and `attempts`; `outboxStats` exposes counts and oldest pending age.

## Criteria

| Criterion                                   | Test (`apps/api/src/outbox/outbox.test.ts`)                                                 | Result | Local/live                |
| ------------------------------------------- | ------------------------------------------------------------------------------------------- | ------ | ------------------------- |
| Run + outbox in one transaction             | "one claim writes the run, the cursor advance and a contract-valid outbox row"              | PASS   | local, Docker Postgres 16 |
| Rollback together                           | "an outbox failure rolls back the run and the cursor ..."                                   | PASS   | local                     |
| Crash after commit still publishes          | "a crash after commit and before publish still publishes later"                             | PASS   | local                     |
| Lost ack creates no duplicate logical run   | "lost enqueue acknowledgement" (2 tests, with and without queue name dedupe)                | PASS   | local                     |
| Concurrent publishers (4 and 6)             | "concurrent publishers" 40 events, each published, 40 runs, 40 distinct executions          | PASS   | local                     |
| Stale lease recovery                        | "a publisher that dies mid-publish is recovered ..."; "reconcile clears expired leases ..." | PASS   | local                     |
| Terminal state not overwritten by stale     | 3 fencing tests plus direct UPDATE refused by trigger                                       | PASS   | local                     |
| Poison backoff and quarantine visible in DB | "capped backoff with jitter, then quarantine ..."; non-retryable; cap test                  | PASS   | local                     |
| No lock held during publish                 | "no transaction or row lock is held while the queue call is in flight"                      | PASS   | local                     |

Mutation checks (each turned a test red, then reverted): removing `fence =` from `markPublished` fails "a stale holder cannot complete or fail a row that a newer lease still holds" (an earlier version of the suite did not catch this; that test was added); removing `FOR UPDATE SKIP LOCKED` from `claimBatch` fails both concurrent-publisher tests.

## Commands

All run from the worktree root; exit codes as recorded.

- `pnpm exec vitest run apps/api` 0 (200 files, 2583 passed, 1 skipped pre-existing)
- `pnpm build` 0, `pnpm typecheck` 0, `pnpm knip` 0
- `pnpm exec eslint --fix` + `prettier --write` on `apps/api/src/outbox` and `schedule-row-claim.ts` 0

## Rollback and compatibility

- 0027 only adds a table, two indexes, a function and a trigger. Nothing is altered. Rollback: stop calling `claimDueWithOutbox` (use the plain port), drain or park pending rows (they remain `pending` and harmless), contract later by dropping the table, trigger and function.
- Edit outside the write set (flag): `apps/api/src/ports/schedule-row-claim.ts` now exports `claimDue` and `ClaimDueInput`, `claimDue` takes an optional 4th `onClaimed` argument, and a type `OnClaimed` is exported. Behavior without the hook is unchanged. `schedule-row-claim-store.ts` is untouched. This avoided copying `claimOne` catch-up logic.

## Residual risks

- Reconcile quarantines a row on an expired lease once attempts reach the cap, even if that last in-flight publish succeeded remotely; the message may exist while the row is abandoned. Workers are idempotent per execution id; an operator replay would need a new dispatch id.
- A stale publisher whose lease expired but was not reclaimed may still complete (its fence is current). This is intended.
- Real Cloud Tasks adapter (`QueuePublisher` implementation, ALREADY_EXISTS mapping to `exists`, reserved-name window) is not built; no live calls made. AWAITING_OPERATOR for any live observation.
- Operator replay of abandoned rows is not implemented.

## Wiring the coordinator must do

- Dispatcher tick: call `claimDueWithOutbox(sql, options, {now, limit, owner, leaseMs})` instead of `port.claimDue`.
- Start a publisher loop: `createOutboxPublisher(sql, cloudTasksQueue, options).publishBatch({now: new Date().toISOString(), limit})` on an interval; supply a Cloud Tasks `QueuePublisher`.
- Alert on `outboxStats` (`oldestPendingMs`, `abandoned`).
- Update `apps/api/migrations/README.md` table with 0027 (not touched here). `outboxReady` applies 0027 under lock 7013.
