# Task worker lifecycle

`POST /v1/tasks` authenticates, validates and authorizes the request, then calls
`DispatchPort.accept`. Acceptance commits the task, submission event and delivery
in one transaction before returning the persisted ID. Fetch, model inference and
ticket writes run in the worker. Replaying the same subject and idempotency key
retains the first payload, policy decision and deadline; fresh decision IDs and
recomputed deadlines do not change the acceptance digest.

The delivery contains the complete request, agent identity, user subject, policy
decision, source restrictions, execution bounds and authorization context. It does
not contain an IAP bearer assertion. A new process reconstructs dispatch from
this snapshot and the configured skill registry. Inject matching dispatch and
ledger adapters into the API; the default local pair shares one memory store.
Existing deliveries from the earlier, incomplete payload contract must be drained
before upgrading: the missing objective and authorization context cannot be
reconstructed from task digests.

The API starts a polling worker with a unique worker ID. Each claim issues a fence
and a 30-second lease, renewed every 10 seconds while delivery runs. Worker
transitions require that exact, unexpired lease. Postgres locks the delivery before
the task and checks the fence in the same transaction as the status, event and
receipt write. Memory uses one snapshot commit. Task versions also prevent late
success from replacing cancellation or another terminal result. The existing
cancel endpoint persists cancellation for dispatched tasks; local workflow tasks
continue to use their workflow cancellation handler.

A fresh delivery records `QUEUED → RUNNING`, then `COMPLETED`, `FAILED`,
`CANCELLED` or `BLOCKED_AUTH`. A reclaimed `RUNNING` delivery resumes without
another running event. Missing, revoked or changed skill versions park the task
in `BLOCKED_AUTH`, which is excluded from automatic claims. History comes from
the ledger outbox and survives route/worker restarts.

Ordinary delivery failures use persisted exponential backoff (1 second initially,
capped at 60 seconds), with five attempts by default. An expired execution deadline
fails the task after checking for a committed receipt. Receipt lookup and ledger
persistence failures remain retryable, even after that deadline or attempt limit,
because declaring failure could abandon a committed external write. The incident
worker queries the ticket store by the original task ID before execution and after
an unsuccessful delivery. Ticket creation uses that same ID as its idempotency
key. Recovery records the original ticket reference and digest atomically with
completion; it never generates another delivery ID.

On `SIGINT` or `SIGTERM`, the API stops accepting requests, aborts active worker
execution, schedules its retry, drains the worker and HTTP server, then closes
Postgres. If the process dies before retry scheduling, another worker can reclaim
the expired lease. External tools must honor stable idempotency keys and expose an
authoritative receipt lookup; lease fencing protects ledger writes, while tool
idempotency protects external writes.

For local validation, run API `tsc --noEmit`, ESLint, Prettier and Vitest. The
shared dispatch/worker contracts exercise memory and disposable Postgres. The task
HTTP contract includes a 40-submission, concurrency-8 load script with a
submit-to-persisted-ID p95 target below 3 seconds. If disposable Postgres cannot
initialize because Docker storage is full, report that validation as blocked;
do not prune Docker.
