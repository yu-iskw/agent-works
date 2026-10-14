# Offline data governance

This bundle implements the local data controls from RFC-001 §8.5, §9 and §13.4.
It covers the governance artifact store and its derived data in memory or Postgres.
It supplies a trusted admin HTTP surface, a CLI client, a retention workflow,
restore reconciliation, authenticated envelope encryption and export redaction.

Managed Memory Bank and Sessions deletion semantics remain **operator evidence
pending** under issue #107. Passing a local deletion test is not evidence of cloud
service deletion, backup expiration, media sanitization or residency of inference.

## Operator guides

- [Data model and transaction contract](data-model.md)
- [Retention, holds and deletion](retention-and-deletion.md)
- [Offline restore drill](restore-drill.md)
- [Encryption and redaction boundaries](encryption-and-redaction.md)
- [Admin API and CLI](admin-api.md)
- [Acceptance and validation](validation.md)

## Composition

The implementation lives in `apps/api/src/governance/`. The domain contract lives
in `packages/domain/src/data-governance.ts`. The adapters implement
`apps/api/src/ports/governance.ts` and run the same shared contract.

Build the workspace before using the compiled API. This issue does not change the
domain package export map; `governance/model.ts` re-exports the compiled contract
from `packages/domain/dist/data-governance.js`. Source and compiled API files have
the same relative depth, so this reference survives compilation.

A local composition follows this order:

1. Create a memory port or a Postgres pool and `createPostgresGovernancePort(pool)`.
2. Create one `createLocalKms()` instance for the lifetime of the local process.
3. Create `createArtifactStore(port, keys, now)` with an explicit clock.
4. Register immutable retention policies through `store.policy(policy)`.
5. Supply verified IAP identity, trusted directory roles and trusted read contexts.
6. Mount `createGovernanceApp({ app, registration, artifacts })` as a Node listener.
7. Schedule retention work using the existing local workflow engine.
8. Keep the service offline during any restore until evidence replay succeeds.

`registration.governance.port` and the artifact store must reference the same
port. `registration.governance.rolesFor` is a trusted directory resolver. A role
header or a field in an incoming command must never populate this resolver.

`artifacts.contextFor` returns the current subject, classification ceiling,
regions, source origins and ACL evidence references from trusted authorization
inputs. It must refresh these decisions when directory or ACL state changes.
The artifact route checks that the returned subject matches the verified caller.

The existing route table can register a small memory governance surface alongside
its trusted admin dependencies. That convenience store lasts only as long as the
route table. Use explicit governance composition for durable data and artifact
reads. A new memory store is never a substitute for a failed Postgres adapter.

## Maintenance entry point

`runRetentionSweep(engine, port, taskId, now)` executes a sweep as a step of the
existing local engine. Use a new maintenance task identity for each scheduled
invocation. Reuse the identity only to recover the same invocation. The receipt
contains counts rather than document identifiers or content.

The offline runtime does not start its own timer or contact managed services.
The embedding process owns scheduling, pool lifecycle, trusted evidence storage
and the decision to reopen traffic after a restore.

## Evidence boundaries

| Data                                     | Live representation                    | Deletion behavior                    |
| ---------------------------------------- | -------------------------------------- | ------------------------------------ |
| Artifact / task output                   | Provenance plus encrypted envelope     | Physical row removal                 |
| Index, cache, task event, derived output | Parent-linked encrypted envelope       | Removed with parent                  |
| Retention policy                         | Immutable policy revision identity     | Retained                             |
| Legal hold                               | Append-only command stream             | Retained, release is another command |
| Deletion request                         | State summary plus audited transitions | Retained                             |
| Purge evidence                           | Minimal tombstone and audit projection | Retained                             |
| SIEM export                              | Allowlisted hashed governance marker   | Retained, raw payload omitted        |
| Offline backup                           | Operator-controlled snapshot           | Reconcile before serving a restore   |
| Managed service                          | Outside this offline adapter           | Operator evidence pending (#107)     |

The governance derived relation is the fan-out registry for this store. The
bundle does not erase unrelated task ledger tables, rewrite the existing audit
chain, or claim to discover unregistered copies in other systems. Producers must
register derived copies through this boundary to receive its purge guarantees.
