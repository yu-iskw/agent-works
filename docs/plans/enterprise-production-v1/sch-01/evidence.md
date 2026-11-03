# SCH-01 evidence: indexed row-claim scheduling store

- Task / owner / date / status: SCH-01, worker agent, 2026-11-03, READY_FOR_REVIEW (not VALIDATED).
- Base: `origin/epv1/integration` (includes SCH-00). Branch `epv1/sch-01-row-claim`. No push, no PR.
- Write set: `apps/api/src/ports/schedule-row-claim*.ts` (+ tests, testkit), `apps/api/migrations/0026_schedule_row_claim.sql`, this directory. Legacy `schedule-postgres.ts`, `server.ts` and applied migrations untouched.

## Design

- `schedules.next_due` (nullable, partial index `schedules_next_due(next_due, id) where next_due is not null`) is a derived wake time. `payload.cursor` stays authoritative, so the legacy store reads a correct cursor after any row-claim period.
- `claimDue({now, limit, owner, leaseMs})`: one transaction, `select ... where next_due <= now order by next_due, id limit n for update skip locked`, then per row the existing `store.ts` claim and advance logic (parity by reuse), cursor advance, new `next_due`. No remote call inside. `lock_timeout` 2 s and `statement_timeout` 10 s are set locally.
- Every other port method locks only its own schedule row (`for update`, plus `pg_advisory_xact_lock(7014, hashtext(id))` for a first create) and loads only the rows it touches. Lock 7013 is never taken by the row-claim writer.
- Identity unchanged: `scheduleRunId(scheduleId, fireAt, eventKey)`. Revision is only in the payload. The 0013 unique indexes remain the backstop.
- Event-only schedules, paused, revoked and expired schedules have `next_due = null`. Resume and create recompute it.
- One writer: `scheduler_owner(owner, generation)` singleton (`legacy` at migration). Row-claim transactions take it `FOR SHARE` and refuse unless `rowclaim`. Trigger `schedule_writer_guard` on the five write tables rejects any write whose declared writer (`agentworks.scheduler_writer`, default `legacy`) is not the owner, so the unmodified legacy store is refused after the flip with SQLSTATE 55000. `switchSchedulerOwner` takes `pg_try_advisory_xact_lock(7013)` (refuses if a legacy transaction is in flight), then updates the owner row under `lock_timeout` (refuses if a row-claim transaction is in flight). Flip to `rowclaim` backfills `next_due` from the payload cursor and validates (no active timed schedule without a due row, no duplicate slot) in the same transaction.

## Criteria

| Criterion                                                | Test/command                                                                                                                                                                                                                                                 | Result | Evidence    | Local/live                |
| -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------ | ----------- | ------------------------- |
| 2 and 4 dispatchers, one occurrence per slot, repeated   | `schedule-row-claim.test.ts` "concurrent dispatchers" (12 schedules x 25 repetitions each for N=2 and N=4, distinct pools)                                                                                                                                   | PASS   | test output | local, Docker Postgres 16 |
| Edit at due time cannot create a second occurrence       | same file, "pause racing claimDue" 25 repetitions; "revision is stored beside the occurrence"                                                                                                                                                                | PASS   | test output | local                     |
| Catch-up, skip, resume, DST fall-back and spring-forward | same file, "catch-up, skip, resume and DST parity" (7 tests incl. scheduler resume characterization run on the new store)                                                                                                                                    | PASS   | test output | local                     |
| Existing store contract                                  | `schedulePortContract` (16 tests) run against the new adapter                                                                                                                                                                                                | PASS   | test output | local                     |
| No global lock on independent schedules                  | same file: lock 7013 held elsewhere does not stall; a row-locked schedule is skipped while others claim; bounded wait fails with "busy"                                                                                                                      | PASS   | test output | local                     |
| Cutover has one writer                                   | `schedule-row-claim-cutover.test.ts` (5 tests): legacy refused after flip (55000), row-claim refused before, flip refused with legacy tx in flight, flip back refused with row-claim tx in flight, rollback and re-flip keep one run per slot and the cursor | PASS   | test output | local                     |
| Due query uses the index; lock time bounded              | `schedule-row-claim-explain.test.ts`, results in `explain-results.json`                                                                                                                                                                                      | PASS   | below       | local                     |

## EXPLAIN and timing (local, 50,400 schedules, 400 due, batch 25, 4 dispatchers)

- Plan for the due query (`EXPLAIN (ANALYZE, BUFFERS)`): `Limit -> LockRows -> Index Scan using schedules_next_due`. No Seq Scan. Planning 0.15 ms, execution 0.08 ms, 52 shared buffers hit (full JSON in `explain-results.json`).
- 24 `claimDue` calls (each one transaction holding up to 25 row locks): p50 66.6 ms, p95 147.2 ms, max 163.5 ms, wall 389 ms for all 400 claims, 400 distinct runs, 0 duplicates. A previous run of the same test gave p50 46.7, p95 83.8, max 85.9 ms. The spread between runs is machine and Docker VM noise; the bound asserted in the test is max under 2 s.
- Caveat: local Docker Postgres on a laptop, single run set, not a cloud number. Per-call time includes pool round trips; lock hold time is at most the call time.

## Rollback and forward repair

- Roll back the writer: `switchSchedulerOwner(sql, 'rowclaim', 'legacy')` (refuses while a row-claim transaction is in flight; retry). No cursor repair is needed because `payload.cursor` is advanced by the row-claim path. Verified by the rollback test. `schedule_runs` unique indexes make a repeated slot a no-op.
- Re-flip later: the flip re-backfills any active timed schedule without a due row (legacy writes do not maintain `next_due`; a stale `next_due` is only an early wake, never a lost slot).
- 0026 is expand-only and not dropped on rollback. To remove it after a full rollback, drop triggers, `scheduler_owner`, `schedules_next_due`, `schedules.next_due` in a later contract migration. If a flip fails validation, nothing changes (single transaction); fix data and rerun.
- `create index` is not concurrent (migrations run in a transaction). On a very large `schedules` table apply the index out of band first; the migration is not idempotent on its own, so use `if not exists` in that case (operator note).

## Residual risks and notes

- The scheduler tick still visits every schedule via `all()` for housekeeping (settle runs, authority revocation, lease recovery, expiry revoke). Only slot claiming moved to `claimDue`. Wiring the tick to use `claimDue` and indexed housekeeping is follow-up (see report).
- Outbox table from contract section 4 is not in 0026 (not in this task's deliverables); the claim transaction has no outbox write yet.
- A `claimDue` batch aborts as a whole if one row's payload fails to parse or a store conflict is thrown; the transaction is short, but a poisoned row at the head would repeat. Monitor and quarantine if seen.
- Cron wake hint scans at most 24 h of minutes per recompute; sparser crons wake daily with a no-op claim.
- Operator work: restore drill in a separate environment before the live flip, and the live observation window (duplicate count, claim skew, missed slots). AWAITING_OPERATOR.
- Integration validation on the combined revision: UNTESTED (coordinator).
