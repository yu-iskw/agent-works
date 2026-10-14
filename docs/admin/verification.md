# Verification and remaining operator gate

**The operator drill has not run.** These tests do not satisfy P3-ADM or the
RFC-001 §21 “kill switches exercised” checkbox. The production owner and exit
evidence remain unrecorded. Follow the
[global agent stop runbook](../runbooks/global-agent-stop.md) without changing
its stop sequence.

## Acceptance mapping

| Requirement                                         | Local test                                                                                   |
| --------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| Memory and Postgres shared port semantics           | suspension-ledger.contract.ts, memory/suspension-ledger.test.ts, suspension/postgres.test.ts |
| All seven scopes, tool/model deny, audit and resume | suspension/enforcement.test.ts, policy/suspension.test.ts                                    |
| Store unreachable fails closed                      | suspension/enforcement.test.ts, broker-hook.test.ts                                          |
| Revoked immutable pin stops mid-task                | suspension/runtime.test.ts, enforcement.test.ts                                              |
| Completed writes are not replayed                   | suspension/broker-hook.test.ts                                                               |
| Non-admin and forged roles get 403                  | routes/admin-change.test.ts, e2e/web/admin.spec.ts                                           |
| Exactly one audit event per admin change/retry      | shared ledger contract, routes/admin-change.test.ts                                          |
| Web forms, confirmation and CSRF                    | app/admin/form.test.ts, csrf.test.ts, handler.test.ts, page.test.ts                          |
| Existing web server dispatch                        | app/admin/server.test.ts                                                                     |
| Actual browser against local API/directory/web      | e2e/web/admin.spec.ts                                                                        |
| CLI confirmations and controlled failures           | packages/cli/src/admin.test.ts                                                               |
| Immutable database history                          | suspension/postgres.test.ts database-only cases                                              |
| Bootstrap does not resurrect revoked pins           | suspension/bootstrap.test.ts                                                                 |

The Postgres contract uses a disposable Postgres instance when Docker is
available. When Docker cannot run, it explicitly names its memory fallback;
Postgres-only trigger/transaction/persistence checks are skipped, not presented
as SQL execution. The normal memory contract always runs independently.

The server tests dispatch through the actual Node server request listeners
using IncomingMessage and ServerResponse. They do not need an open localhost
socket. Playwright creates real local HTTP servers and a trusted directory/IAP
fixture, so it additionally checks browser form submission, cookies, escaping,
trusted role revocation between review/apply, and successful suspend/resume.
The smoke fixture uses the memory port if the local Docker stack is unavailable.

## Commands

Build the workspace before the Playwright smoke so its dynamic imports point
to current compiled JavaScript:

```sh
pnpm build
pnpm test
pnpm lint:eslint
pnpm knip
pnpm exec playwright test --config e2e/playwright.config.ts --project=web admin.spec.ts
```

Some checkouts have no root `typecheck` script. In that case record the missing
script and run `pnpm -r exec tsc --noEmit` as the explicit equivalent. Do not edit
unowned package scripts merely to rename that verification.

Format changed supported files using Prettier 3.9.6. The SQL migration follows
the repository's existing lowercase SQL style; Prettier's core has no SQL parser.
Skip Trunk for this bundle, as required by the issue's implementation handoff.

## Operator evidence still required

A human operator must rehearse the accepted runbook in the approved environment,
suspend one agent version, attempt a new tool call, demonstrate its denial and
show the retained audit record. Record the exact scope and immutable pin,
verified actor, task/trace/event IDs, reason, occurrence time and result. Then
review the resume sequence and confirm that completed receipts are not replayed.

A browser screenshot, a local flag, a fake-IAP assertion or a passing unit test
is not that drill. The code and docs do not change readiness matrix ownership,
close a decision ID, authorize a real directory change or assert CI is green.
