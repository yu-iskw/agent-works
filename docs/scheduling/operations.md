# Time, recovery, cancellation and audit

## Slots and polling

The worker polls with an injected clock and processes schedule rows serially.
Two worker instances may run against one store. Atomic claims identify a timed
run by the canonical hash of schedule ID and UTC fire time. A unique database
index enforces one timed run per schedule/time slot. Event runs additionally
include a source-event key and use a separate unique index, so two distinct
events arriving at the same instant can each create a task.

Interval timing is anchored rather than relative to polling. The minimum
interval is sixty seconds. Cron accepts five numeric fields with wildcard,
lists, ranges and positive steps. Month day and weekday follow standard OR
semantics when both are restricted; when either is a wildcard the restricted
field must match. Named fields, macros and seconds fields are rejected.

Timezone evaluation uses IANA zones through `Intl.DateTimeFormat`. UTC instants
identify slots, so repeated local times during a DST fall-back are separate
slots. A nonexistent spring-forward minute has no UTC slot. Allowed windows
are start-inclusive and end-exclusive. Equal start and end means the entire
selected local day. Overnight windows attribute the after-midnight tail to the
previous selected weekday. Expiry is exclusive.

Both the original slot and the current fire time must be allowed. Catch-up
never executes a slot from a previously open window after that window closes.
`catch-up-once` selects only the latest missed slot, avoiding outage floods.
`skip` allows less than one minute of polling delay and drops older slots.
Cron catch-up scans at most one year; older outages are intentionally discarded.
Resume moves the cursor to the resume instant, dropping paused slots.

## Crash recovery

Claims lease a run for thirty seconds and increment its fencing token on
recovery. A stale worker cannot finish after another worker takes over. A run
that is already accepted, denied, completed or cancelled is never claimed again.
Cursor advancement happens after dispatch, so a failed operation remains
recoverable. Expired dispatching leases are retried even if the cursor moved.

The local workflow engine runs a dispatch step and stores its receipt. Every
attempt passes the stable `schedule:<run digest>` idempotency key to the existing
dispatch port. An uncertain acceptance can be retried without creating a second
task. Recovery uses the new fence for the workflow checkpoint identity so a
failed engine attempt cannot permanently trap an otherwise recoverable run.
The received-event receipt is committed in the same transaction as the claim;
recovery loads that receipt without accepting a second webhook delivery.

The offline Postgres adapter serializes mutations with advisory lock 7013 and
uses schema-validated snapshots plus changed-row writes. This deliberately
favors inspectable local correctness over high-throughput cloud scheduling.
Read transactions also serialize for a consistent view. The memory adapter
uses clone-on-transaction semantics and rolls back the entire draft on error.

## Revocation and task cancellation

Sponsor deprovisioning, any lost ceiling dimension, revoked consent or expiry
permanently revokes an active schedule. Pause blocks new work but is resumable
while consent and authority remain valid. Revocation is irreversible.
Transient directory or store errors fail closed without fabricating a sponsor
revocation. Their runs can be retried after recovery.

Each tick reconciles in-flight accepted tasks. Revocation cancels through the
existing `createTaskRoutes(...).cancel` control-plane path, which transitions
the task ledger and preserves existing dispatcher behavior. A cancellation
failure does not mark the run cancelled: a later tick retries it. The scheduler
also rechecks after dispatch so a pause or revoked consent during acceptance
cancels the newly accepted task as soon as it is linked.

Already-completed external side effects cannot be undone. Cancellation signals
the existing task state; it does not replay or compensate completed writes.
Terminal task reconciliation releases scheduler concurrency. Audit records
retain creation, control changes, claims, event receipts and run outcomes.
The database rejects update, delete and truncate of the schedule audit table.

## Shutdown

The worker's stop aborts its polling delay and waits for any pending tick.
The API stops both the task dispatcher and scheduler before ending the SQL pool.
Worker errors emit only a fixed diagnostic message, never event bodies, keys,
configuration contents or environment values.
