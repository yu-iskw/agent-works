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

## Evidence and cleanup

Preserve the resulting report as offline evidence. The harness stops only the
instance it allocated. Removal of disposable fake data is fixture cleanup; it does
not authorize deletion of retained audit artifacts. A real restore requires a
separate approved dependency map, access procedure, backup verification and human
business decision. This runbook neither sets recovery targets nor passes the live
P3-DR gate.
