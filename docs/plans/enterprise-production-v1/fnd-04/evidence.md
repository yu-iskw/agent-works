# Task completion evidence

- Task / owner / date / status: FND-04, worker, 2026-11-04 (commit 2026-11-03), READY_FOR_REVIEW (local only, not VALIDATED)
- Base SHA / result SHA / draft PR: merged as `2b87554` (branch `epv1/fnd-04-suspension`); tests re-run on `f6bdd79` (epv1/integration-cleanup); no PR
- Changed files and scope exceptions: new `apps/api/src/suspension/admin-denial.ts`, `admin-denial.test.ts`, `outstanding.ts`, `stop-control.postgres.test.ts`; edited `docs/runbooks/global-agent-stop.md`. The suspension ledger, enforcer and migration `0010_suspensions` already existed (BASE-00 ledger) and are reused unchanged. Source: `git show --stat 2b87554`.

| Criterion                                                                                     | Test/command                                                                                                                                               | Result            | Evidence path                              | Local or live | Revision  |
| --------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------- | ------------------------------------------ | ------------- | --------- |
| Global, team, user, agent, skill, model and tool suspension deny the next effect after commit | `pnpm exec vitest run apps/api/src/suspension/stop-control.postgres.test.ts` (7 scope cases on disposable Postgres, Docker was up, none skipped)           | PASS              | `suspension/stop-control.postgres.test.ts` | local         | `f6bdd79` |
| Restart preserves stop state                                                                  | same cases: a second connection and a fresh enforcer deny `tool` and `model` after the stop, then resume restores service                                  | PASS              | same file                                  | local         | `f6bdd79` |
| Concurrent stop and dispatch never starts an effect after the stop commits                    | same file, `concurrent stop and dispatch never lets an effect start after the stop commits`                                                                | PASS              | same file                                  | local         | `f6bdd79` |
| Completed writes stay visible and are not marked undone; running work is uncertain            | same file, `completed writes stay visible and are never reported as undone`; task rows are unchanged after `listOutstandingOperations`                     | PASS              | same file, `suspension/outstanding.ts`     | local         | `f6bdd79` |
| Unauthorized resume denied, stop stays, actor and reason recorded                             | `pnpm exec vitest run apps/api/src/suspension` (admin-denial: unauthorized, unauthenticated without a fabricated actor, authorized not recorded as denial) | PASS              | `suspension/admin-denial.test.ts`          | local         | `f6bdd79` |
| Incident instructions and audit                                                               | review of `docs/runbooks/global-agent-stop.md`                                                                                                             | PASS (review)     | `docs/runbooks/global-agent-stop.md`       | local         | `2b87554` |
| Stop, resume and a non-admin denial against the deployed dev stack                            | operator runs the runbook steps on dev with real IAP identities                                                                                            | AWAITING_OPERATOR | n/a                                        | live          | n/a       |

Command run: `pnpm exec vitest run apps/api/src/suspension` exit 0, 7 files, 76 tests passed.

- Positive controls: an authorized admin resume succeeds and is not logged as a denial; service resumes after each scope's resume.
- Negative and fault cases: non-admin and unauthenticated resume, stale revision (runbook: 409, changes nothing), store unreachable denies (runbook).
- Migration/backward compatibility: no new migration; `0010_suspensions` is untouched.
- Rollback or forward repair: revert `2b87554`; resume is a new revision and nothing is deleted.
- Open risks / decisions / follow-up owner: `server.ts` and `routes/index.ts` reference `auditAdminDenials` and `listOutstandingOperations` on the integration head; that wiring was done by the coordinator and its behavior is not asserted in these tests. The runbook says a stop cannot undo a committed external write.
- Operator work still required: live dev stop and resume drill (AWAITING_OPERATOR).
- Integration validation on combined revision: unit and Postgres tests above re-run on the integration-cleanup head.
- Postmortem according to repository instructions: skipped; facts reconstructed from git history and test runs.

No fabricated result, elapsed time, cost or live execution. Do not include secrets or raw private source content.
