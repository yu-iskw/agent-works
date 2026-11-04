# AGT-05 evidence

- Task / owner / date / status: AGT-05, worker agent, 2026-11-03, READY_FOR_REVIEW (capability DEFER, disabled; not VALIDATED)
- Base SHA / result SHA / draft PR: be725be / see branch `epv1/agt-05-06-gates` head / none (no push)
- Changed files: new files under `apps/api/src/capabilities/` and this directory. No scope exceptions. Probe paths for #105, #107 and #111 untouched.

| Criterion                                        | Test/command                                                                        | Result              | Local or live |
| ------------------------------------------------ | ----------------------------------------------------------------------------------- | ------------------- | ------------- |
| Capability disabled by default, fail closed      | `gate.test.ts`, `sandbox.test.ts` "denies by default"                               | PASS                | local         |
| No ordinary worker fallback                      | `sandbox.test.ts` "denies by default ... worker fallback"; sandbox error propagates | PASS                | local         |
| Metadata and credential exfiltration fail safely | `sandbox.test.ts` flaw-injection cases                                              | PASS (offline fake) | local         |
| Unexpected egress, filesystem escape fail safely | same                                                                                | PASS (offline fake) | local         |
| Resource exhaustion and cleanup verified         | same, including adapter-throws-is-breach                                            | PASS (offline fake) | local         |
| Absent real evidence is DEFER, never PASS        | `sandbox.test.ts` "UNTESTED and DEFER", "ignores an offline report"                 | PASS                | local         |
| Live sandbox isolation in `asia-northeast1`      | operator handoff                                                                    | AWAITING_OPERATOR   | live          |

- Positive controls: correct fake holds all six cases; GO record for exact project, scope and digest allows a run; complete sealed evidence reaches PASS / GO-ELIGIBLE.
- Negative and fault cases: each injected flaw, thrown adapter, tampered, partial and wrong-region evidence, expired, DEFER, NO-GO, tampered and mismatched records.
- Migration/backward compatibility: none; no migration, no applied migration edited, nothing wired into routes.
- Rollback: delete the new files; nothing imports them.
- Open risks: seals are integrity checks, not signatures; the matrix probe kinds are an abstraction a real adapter must map to fixed payloads; real sandbox maturity, region, quota and cost are UNKNOWN.
- Operator work still required: [operator-handoff.md](operator-handoff.md).
- Integration validation on combined revision: not run.
