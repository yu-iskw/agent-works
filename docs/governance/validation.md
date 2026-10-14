# Acceptance and validation

## Acceptance map

| Requirement                                         | Evidence                                                                           |
| --------------------------------------------------- | ---------------------------------------------------------------------------------- |
| Shared memory/Postgres behavior                     | `ports/governance.contract.ts`, memory adapter test, `governance/postgres.test.ts` |
| Expire once, retain under hold, purge after release | Shared contract and `retention-sweeper.test.ts`                                    |
| Local workflow checkpoint/cancel behavior           | `retention-sweeper.test.ts`                                                        |
| User deletion with registered derived fan-out       | Shared contract, `deletion-requests.test.ts`                                       |
| Restore re-application                              | Shared contract and `restore.test.ts`                                              |
| Encrypted stored payloads and key failure           | Shared contract, `encryption.test.ts`, `artifact-store.test.ts`                    |
| Restricted SIEM/task data absent                    | `redaction.test.ts`, golden JSON fixture                                           |
| Source-data wrapper                                 | `source-data.test.ts`, new adversarial fixture                                     |
| Trusted role and forged-role denial                 | `routes/governance-routes.test.ts`                                                 |
| Encrypted HTTP reads                                | `runtime.test.ts`                                                                  |
| CLI request, exit and error behavior                | `packages/cli/src/governance.test.ts`                                              |
| Schema labels, retention, canonical hash            | `packages/domain/src/data-governance.test.ts`                                      |

## Commands

Build first because the API governance facade reads the compiled domain contract.
The root has no TypeScript solution config or workspace `typecheck` scripts; use
recursive TypeScript invocations against the package configs.

```sh
pnpm build
pnpm -r exec tsc --noEmit
pnpm lint:eslint
pnpm knip
PATH=/tmp/issue135-bin:$PATH pnpm test
```

The repository's root `pnpm lint` runs Trunk. The issue explicitly prohibits
running Trunk, so validation uses the configured ESLint command and direct
Prettier checks instead. Security scanners are not claimed to have run by this
substitution.

Format only changed files, including untracked additions. Use Prettier 3.9.6 when
the registry is available. The stock formatter has no SQL parser in this workspace;
`--ignore-unknown` leaves the migration unchanged while formatting supported
TypeScript, Markdown and JSON files. Review and run the SQL in real Postgres.

The focused tests can run without external services except the HTTP composition
case and Postgres contract. To select the rest explicitly:

```sh
PATH=/tmp/issue135-bin:$PATH pnpm exec vitest run \
  apps/api/src/governance \
  apps/api/src/ports/memory/governance.test.ts \
  apps/api/src/routes/governance-routes.test.ts \
  packages/domain/src/data-governance.test.ts \
  packages/cli/src/governance.test.ts \
  -t '^(?!.*mounts encrypted reads)'
```

This focused command is supplemental evidence. It does not replace the full
workspace test run or prove live SQL behavior.

## Database environment

The database tests use the existing disposable Postgres harness. Put
`/tmp/issue135-bin` first on PATH when Docker storage is full, as required by the
issue. The wrapper moves disposable data to memory. Do not prune Docker storage.
The Postgres governance suite probes Docker availability and skips when unavailable;
CI with real Postgres must execute the full shared contract.

A sandbox can independently deny the Docker socket or even local TCP listeners.
In that environment a tmpfs database still cannot start. Record the exact skip
or failure and execute the SQL contract later in an environment with those
capabilities. Do not replace Postgres evidence with a memory pass.

Existing workspace tests include HTTP listeners and database suites outside this
issue's write scope. A `listen EPERM` failure is an execution-environment blocker;
it is not evidence that a governance HTTP assertion passed. Preserve those tests
and report full-suite status honestly.

## Operational limits to verify before production

- The local KMS fake is process-local and loses keys at restart.
- Cloud KMS remains a feature-gated failure stub.
- Managed Memory Bank / Sessions deletion evidence remains pending under #107.
- Governance controls apply to registered artifact and derived rows.
- Existing task ledgers and external SIEM delivery need their own retention policy.
- A trusted evidence export is required for every offline restore.
- The global maintenance lock/full-state draft is an offline pilot trade-off.
- Trusted directory mappings and current ACL evidence are supplied by the embedding app.

## P4B1 regression validation (2026-10-14)

`aw governance` is wired in `packages/cli/src/aw.ts`. The focused regression run
passed **19 test files and 266 tests**, with no skipped tests, including the live
Postgres governance contract. It covered the two unchanged regression files,
all governance tests, both model-facing runner suites and the fake-service suite:

```sh
pnpm exec vitest run \
  apps/api/src/retrieval/http-drive.test.ts \
  apps/api/src/routes/ask-authorization.test.ts \
  apps/api/src/governance \
  apps/api/src/ports/memory/governance.test.ts \
  apps/api/src/routes/governance-routes.test.ts \
  packages/domain/src/data-governance.test.ts \
  packages/cli/src/governance.test.ts \
  apps/api/src/agent/adk-runner.test.ts \
  apps/api/src/agent/scripted-runner.test.ts \
  packages/fakes/src/fakes.test.ts
```

The full workspace test suite was not rerun in this fix session. Trunk was not run.

`pnpm build`, `pnpm -r exec tsc --noEmit`, `pnpm lint:eslint` and `pnpm knip`
all passed. Knip reported its existing non-failing entry-pattern hint for
`agents/skills/incident-analysis/eval-run.ts`; ESLint reported a non-failing
multiple-projects performance notice. Direct Prettier formatted the fix files.

## P4B1 gap regressions (2026-10-14)

Direct transactions now compare removed derived rows with the previous parent
record. Record, owner and source holds reject derived-only removal; after release,
matching purge evidence is required. Restore reconciliation also recognizes purge
audit target hashes without tombstones, preserves the original audit event and
rejects conflicting active holds. Both regressions run through the shared memory
and Postgres contract.

The focused governance and complete API-contract run passed **8 files and 88
tests**. The Postgres governance file skipped **37 tests** because this sandbox
denies the Docker socket. The full `PATH=/tmp/issue135-bin:$PATH pnpm test` run
reported **137 passed, 39 failed and 2 skipped files**, with **1,642 passed, 180
failed and 196 skipped tests**. Failures include local listener `EPERM`, unavailable
Docker and test timeouts. These results do not establish live Postgres validation.

`pnpm build` (including generated contract drift), `pnpm -r exec tsc --noEmit`,
`pnpm lint:eslint`, `pnpm knip` and direct Prettier checks passed. Trunk was not run.

Session lesson: deletion eligibility must be validated for derived-only changes
as well as parent removal, and restore must consume every accepted form of purge
evidence. Shared adapter regressions are the durable guard; no additional agent
rule or hook is needed. Infrastructure-dependent tests still need a run with
Docker and local listener access.
