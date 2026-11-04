# Task completion evidence

- Task / owner / date / status: FND-02, worker, 2026-11-04 (commit 2026-11-03), READY_FOR_REVIEW (local only, not VALIDATED)
- Base SHA / result SHA / draft PR: merged as `e9c8cc4` (branch `epv1/fnd-02-startup`); tests re-run on `f6bdd79` (epv1/integration-cleanup); no PR
- Changed files and scope exceptions: `apps/api/src/startup/providers.ts`, `ports.ts`, `providers.test.ts` (new); `apps/api/src/server.ts` (composition root swapped to `assertStartup` and `buildProviderPorts`); `apps/api/src/skills/incident.ts` and `incident.test.ts` (server-resolved incident authority). Source: `git show --stat e9c8cc4`. `server.ts` is a shared file that the common brief reserves for the coordinator.

| Criterion                                                               | Test/command                                                                                                                                                                                         | Result            | Evidence path               | Local or live | Revision  |
| ----------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------- | --------------------------- | ------------- | --------- |
| Production mode rejects each fake or missing required provider alone    | `pnpm exec vitest run apps/api/src/startup` (parametrized `rejects %s individually`: identity, model, source-storage, authority-persistence, oauth-credentials, required-config, incident-ticketing) | PASS              | `startup/providers.test.ts` | local         | `f6bdd79` |
| Rejection names providers and env variables without echoing values      | same file, `names providers and env variables without echoing any value`                                                                                                                             | PASS              | `startup/providers.test.ts` | local         | `f6bdd79` |
| Dev stack flag and unknown mode rejected in production                  | same file, `rejects the dev stack flag in production` and `rejects an unknown mode`                                                                                                                  | PASS              | `startup/providers.test.ts` | local         | `f6bdd79` |
| Local mode still works with fakes                                       | same file, `keeps local mode working with fakes`                                                                                                                                                     | PASS              | `startup/providers.test.ts` | local         | `f6bdd79` |
| Valid config builds real ports with no network call in CI               | same file, `builds real ports from valid config without any network call` (fetch spy not called)                                                                                                     | PASS              | `startup/providers.test.ts` | local         | `f6bdd79` |
| Provider outage never returns a fake result                             | same file, `surfaces a directory outage as an error` (fetch rejects, `groups()` rejects)                                                                                                             | PASS              | `startup/providers.test.ts` | local         | `f6bdd79` |
| Incident skill decides from server-resolved authority                   | `pnpm exec vitest run apps/api/src/skills/incident.test.ts`: denied reauthorize gives `revoked` with no write; unreadable authority gives retryable `failed`, not `revoked`                          | PASS              | `skills/incident.test.ts`   | local         | `f6bdd79` |
| Real ports behave against live Postgres, Directory, Drive, model, OAuth | operator starts the production-mode API against the real providers and records the provider report                                                                                                   | AWAITING_OPERATOR | n/a                         | live          | n/a       |

Command run: `pnpm exec vitest run apps/api/src/startup apps/api/src/skills/incident.test.ts` exit 0, 2 files, 62 tests passed.

- Positive controls: fully real configuration passes; local configuration passes.
- Negative and fault cases: the parametrized table above, the dev flag, an unknown mode, and a directory outage.
- Migration/backward compatibility: none. Local mode keeps its previous behavior. Real incident ticketing is rejected in production while its receipts are process-local (`rejects real incident ticketing while its receipts are process-local`), so incident ticketing is optional and off in production today.
- Rollback or forward repair: revert `e9c8cc4`; `server.ts` returns to constructing adapters inline.
- Open risks / decisions / follow-up owner: incident ticketing needs durable receipts before it can be enabled in production; wiring of later composition flags into `server.ts` was done by the coordinator and is not covered here.
- Operator work still required: a production-mode boot against real providers (AWAITING_OPERATOR).
- Integration validation on combined revision: unit tests above re-run on the integration-cleanup head. Full `pnpm test` is recorded in the integration report, not here.
- Postmortem according to repository instructions: skipped; the facts here were reconstructed from git history and test runs.

No fabricated result, elapsed time, cost or live execution. Do not include secrets or raw private source content.
