# SCH-00 frozen scheduling contracts

Status: proposed for freeze at SCH-00 review. Types and schemas are in `packages/domain/src/dispatch-envelope.ts`. Nothing here changes runtime behavior or a migration. O06 stays open (see the last section).

## 1. Occurrence identity

One logical run per occurrence. The key is the pre-existing `scheduleRunId(scheduleId, fireAt, eventKey)`, the canonical SHA-256 of those three fields.

| Domain | `fireAt`                                                   | `eventKey`       | Database guard (migration 0013)                           |
| ------ | ---------------------------------------------------------- | ---------------- | --------------------------------------------------------- |
| Timed  | canonical UTC instant (`toISOString()`, milliseconds, `Z`) | `null`           | unique `(schedule_id, fire_at)` where `event_key is null` |
| Event  | the event timestamp                                        | source-event key | unique `(event_key)` where `event_key is not null`        |

- Schedule definition revision is never part of the key. It is recorded beside the occurrence (`occurrenceRecordSchema.definitionRevision`, plus `definitionDigest`).
- The identity schema is strict. A `revision` field is rejected, and a non-canonical instant spelling (`...:00Z`, `+09:00`) is rejected, because two spellings of one slot would hash to two keys.
- Execution id for scheduled work equals the occurrence key (`occurrenceExecutionId`).

## 2. Edit semantics

The schedule spec is immutable (id reuse with a different digest is a conflict). The only edits are pause, resume and revoke, each bumping `revision` by one under compare-and-set.

- An edit at due time races the claim. Either order leaves at most one run for the slot: a claim that loses to a pause returns nothing, and after resume the same key is claimed once. A claim that wins keeps its key; later revisions reuse it (`claim` returns nothing, row count stays 1).
- The run stores the revision and digest in force at claim time. Admission still re-checks current state at fire time, as today.
- Resume moves the cursor to the resume instant, dropping paused slots (unchanged).
- A future spec-changing edit must create a new schedule id or a new definition record, never re-key existing occurrences.
- Rejected alternative: `hash(scheduleId, revision, scheduledAt)`. An edit between two dispatchers would give the same slot two keys. Pinned by `characterization-postgres.test.ts` and `dispatch-envelope.test.ts`.

## 3. Queue envelope v1

```json
{ "schemaVersion": 1, "executionId": "<64 hex>", "dispatchId": "d-0001", "correlationId": "corr-1" }
```

- `executionId`: occurrence key. `dispatchId`: one id per publication attempt chain, stable across publish retries. `correlationId`: optional. Ids match `^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$`.
- Strict object, at most 512 bytes serialized. No prompts, bearer tokens, actor claims or authority snapshots. The worker resolves everything server-side from the database.
- Fence and lease are never in the message. The worker takes them from the database claim.
- Versioning: the consumer parses `schemaVersion` first and then the matching strict schema. Additive fields mean a new version, not a loose v1.
  - Newer than the newest supported version: rejected as `unsupported-version`, **retryable** (return a retryable status so a newer revision serves it during a rolling update).
  - Zero, fractional, non-number, malformed, oversize, unknown field: rejected permanently (acknowledge and record, do not loop).
- Rollout order: deploy consumers that read N and N+1, then flip producers to N+1, then retire N after the queue has drained (retention bound). Tests: `createEnvelopeReader` with `{1, 2}` reads old messages; the v1 reader defers v2.
- Fixture: the byte string above is pinned in `dispatch-envelope.test.ts`.

## 4. Outbox record

Written in the claim transaction with the occurrence; published outside it. Duplicate publish is expected.

