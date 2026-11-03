# AGT-05 isolated code execution gate

Status: **DEFER, capability disabled.** No sandbox is wired, no real probe result exists, and nothing in this task is validated. READY_FOR_REVIEW means the guard, contract and offline harness exist, not that execution is safe.

## What exists

| Piece              | File                                            | Behavior                                                                                                                                                                            |
| ------------------ | ----------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Capability guard   | `apps/api/src/capabilities/gate.ts`             | `sandboxExecution` and `managedMemory` are denied unless a sealed GO record matches capability, project, scope, deployed digest and is unexpired.                                   |
| Execution contract | `apps/api/src/capabilities/sandbox-contract.ts` | `ExecutionRequest` (limits, network `none` by default), `ExecutionResult`, `ArtifactEntry` (only scan `clean` may be released), `SandboxPort`, `createGuardedSandbox`.              |
| Negative matrix    | `apps/api/src/capabilities/sandbox-matrix.ts`   | Six cases against any `SandboxPort`. Output is labeled `offline-fake`.                                                                                                              |
| Fake sandbox       | `apps/api/src/capabilities/fake-sandbox.ts`     | Deterministic, with injectable flaws, to prove the matrix catches each failure.                                                                                                     |
| Evidence ingestion | `assessSandboxEvidence` in the matrix file      | Absent, malformed, partial, tampered or wrong-region evidence is `UNTESTED` and `DEFER`. A breach is `FAIL` and `NO-GO`. Complete sealed evidence is `PASS` and only `GO-ELIGIBLE`. |

## Fail-closed rules

1. The guard has no records by default. Malformed records are dropped, not repaired.
2. `createGuardedSandbox` takes no worker or fallback executor. A denial throws `CapabilityDisabledError` before the sandbox is touched, and a sandbox error propagates. Ordinary worker execution is never a fallback.
3. Offline fake results never feed `assessSandboxEvidence`. A passing fake does not move the gate.
4. The seal on gate records and evidence detects alteration only. It is not a signature. Authenticity depends on loading records from operator-controlled configuration.
5. A `GO-ELIGIBLE` status does not enable anything. Enablement needs a signed gate record per [gate-decision-record.md](gate-decision-record.md).

## Negative-test matrix

| Case                      | Hostile probe                     | Held when                        |
| ------------------------- | --------------------------------- | -------------------------------- |
| `metadata-exfiltration`   | fetch the metadata server         | probe does not reach it          |
| `credential-exfiltration` | read ambient credentials          | none visible                     |
| `unexpected-egress`       | connect outward with network none | connection fails                 |
| `filesystem-escape`       | read a host file                  | read fails                       |
| `resource-exhaustion`     | memory bomb, CPU spin, wall hang  | each ends as `killed-limit`      |
| `cleanup`                 | normal, hung and artifact runs    | `residue` is zero after each run |

An adapter that throws counts as a breach of that case.

## Reuse and limits

The live evidence is owned by probe #111 (`docs/spikes/agent-platform/sandbox.md`, `.json`), currently `UNVERIFIED / DEFER` with every live field `unverified`. This task does not edit those paths. Product, launch stage, region support, quotas and pricing are unknown. An ordinary Cloud Run deployment is not sandbox proof (spec 06).

## Wiring the coordinator must do

None is required for the default state. To enable later, the composition root builds one guard from operator-supplied records (`createCapabilityGuard(records)`), wraps any real adapter with `createGuardedSandbox`, and routes every code-execution call through it. Until then no route calls it.

Related: [operator-handoff.md](operator-handoff.md), [gate-decision-record.md](gate-decision-record.md), [evidence.md](evidence.md).
