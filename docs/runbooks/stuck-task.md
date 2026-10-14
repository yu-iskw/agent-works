# Stuck task: explicit dead-letter review

## Authority and gates

This is the offline RFC-001 §15.3/§19.1 review procedure. Caps, amounts and retention
are **UNAPPROVED PLACEHOLDERS**. **Deletion, dev hard stops and real restores are not
authorized** under D-08, D-10 and [ADR 0003](../adr/0003-pilot-decisions.md).
No write adapter is called by compensation recording, and risky writes are never
replayed automatically. The queue stores references and fixed reason codes, not
prompts, bearer tokens, provider exceptions or write payloads.

## Triage

1. Read the task through the ledger port and inspect the existing dispatch lease.
   Obtain a current fencing token through the dispatch port, never by inventing one.
2. Inspect independent external receipts and the ledger receipt. Completed, cancelled,
   failed, blocked-authority or already receipted work cannot be requeued by this service.
3. Determine the original idempotency key and side-effect risk from trusted ledger and
   tool evidence. `riskyWrite` must describe the operation being reviewed, not an
   operator's desire to retry it. Unknown write state belongs in risky review.
4. Add a stuck entry with task ID, original key, owner subject, reason and timestamp.
   Duplicate task/key entries fail instead of minting another replay identity.
5. Preserve evidence and identify the reviewer. The offline queue is not a substitute
   for production RBAC or segregation-of-duties decisions.

## Offline CLI

After `pnpm build`, use a fixture JSON file pointing to the local disposable database
created for the test. The driver checks `issue135_disposable_marker` and rejects
unmarked or non-local databases. It does not initialize a live database.

```bash
node packages/cli/dist/aw.js dlq list --fixture /tmp/disposable-review.json
node packages/cli/dist/aw.js dlq requeue --fixture /tmp/disposable-review.json
node packages/cli/dist/aw.js dlq compensate --fixture /tmp/disposable-review.json
```

The file contains `databaseUrl`, a fixed fixture `now`, `entryId`, and a `review` object
with `decisionId`, `operator`, `reason`, `occurredAt`. Requeue additionally requires a
current `lease` (`taskId`, `workerId`, `fencingToken`), an explicit `at` timestamp and
`attempt`. Compensation requires an independent `evidenceRef`. Never place a token,
prompt, live database connection or personal data in this file.

## Requeue

Requeue only a safe operation with reviewed receipts and a live matching lease. The
service persists `requeue_pending` and the operator decision before calling
`DispatchPort.scheduleRetry`. It uses the existing task/delivery; it does not call
accept with a new idempotency key, reset fencing, or modify cancel logic.

If scheduling fails or the operator process crashes, leave the entry pending. Inspect
its decision and delivery state before acquiring a fresh lease and issuing a new
explicit review. A pending entry does not mean an external operation is safe to retry.
A crash after scheduling but before recording `requeued` is an ambiguous review,
not permission for another replay. There is no automatic pending-intent drainer.

## Compensation

A risky write requires explicit compensation review. Obtain approval and independent
proof through the established tool-owner process before recording the evidence. This
command records that evidence; it does not undo an external action or create a new
one. The original idempotency key and operator decision remain available.

## Closure

Confirm the decision, preserved key, current task state and receipt reconciliation.
Keep original evidence under the unresolved retention gate. Do not delete an entry,
blindly replay a write, cancel tasks through direct SQL, or reuse an expired lease.