| Field                                                                                                 | Meaning                                                                                                                                                                           |
| ----------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `dispatchId`                                                                                          | primary key and stable event id                                                                                                                                                   |
| `executionId`                                                                                         | occurrence key, unique per live dispatch chain                                                                                                                                    |
| `targetKind`                                                                                          | `cloud-tasks-http`                                                                                                                                                                |
| `transportName`                                                                                       | `d-` + SHA-256 of `dispatchId`; stable Cloud Tasks name. Never the only dedupe: a lost ack is resolved by database identity, and Cloud Tasks reserves a deleted name for a while. |
| `envelope`                                                                                            | the v1 payload (the minimal payload reference)                                                                                                                                    |
| `state`                                                                                               | `pending`, `published`, `abandoned`                                                                                                                                               |
| `attempts`, `nextAttemptAt`, `leaseOwner`, `leaseUntil`, `lastErrorClass`, `createdAt`, `publishedAt` | retry, lease and publish state; error class only, never raw provider text                                                                                                         |

Invariants are in `outboxRecordSchema` (envelope matches row identity, transport name derives from the id, lease fields travel together, `publishedAt` set exactly when published).

## 5. Migration and cutover: one writer

Reserved migration (SCH-01, not written here): additive only.

1. **Expand.** Add an indexed due column (or a `schedule_due` table keyed by schedule id with `next_due`), an `outbox` table, and a singleton `scheduler_owner(owner text, generation int)` row set to `legacy`. Keep `schedule_runs` and both unique indexes untouched. They remain the duplicate backstop for both writers throughout.
2. **Dual-read.** Readers accept state from the JSON payload cursor and from `next_due`. Deploy before any writer change.
3. **Backfill.** Resumable, idempotent: `next_due` from the payload cursor and spec. Validate: counts equal, no schedule without a due row, no duplicate `(schedule_id, fire_at)`.
4. **Flip.** In one transaction holding advisory lock 7013 (so no legacy transaction is in flight), set `owner = 'rowclaim'`, bump `generation`. Legacy transactions read the owner row under the same lock and refuse to write unless `legacy`. New claim transactions take the owner row `FOR SHARE` and refuse unless `rowclaim`. At most one writer can commit at any instant.
5. **Observe.** Duplicate count (must stay 0), outbox age, claim skew, missed slots.
6. **Rollback.** Drain or park the outbox, flip back under the lock, and repair the legacy cursor to the latest claimed slot per schedule from `schedule_runs`. Forward repair if a schema step cannot be undone.
7. **Contract (later).** Drop the legacy path only after an observation window. Restore into a separate approved environment before the flip (operator item, AWAITING_OPERATOR).

## 6. O06 recommendation: Cloud Workflows ownership

Recommendation only; O06 remains open for the architecture owner. The ledger is authoritative for every function. Cloud execution state never overwrites it (existing runbook rule).

| Durability function                                   | Recommended owner                                                                     |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------- |
| Occurrence uniqueness, claim, cursor                  | Postgres (row claim)                                                                  |
| Dispatch handoff, publish retry, backoff              | Outbox plus Cloud Tasks                                                               |
| Lease, fence, stale-worker rejection                  | Postgres compare-and-swap                                                             |
| Expired or unstarted work recovery, queue-loss repair | Database reconciler                                                                   |
| Step sequencing and checkpoints                       | Postgres checkpoints and the existing engine; steps bounded below the HTTP deadline   |
| Retry budget, exhaustion, quarantine                  | Application ledger                                                                    |
| Long human waits (approval, input) and wake-ups       | Keep Cloud Workflows as an optional, disabled-by-default wake-up hint; ledger decides |
| Waits beyond bounded steps                            | Revisit trigger for a workflow engine or Cloud Run Jobs, per spec 01                  |

Keep `apps/api/src/workflow/cloud-workflows.ts` and its tests; do not route scheduled dispatch through it; delete nothing until SCH-01 onward replaces each function. Dependency boundary: SCH-01 may rely on sections 1 to 5 as frozen.

## 7. Coordinator wiring

- Add `export * from './dispatch-envelope.js';` to `packages/domain/src/index.ts` (and a package export if consumers need a subpath).
- Add `scripts/sch-00/*.mjs` to the root knip `entry` list if knip flags the runner.
