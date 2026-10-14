# Suspension ledger storage and audit

The operator drill has not run; these storage contracts are local verification,
not P3-ADM or RFC-001 §21 exit evidence. Preserve audit records according to the
[global agent stop runbook](../runbooks/global-agent-stop.md).

## Migration

`apps/api/migrations/0010_suspensions.sql` follows migration 0009 without editing
any earlier migration. The Postgres adapter applies it under a transactional
advisory lock and records its name in `schema_migrations`. Reopening a pool does
not reapply an already recorded migration.

| Table                     | Primary purpose                                      | Identity                   |
| ------------------------- | ---------------------------------------------------- | -------------------------- |
| suspension_states         | Immutable suspend/resume revisions                   | target hash + revision     |
| capability_version_states | Immutable capability lifecycle revisions             | pin hash + revision        |
| suspension_history        | Command claims and authoritative control-plane audit | sequence + unique event ID |

Target and pin keys use the shared canonical SHA-256 algorithm. Version, actor,
reason, expiry, state, revision, command ID and occurrence time are covered by
the persisted record digest. Object key order does not affect a digest. The
canonical serializer rejects non-JSON, accessors, proxies, cyclic/deep objects
and invalid numbers rather than accepting ambiguous payloads.

Latest-state reads select the greatest revision per key. A single SQL statement
reads suspension and capability state under one database snapshot, avoiding a
mixed view across two concurrent commits. Primary key order supports these
latest-revision reads. Audit indexes support actor/task investigations while the
sequence gives deterministic insertion order.

Database triggers reject UPDATE, DELETE and TRUNCATE on all three ledger
tables, including statement-level empty mutations. A resume appends a new row;
expiration changes evaluation, not stored state. Application credentials must
not be database owners able to drop tables or disable triggers. The disposable
test harness drops its own test tables between contracts; production code never
does so.

## Mutation transaction

For one admin mutation the adapter:

1. Validates the strict command and its authenticated actor.
2. Acquires the short mutation lock to arbitrate command IDs across all scopes.
3. Checks a command claim. A same-actor/same-body replay returns the original
   result. A different use of that ID conflicts.
4. Reads current state and validates expected revision, expiry and lifecycle.
5. Inserts one immutable state revision.
6. Inserts exactly one history row containing the result, command digest and
   audit event.
7. Commits both inserts together.

A failed transaction has neither a new state revision nor a new audit row.
Concurrent writers with the same expected revision cannot both succeed. The
lock serializes only small admin changes; invocation reads never acquire it.
This favors a straightforward operational control-plane contract over adding
independent locks whose ordering would complicate audit/command uniqueness.

There is no second asynchronous admin audit write after a committed state
change. `suspension_history.payload` is the authoritative admin audit event and
is visible through the admin audit endpoint. Each row contains its state digest
and reviewed command. Database-backed audit shipping can consume this append-only
history without rewriting it; shipping/retention configuration is outside this
issue.

## Memory adapter

The memory port uses the same command preparation, schemas, hashes, conflict
rules and lifecycle transitions. It commits state, claim and event synchronously
before resolving the mutation promise. Returned snapshots, results and audit
records are deep copies, so a caller cannot mutate ledger state through an
object reference. Its state is ephemeral and is used only for tests/offline
fixtures. The production API always injects the Postgres adapter.

## Denial recording and outages

Every denied invocation creates a new correlation event. Replaying the same
event ID and body is idempotent; a conflicting body or collision with a command
ID is rejected. Snapshot failure never turns into an empty “allow” snapshot.

If the suspension ledger can read but cannot write a denial, the call is still
denied. The independently injected audit fallback attempts the task ledger's
outbox with the same event ID. If both stores fail, side effects remain stopped
and the caller sees a controlled error. Recover the stores and reconcile audit
delivery; do not assert that durable audit exists while all stores are offline.

Admin storage outages return 503. Identical retries retain the original command
ID so an unknown commit outcome can be reconciled without creating duplicate
state or events. Do not use a new command ID just because a response was lost.
