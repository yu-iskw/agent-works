# Opt-in integration contracts

## Budget admission

Supply a trusted `BudgetPolicy` and `BudgetPort` to `budgetGuard`. The same port must
be shared by all tasks in a user window. A task keeps a stable owner, sponsor and
window. The caller chooses operation IDs that identify an inference or parallel
work admission, never one fresh ID for a retry of the same admission.

Reservation checks task and user estimates, inference steps and concurrency together.
Postgres locks accounts in deterministic order and writes reservation evidence in the
same transaction. A denial does not call the operation. `run` releases concurrency
in a finally block; it never refunds already charged estimates or inference steps.
Identical reservation delivery returns the original decision. Altering its amount,
owner or sponsor is an identity conflict. Changing limits does not reinterpret an
already recorded admission decision.

Use `observe` for dev. `isolated-test-enforce` is fixture-only and is not wired into
routes or provider billing. Window lifecycle and authoritative production policy
selection belong to the future authorized integration. No cleanup job resets a
window or deletes evidence.

## Retry adapters

Import the shared domain retry module or the API adapter seam. A provider adapter
explicitly converts a safe transient failure to `ClassifiedError`. Arbitrary provider
errors and error strings never become transient automatically. Supply a monotonic
clock, an absolute deadline, sleep, jitter and a retry pool shared by the outage domain.
The wrapper checks the deadline before starting another attempt and before scheduling
backoff. It cannot preempt a non-cooperative provider call; the adapter must own its
transport timeout and cancellation.

The module has no kill-switch or suspension authority. It does not change existing
adapter files. Never wrap a risky external write in generic automatic retries.

## DLQ and fencing

`stuck` reads task state and durable receipts through the ledger port. Queue creation
requires a trusted original key and risk classification. A requeue reviewer supplies
a current proof obtained through the dispatch port. Requeue persists intent before
scheduling and keeps the original delivery and acceptance key.

A stale lease leaves a pending review entry. A fresh explicit decision is required
after independently checking the delivery and receipts. The service never resets
cancelled/completed tasks, creates a replacement delivery, bypasses fencing, or
automatically replays risky writes. The existing dispatch cancellation and locking
logic remains untouched.

The service is a review seam. It does not itself stop an already running worker.
An integrating worker must enter this review path after it stops executing the
failed task; no caller should continue writes while its operation is under review.
Unknown write receipts require risky classification and compensation review.

## SIEM export and reconciliation

`exportSecurityEvents` constructs a fixed allowlist projection from audit events.
Sensitive labels are pseudonymized even when named model/tool/ID. No prompt, token,
provider payload or arbitrary metadata is copied. Event schema parsing precedes
hashing, so object insertion order does not change chain digests.

A sink deduplicates identical event identities and rejects conflicting copies. The
file sink uses exclusive append files and a cross-process append lock, syncs each
file and verifies the full chain on read. Lock contention fails closed. A stale lock
requires explicit fixture inspection; there is no automatic lock erasure or audit
deletion. Mutation checks are not equivalent to an externally anchored production
WORM guarantee. D-08 still blocks production retention/export selection.

Reconciliation takes independently collected tool receipts and the immutable export.
Matching includes task, step, tool, external reference and request digest. Missing,
unexpected, duplicate or mismatched writes fail. A valid hash chain alone is not
proof of complete export. Empty receipt input proves only an empty fixture.

## SLO measurement

The structured event corpus covers RFC §15.1 fields. Task acceptance latency measures
submission to persisted ID, independently of full task completion. Approval persistence
measures decision to durable ledger. Offline nearest-rank percentiles are calculated
on successful samples. Absent samples are `no_data`, not a passed SLO.

Side-effect keys are task-scoped. Re-delivering the same telemetry event is harmless;
a distinct receipt event for the same side effect is duplication evidence. Audit
capture reconciles receipts to captured events; missing, extra or duplicated capture
fails. Strict target markers and protected IDs prevent arbitrary recorded prompt or
provider fields from being passed through the report tools.

## Readiness gates

P3-SIEM remains blocked on D-08 and dedicated export/access decisions. P3-FIN does
not allow a dev hard stop and needs the later ADR named by ADR 0003 for other projects.
P3-DR is an offline drill only and leaves business recovery decisions under D-10.
All caps, money, targets, retention and the SIEM destination are **PLACEHOLDERS**.
Deletion, dev hard stops and real restores are not authorized.
