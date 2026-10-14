# Data model and transaction contract

## Classification and provenance

The classification order is `PUBLIC`, `INTERNAL`, `CONFIDENTIAL`, `RESTRICTED`.
A classification ceiling permits the same level and lower levels. It does not
provide object access by itself. A read additionally requires the verified
owner, allowed region, allowed origin and current ACL evidence reference.

Each governed record includes:

| Field                       | Meaning                                            |
| --------------------------- | -------------------------------------------------- |
| `schemaVersion`             | Contract version, currently `1`                    |
| `id`                        | Stable artifact identity, never reused after purge |
| `kind`                      | `artifact` or `task-output`                        |
| `taskId`                    | Producing task identity                            |
| `classification`            | One of the four ordered RFC labels                 |
| `provenance.owner`          | Owning user subject                                |
| `provenance.origin`         | Source system, such as `drive`                     |
| `provenance.region`         | Data residency label                               |
| `provenance.sourceId`       | Source object identity for revocation              |
| `provenance.aclEvidenceRef` | Reference to the current access evidence           |
| `retentionClass`            | Immutable retention policy identity                |
| `createdAt`, `expiresAt`    | Valid UTC instants; expiry follows creation        |
| `legalHold`                 | Summary derived from the legal-hold command stream |
| `canonicalHash`             | Canonical SHA-256 of plaintext content             |

Policy TTLs are positive whole seconds with a maximum of 315,360,000 seconds.
This schema bound is not a retention policy approval. Policy descriptions and
TTLs in tests are fixtures. Operators choose approved policy identities and TTLs.
A new TTL requires a new policy identity; an existing policy cannot be rewritten.
The store checks exact agreement between creation, policy TTL and expiry.

Canonical hashes use the existing domain canonicalization helper. They are
stable across object property order. Hashes provide integrity and correlation;
they are not a claim of anonymization or protection against guessing short values.

## Relations in migration 0012

`apps/api/migrations/0012_data_governance.sql` creates:

- `governance_retention_policies`: policy JSON with a constrained TTL projection.
- `governance_artifacts`: provenance and classification with encrypted envelopes.
- `governance_derived`: encrypted child rows with parent foreign keys and cascade.
- `governance_legal_holds`: immutable ordered hold and release commands.
- `governance_deletion_requests`: audited deletion lifecycle summaries.
- `governance_tombstones`: immutable minimal evidence keyed by purged record.
- `governance_audit`: immutable governance events with a redaction marker.
- `governance_revoked_sources`: immutable source intake fences.

Generated columns expose owner, source, classification, expiry and request state
for database constraints and maintenance indexes. Primary keys enforce stable
identity. Parent and retention foreign keys reject orphan data. Envelope checks
reject missing encryption fields, unsupported algorithms and malformed hashes.
Owner, source, expiry, hold target and pending request projections are indexed.

Holds, tombstones, audit, policies and source fences reject SQL UPDATE, DELETE and
TRUNCATE through statement triggers, including statements matching zero rows.
Request rows cannot be deleted. Request triggers fence terminal states, immutable
identity fields and non-advancing revisions. TypeScript validation also checks
the complete request transition evidence chain before each commit.

These controls assume a restricted application database role. A database owner
can disable triggers or drop relations. Use operator access controls around
maintenance and evidence export; append-only triggers do not constrain a database
superuser.

## Port semantics

The port exposes `snapshot()` and `transact(callback)`. Every governance write,
including hold commands, intake, deletion and purge evidence, passes through the
same transaction boundary. Callbacks may be asynchronous but must contain no
network side effects that would escape rollback. Encryption can be prepared
before entry; unwrapping on reads stays inside the serialized decision boundary.

Memory uses a FIFO promise queue and clones state on entry, commit and return.
A rejected callback leaves the previous state intact and does not poison later
operations. Snapshots wait for the current queue and return detached values.

Postgres uses a pooled transaction and advisory transaction lock `7013` to
serialize cooperating governance writers. It reads a draft, validates it, then
persists the diff and evidence in one commit. Result values are detached before
persistence. Loaded database snapshots are validated before exposure, so malformed
stored payloads fail closed instead of being trusted through TypeScript casts. Read snapshots use a repeatable-read, read-only transaction to avoid
mixing different relation versions.

Migration readiness uses advisory transaction lock `7012` and a
`schema_migrations` name. DDL and its applied marker commit together. A failed
initialization clears the cached promise so a later call can retry. Locks are
released automatically on commit, rollback or connection loss.

The global write lock and full-state draft intentionally trade throughput for
simple atomic offline controls. This adapter is suitable for the local pilot.
Large installations need a separate design for bounded SQL selection, per-scope
locks and evidence pagination before adopting this as a high-volume service.

## Consistency checks

Both adapters reject duplicate identities, orphan derived rows, policy mismatch,
tombstoned live artifacts, forged hold summaries, non-contiguous hold sequences,
rewritten evidence, request identity changes and unaudited deletion revisions.
A deletion summary must agree with the final state and timestamp in its audit
chain. Initial evidence must bind the requester and owning subject. Terminal
requests are immutable.

Validation occurs before state replacement or SQL diff persistence. An exception
therefore rolls back the whole operation, including any candidate purge events.
An ordinary callback error has the same rollback behavior.
