# Gate decision record: managedMemory

Default and current verdict: **DEFER**. The capability is disabled. This template becomes an enabling record only when filled by an authorized operator and loaded as a sealed record (`sealGateRecord`, field names below match the schema).

| Field        | Value                                                                            |
| ------------ | -------------------------------------------------------------------------------- |
| capability   | `managedMemory`                                                                  |
| verdict      | `DEFER` (change to `GO` only after evidence review; `NO-GO` on a failed control) |
| project      | not set                                                                          |
| scope        | not set (user segment or audience the approval covers)                           |
| digest       | not set (deployed image digest, 64 hex)                                          |
| signedOffBy  | not set                                                                          |
| approvalRef  | not set                                                                          |
| signedOffAt  | not set (ISO time)                                                               |
| expiresAt    | not set (ISO time; the guard denies after this)                                  |
| recordDigest | produced by `sealGateRecord`                                                     |

## Evidence reviewed

- #107 Memory Bank probe: `DEFER`, deletion and retention `unverified`.
- #105 Agent Runtime and Sessions probe: `DEFER`, live fields `unverified`.
- Storage region: UNKNOWN. Model-processing region: UNKNOWN. Both must be recorded before GO.
- Cost and quota: UNKNOWN.
- Core recovery with adapter disabled: PASS locally (`memory-port.test.ts`); live check AWAITING_OPERATOR.

## Decision rule

GO requires real approved evidence of private and shared separation and deletion, both regions recorded, a named approver, and a record bound to the exact project, scope and digest. Anything else is DEFER. A DEFER or NO-GO record, an expired record, or a digest change denies every memory call. Core task recovery never depends on this decision.
