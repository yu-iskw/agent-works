# AGT-06 memory and session options comparison

Status: **DEFER, managed adapter disabled.** Every managed-service cell is UNKNOWN because probes #105 (Agent Runtime and Sessions) and #107 (Memory Bank) are `UNVERIFIED / DEFER` with all live fields `unverified` (`docs/spikes/agent-platform/runtime.json`, `memory.json`). Nothing here claims a managed feature exists, is GA, or is available in `asia-northeast1`.

## Evidence sources

- Postgres column: repo code and Terraform. Cited per cell.
- Managed column: probe JSON files only. They contain no live observation.
- UNKNOWN means no repo or probe evidence. It is not a negative finding.

## Comparison

| Dimension                    | Current Postgres persistence (repo evidence)                                                                                                                                                                             | Managed Memory Bank / Sessions (probe evidence)                                                |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------- |
| Isolation                    | Owner and agent scoped rows (`user_memory_items` keyed by tenant, owner, agent). Tests: `apps/api/src/memory/isolation.test.ts`, `acl.test.ts`. Private, shared, cross-agent denial are exercised locally.               | UNKNOWN. #107 negative cases are synthetic only. Cross-user and cross-agent denial unverified. |
| Authority                    | Memory never grants authority. Source ACL rechecked at recall (`recall.ts`, `provenance.test.ts`); revoked sources tracked.                                                                                              | UNKNOWN. Read-time authority recheck unverified.                                               |
| Deletion                     | Physical erasure with tombstones (`evidence.ts` `purgeMemory`, `deletion.test.ts`), owner delete, expiry sweep (`lifecycle.ts`, `expiry.test.ts`), legal holds (`holds.test.ts`). Backups retained per Cloud SQL policy. | UNKNOWN. Deletion acknowledgement vs erasure, derived memories, logs and backups unverified.   |
| Storage region               | `asia-northeast1` Cloud SQL via `infra/terraform/modules/cloud_sql` and ADR 0003. Deployed instance location not verified from this checkout.                                                                            | UNKNOWN (#107 `storageRegion: unverified`).                                                    |
| Model-processing region      | Not applicable to storage. Inference location is checked separately in C-02 (#20) and is UNKNOWN here.                                                                                                                   | UNKNOWN (`processingRegion: unverified`). Must be recorded separately from storage.            |
| Retention and expiry         | Per-row `expires_at`, sweep, consent and opt-out (`consent.test.ts`, `expiry.test.ts`).                                                                                                                                  | UNKNOWN (`retention: unverified`).                                                             |
| Export                       | `apps/api/src/memory/export.ts`, `export.test.ts`.                                                                                                                                                                       | UNKNOWN.                                                                                       |
| Recovery                     | Cloud SQL point-in-time recovery enabled in Terraform; `restore.ts` merges tombstones and holds on restore (`restore.test.ts`). Restore drill is operator work (P06).                                                    | UNKNOWN. Session restart and recovery unverified (#105).                                       |
| Cost                         | Database cost only, no per-memory service charge identified. Amount UNKNOWN.                                                                                                                                             | UNKNOWN (`pricingSource: unverified`).                                                         |
| Quotas and maturity          | Postgres limits not assessed.                                                                                                                                                                                            | UNKNOWN (`quotaSource`, `maturity: unverified`).                                               |
| Core recovery if unavailable | Authoritative task state is Postgres. Tested: `capabilities/memory-port.test.ts` recovers with the adapter absent, denied, unavailable or throwing.                                                                      | Must not be required. Adapter outage must degrade to no hints.                                 |

## Reading the table

Postgres meets the isolation and deletion requirements locally. That is code-and-test evidence, not a live deletion or restore proof. A managed adapter needs live evidence for every UNKNOWN row before a GO is possible. Until then the fallback in both probe files applies: leave Memory Bank disabled and use short-lived authorized session context without personalization.

## Adapter boundary

`apps/api/src/capabilities/memory-port.ts` defines `SessionMemoryPort` with a `disabledMemory` default and an in-memory test double. There is no managed implementation. `guardMemory` asks the capability guard on every call. `recoverTask` reads authoritative state first and treats memory as optional hints.

Shared-bot memory needs an explicit audience and must not transfer private-user history by default (spec 06). Neither is implemented here.

Related: [operator-handoff.md](operator-handoff.md), [gate-decision-record.md](gate-decision-record.md), [evidence.md](evidence.md).
