# Issue #141 acceptance evidence

All execution is offline. Real Gemini endpoint, region and pricing validation remains operator-gated under issue #108.

| Requirement                                    | Executable coverage                                                                                 |
| ---------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| Model allowlist denial and audit               | `apps/api/src/model-routing/router.test.ts`                                                         |
| Cross-zone/region fallback denial              | `apps/api/src/model-routing/router.test.ts`                                                         |
| Pinned identity on every inference             | `packages/domain/src/model-policy.test.ts`, router and port contracts                               |
| Benchmark-gated rules                          | `apps/api/src/model-routing/benchmark.test.ts`, router tests                                        |
| Child authority subset                         | `packages/domain/src/delegation-authority.test.ts` (1,000 randomized runs)                          |
| Depth and root budget identity                 | `apps/api/src/delegation/context.test.ts`                                                           |
| Parent budget charged for children             | `apps/api/src/delegation/orchestrator.test.ts`                                                      |
| Verification failure never consumed            | Orchestrator and verifier tests                                                                     |
| Delegation unreachable by default              | Flag tests and orchestrator omitted/disabled flag tests                                             |
| Report produced by existing CI test run        | `packages/api-contract/tests/delegation-report.test.mjs` imports `evals/delegation/report.test.mjs` |
| OpenAPI validates and route/schema drift fails | `packages/api-contract/tests/openapi.test.mjs`                                                      |
| Generated client stays small and synchronized  | `packages/api-contract/tests/client-drift.test.mjs`                                                 |
| Request middleware and generated client        | `packages/api-contract/tests/validation.test.mjs`, `client.test.mjs`                                |
| CLI on generated client                        | `packages/cli/src/run-api.test.ts`                                                                  |
| Memory/Postgres contract parity                | `apps/api/src/ports/*.contract.ts`, memory tests and routing/delegation Postgres tests              |

## Verification commands

```sh
pnpm install --frozen-lockfile
pnpm build
pnpm exec tsc --noEmit -p packages/api-contract/tsconfig.json
pnpm lint:eslint
pnpm knip
PATH=/tmp/issue135-bin:$PATH pnpm test
```

Typecheck the other workspace TypeScript projects with their own `tsconfig.json` as well. In this task, format changed permitted files with `npx prettier@3.9.6`; skip Trunk. The Postgres wrapper stores the data directory in RAM and avoids disk pruning. Postgres contracts use real PostgreSQL ports and require Docker-socket and localhost access; a sandbox permission failure is not a passing contract test.

The existing `.github/workflows/test.yml` runs `pnpm test`, whose discovery includes API-contract. That suite imports the delegation report test; no workflow write is required. The test writes `evals/delegation/reports/comparison.json` and prints its location/status. Quality differences are report-only. Infrastructure unavailability produces an explicitly unavailable report, without a claim that delegation quality passed. An artifact upload step is not added because workflow paths are outside this issue's permitted writes.

## Implementation learnings

Formatting exposed a weakness in the original generated-client comparison: removing whitespace and punctuation from source did not account for legal formatter rewrites and could erase meaningful literal contents. The check now compares normalized TypeScript syntax trees, with regression coverage. Strict audit schemas also exposed approval metadata leaking into a model identity during fallback exhaustion; audit construction now selects the four identity coordinates explicitly. The sparse OpenAPI method map needs Zod's partial-record semantics, and drift tests must resolve routes relative to the worktree package. These are localized fixes and tests; no shared agent configuration change is needed.
