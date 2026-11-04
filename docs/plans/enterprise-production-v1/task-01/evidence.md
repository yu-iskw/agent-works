# Task completion evidence

- Task / owner / date / status: TASK-01, worker, 2026-11-04 (commit 2026-11-03), READY_FOR_REVIEW (local only, not VALIDATED)
- Base SHA / result SHA / draft PR: merged as `225d15c` (branch `epv1/task-01-owner-route`, "Closes #161"); tests re-run on `f6bdd79` (epv1/integration-cleanup); no PR. PR #174 was closed unmerged per the BASE-00 ledger, so the web route was built here.
- Changed files and scope exceptions: `apps/web/app/tasks/handler.ts`, `handler.test.ts` (new); `apps/web/app/web-app.ts` (3 lines mounting the handler); `apps/api/src/routes/owner-read.test.ts` (new); `e2e/dev/cross-user.spec.ts` (outsider, forged and random-id legs). Source: `git show --stat 225d15c`. No API schema or migration change.

| Criterion                                                       | Test/command                                                                                                                                                                                      | Result            | Evidence path                                                     | Local or live | Revision  |
| --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------- | ----------------------------------------------------------------- | ------------- | --------- |
| Owner reads the correct task                                    | `pnpm exec vitest run apps/api/src/routes/owner-read.test.ts apps/web/app/tasks`: `serves the owner and denies another user, an outsider and forged ids identically`; web `owner sees their task` | PASS              | `routes/owner-read.test.ts`, `apps/web/app/tasks/handler.test.ts` | local         | `f6bdd79` |
| Different user and outsider cannot read, list or infer          | same run: identical denial for another user, outsider and forged ids; `exposes no event, list or traversal path to a non-owner`; web `other users, random ids and lists reveal nothing`           | PASS              | same files                                                        | local         | `f6bdd79` |
| Artifact access has owner positive control and non-owner denial | same run: API `artifact read isolation` (same 404 for another user, random ids and bad refs); web `owner reads an artifact`                                                                       | PASS              | same files                                                        | local         | `f6bdd79` |
| Forged IDs, identity headers and segment assertions denied      | same run: unauthenticated callers and a context minted for another subject rejected; web `forged identity headers and ids are never forwarded or trusted`; malformed paths never reach the API    | PASS              | same files                                                        | local         | `f6bdd79` |
| Existing error conventions preserved; no body reflection        | same run: upstream 403 and 404 never reflect the response body; wrong-id, invalid-schema, redirect, unavailable and transport failures handled                                                    | PASS              | `apps/web/app/tasks/handler.test.ts`                              | local         | `f6bdd79` |
| Live two-user proof through IAP                                 | `e2e/dev/cross-user.spec.ts` with `AW_DEV_USER_A_RESOURCE_PATH` and `AW_DEV_USER_A_PRIVATE_CANARY`; queued under DEP-01, not run here (live)                                                      | AWAITING_OPERATOR | n/a                                                               | live          | n/a       |

Command run: `pnpm exec vitest run apps/api/src/routes/owner-read.test.ts apps/web/app/tasks` exit 0, 3 files, 17 tests passed. The e2e spec was not run; without both env vars it reports BLOCKED rather than passing.

- Positive controls: owner reads own task and artifact.
- Negative and fault cases: another user, outsider, forged token, random id under the same collection, bad refs, upstream failures.
- Migration/backward compatibility: none; the routes are read-only GETs added to aw-web.
- Rollback or forward repair: revert `225d15c`.
- Open risks / decisions / follow-up owner: the web route depends on the API read route's owner scoping; the live proof is owned by DEP-01.
- Operator work still required: the live two-user cross-user run (AWAITING_OPERATOR).
- Integration validation on combined revision: tests above re-run on the integration-cleanup head.
- Postmortem according to repository instructions: skipped; facts reconstructed from git history and test runs.

No fabricated result, elapsed time, cost or live execution. Do not include secrets or raw private source content.
