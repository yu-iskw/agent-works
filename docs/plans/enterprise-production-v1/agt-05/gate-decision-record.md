# Gate decision record: sandboxExecution

Default and current verdict: **DEFER**. The capability is disabled. This template becomes an enabling record only when filled by an authorized operator and loaded as a sealed record (`sealGateRecord`, field names below match the schema).

| Field        | Value                                                                    |
| ------------ | ------------------------------------------------------------------------ |
| capability   | `sandboxExecution`                                                       |
| verdict      | `DEFER` (change to `GO` only after evidence review; `NO-GO` on a breach) |
| project      | not set                                                                  |
| scope        | not set (team or segment the approval covers)                            |
| digest       | not set (deployed image digest, 64 hex)                                  |
| signedOffBy  | not set                                                                  |
| approvalRef  | not set                                                                  |
| signedOffAt  | not set (ISO time)                                                       |
| expiresAt    | not set (ISO time; the guard denies after this)                          |
| recordDigest | produced by `sealGateRecord`                                             |

## Evidence reviewed

- Sealed live evidence result from `assessSandboxEvidence`: not provided (`UNTESTED`).
- Probe #111 verdict: `DEFER`, live fields `unverified`.
- Region, quotas, pricing, cleanup measurements: UNKNOWN.

## Decision rule

GO requires `PASS` from sealed operator evidence for all six matrix cases, a named approver, and a record bound to the exact project, scope and digest. Any other state is DEFER, and a breach is NO-GO. A DEFER or NO-GO record, an expired record, or a digest change denies execution. There is no fallback to ordinary worker execution.
