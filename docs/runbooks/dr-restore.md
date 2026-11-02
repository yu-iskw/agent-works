# Disaster recovery: disposable offline restore drill

## Authority and unresolved decisions

This runbook provides the offline rehearsal required by RFC-001 §19.3 and P3-DR.
It does not define an RTO, RPO, maximum data loss, workload size or business
criticality. Those decisions remain with the business under D-10.

**Deletion, dev hard stops and real restores are not authorized.** D-08 withholds
retention/deletion decisions; D-10 withholds service requirements;
[ADR 0003](../adr/0003-pilot-decisions.md) withholds dev hard stops. Any cap, amount,
retention or destination encountered in fixture tools is an **UNAPPROVED PLACEHOLDER**.
Passing this offline rehearsal does not authorize a production or dev restoration.

## Scope and dependencies

The harness creates its own disposable local Postgres instance. It accepts a
non-sensitive request fixture, never a live database URL or real write adapter.
Its dependency map is the task ledger, dispatch claims/deliveries, outbox events,
transition receipts, budget/DLQ tables, and an independent fake external system.
Memory, sessions, credentials, encrypted artifacts and regional failover are not
assumed to recover automatically or across regions.

The Docker backend stores disposable Postgres data in memory with `--tmpfs`, so
it does not consume the full Docker data disk. Put `/tmp/issue135-bin` first on
`PATH` when using the supplied local Docker wrapper. On hosts with the repository's
native Postgres binaries, the harness uses the existing disposable cluster helper.
Both backends perform a real SQL dump and restore. Do not prune Docker, delete
unrelated containers or volumes, or redirect the drill to an existing project.
If Docker access or local socket permissions are unavailable, report the blocker;
a skipped or failed test is not passing restore evidence.

## Execute offline

```bash
pnpm build
node tools/restore-drill/run.mjs tools/restore-drill/fixtures/request.json
```

The harness uses the repository's disposable Postgres helper. It dumps with
`pg_dump`, creates a second database on that disposable instance, restores with
`psql` in stop-on-error mode, and runs fresh ledger/dispatch port instances against
the restored database. No real external call is made.

## Verify recovery behavior

The source includes completed external writes and in-flight writes. One in-flight
write has reached the fake external service but lacks a durable receipt; another
has not yet reached that service. The fake external service survives outside the
backup and deduplicates its original idempotency key.

After restore:

- Re-deliver the original acceptance keys for completed tasks and confirm the task
  IDs and durable receipts are unchanged. Completed tasks never become runnable.
- Reclaim expired leases for in-flight tasks through the normal dispatch port.
  Recover an existing external receipt by its original key, then persist completion.
- Execute previously unexecuted work with its original key and persist its receipt.
- Check independent external create counts, recovered receipts and completed-task
  redelivery evidence. Any duplicate external create fails the drill.

A failed dump, restore, missing claim, missing receipt or unexpected runnable
completed task fails the drill. Do not hide the failure by dropping records,
regenerating idempotency keys or resetting task status.

## Operator restore checklist (live Cloud SQL, unrun)

FND-03 proposal. **Status: AWAITING_OPERATOR.** Nothing below has been executed. Run only after the
business approves a target project, RTO/RPO (D-10), retention (D-08) and the destination below.
Restore into a **new, separate instance** (clone or PITR clone). Never restore over the serving
instance, and keep the source untouched until the evidence is accepted. HA failover is a different
event and does not substitute for this drill. Run it once per database; the segment database (O01)
is its own instance and gets its own pass.

Fill each row with a redacted artifact path. No secrets, no raw private content.

| #   | Step                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | Evidence to attach             |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------ |
| 1   | Record source instance, region, current time (UTC), `gcloud sql backups list` output, and the chosen recovery point (latest backup or a PITR timestamp inside `transaction_log_retention_days`).                                                                                                                                                                                                                                                                                                                                                               | Command output                 |
| 2   | Before touching anything, capture baseline counts and a digest from the source as `aw_readonly`: row counts for `tasks`, `task_deliveries`, `task_claims`, `outbox_events`, `audit_events` and the other audit tables in `grants.sql`; `max(occurred_at)` of `audit_events`; the ids of tasks in a non-terminal state.                                                                                                                                                                                                                                         | `baseline.txt`                 |
| 3   | Create the restore target as a new private-IP instance from the backup or PITR timestamp (`gcloud sql instances clone` or `gcloud sql backups restore` to the new instance). Record the operation id and elapsed time.                                                                                                                                                                                                                                                                                                                                         | Operation id, timestamps       |
| 4   | **Records.** As `aw_readonly`, re-run the step 2 queries on the restore. Row counts equal the baseline up to the recovery point; any gap is explained by the chosen timestamp. The newest `audit_events` row is not later than the recovery point.                                                                                                                                                                                                                                                                                                             | `restored-counts.txt` and diff |
| 5   | **Grants.** Run `docs/plans/enterprise-production-v1/fnd-03/verify-roles.sql` on the restore as a superuser. Roles, default privileges and IAM memberships are not guaranteed to survive a restore: if it fails, re-apply `roles.sql`, `grants.sql` and the IAM role grants, then re-verify. Expect `verify-roles: OK`.                                                                                                                                                                                                                                        | Script output                  |
| 6   | **Audit.** As `aw_app`, attempt UPDATE and DELETE on `audit_events`; both must fail with `insufficient_privilege`. Confirm the immutability triggers exist (`select tgname from pg_trigger where not tgisinternal`) and the hash-chain fields (`prev_digest`) of the last audit rows are unbroken against the baseline.                                                                                                                                                                                                                                        | Statement errors, trigger list |
| 7   | **Pending tasks.** List non-terminal tasks, undelivered `outbox_events` and unexpired or expired `task_claims` from the restore. Compare ids to step 2. With no workers connected, start a **non-serving** dispatch/reconciliation run against the restore: expired leases are reclaimed, in-flight external writes recover by their original idempotency key, completed tasks stay completed (the same behavior the offline drill above proves). Any provider write whose receipt is missing is recorded as uncertain and reconciled, never blindly replayed. | Task id list, reconcile log    |
| 8   | Run the application health check against the restore with a **test** identity only, with all provider adapters and the scheduler disabled. Do not point production traffic, schedulers or webhooks at it.                                                                                                                                                                                                                                                                                                                                                      | Health output                  |
| 9   | Record total elapsed time from step 3 to a passing step 8 against RTO, and data-loss window against RPO. Report both as measured, not as targets.                                                                                                                                                                                                                                                                                                                                                                                                              | Timing table                   |
| 10  | Decommission the restore instance only on explicit approval; deletion is a separate decision.                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | Approval reference             |

Fail the drill on any mismatch in step 4 that the recovery point does not explain, any failed
step 5 that re-application does not fix, a mutable audit table, or any duplicate external create.
A skipped step is `UNTESTED`, not a pass.

## Evidence and cleanup

Preserve the resulting report as offline evidence. The harness stops only the
instance it allocated. Removal of disposable fake data is fixture cleanup; it does
not authorize deletion of retained audit artifacts. A real restore requires a
separate approved dependency map, access procedure, backup verification and human
business decision. This runbook neither sets recovery targets nor passes the live
P3-DR gate.
