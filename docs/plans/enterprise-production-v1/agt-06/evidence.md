# AGT-06 evidence

- Task / owner / date / status: AGT-06, worker agent, 2026-11-03, READY_FOR_REVIEW (capability DEFER, disabled; not VALIDATED)
- Base SHA / result SHA / draft PR: be725be / see branch `epv1/agt-05-06-gates` head / none (no push)
- Changed files: new files under `apps/api/src/capabilities/` and this directory. No scope exceptions. Probe paths for #105, #107 and #111 untouched.

| Criterion                                                | Test/command                                                                       | Result            | Local or live |
| -------------------------------------------------------- | ---------------------------------------------------------------------------------- | ----------------- | ------------- |
| Managed memory disabled by default, fail closed          | `memory-port.test.ts` "denied by default", `gate.test.ts`                          | PASS              | local         |
| Core task recovery with adapter disabled or unavailable  | `memory-port.test.ts` "core task recovery" (absent, denied, unavailable, throwing) | PASS              | local         |
| Memory never supplies authority                          | same file, "never takes state from memory"                                         | PASS              | local         |
| Isolation and deletion semantics of the port contract    | `memory-port.test.ts` "isolates users and deletes" (test double only)              | PASS (double)     | local         |
| Comparison filled from repo and probe evidence           | [comparison.md](comparison.md), UNKNOWN where unverified                           | PASS (document)   | local         |
| Private/shared separation and deletion on a real service | operator handoff                                                                   | AWAITING_OPERATOR | live          |
| Storage and model-processing region recorded             | operator handoff                                                                   | AWAITING_OPERATOR | live          |

- Positive controls: GO record enables the guarded double; recovery uses hints when memory works.
- Negative and fault cases: no record, DEFER, expired, tampered, mismatched project or digest; adapter absent, denied, unavailable or throwing; authoritative store failure still fails loudly.
- Migration/backward compatibility: none; no migration. The existing Postgres memory feature is untouched.
- Rollback: delete the new files; nothing imports them.
- Open risks: the in-memory double is not a managed adapter and proves only the port contract; recovery test uses an injected authoritative loader, not a live Postgres task; every managed-service fact is UNKNOWN.
- Operator work still required: [operator-handoff.md](operator-handoff.md).
- Integration validation on combined revision: not run.
