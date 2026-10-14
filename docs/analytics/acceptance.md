# Acceptance map and local verification

## Guard

`sql-guard.test.ts` loads eight checked-in hostile corpus files under
`evals/fixtures/analytics-hostile-*.json`. They contain 256 distinct hostile queries.
Every case runs through the AST parser and authorization/allowlist policy.
The corpus includes writes, DDL, scripts, multiple statements, comments hiding
statements, cross-project refs, forbidden tables and columns, wildcard projections,
missing and excessive limits, unsafe functions and encoding tricks.

`compiler.test.ts` includes the approved semantic corpus: all three vetted metrics
with zero dimensions, region, day, and region plus day. Each compiled plan passes
through the same SQL guard. Separate policy tests cover bind completeness,
classification lineage, aggregate grouping, approved joins and partition filters.

## Cost, report and authorization

- `service.test.ts`: over-cap estimate never calls execute; denial is audited;
  malformed estimates, engine failure, audit failure and result cap fail closed.
- `cost-gate.test.ts`: exact cap, over cap and issue 137 admission in both modes.
- `reports.test.ts`: byte-identical frozen SQL, identical fixture result serialization,
  new versions on edit, metric changes do not recompile old versions, grant revocation,
  catalog revocation, cross-owner denial, integrity and validation checks.
- `analytics-routes.test.ts`: verified caller, missing grants 403, forged roles 403,
  IAP failure, strict bodies, safe errors, metric filtering and save/rerun flow.
- `classification.test.ts` and `siem.test.ts`: governance masking, dropped unexpected
  fields and the checked-in SIEM golden snapshot.
- `analytics.contract.ts`: shared memory and Postgres storage behavior, concurrent
  version allocation, ownership, immutable identities and masked audit evidence.
- `analytics-postgres.test.ts`: database append-only triggers, rollback and pool reopen.
- CLI and analyst skill tests cover safe transport, version-only dispatch, fresh grants,
  scoped budgets and concurrent task deduplication.

## Commands

```sh
pnpm install
pnpm build
pnpm -r exec tsc --noEmit
pnpm lint:eslint
pnpm knip
PATH=/tmp/issue135-bin:$PATH pnpm test
pnpm api:generate
```

Prettier 3.9.6 is applied to changed files with `--write` and then `--check`.
The root `pnpm lint` invokes Trunk, so it is not run under the explicit no-Trunk
constraint. `pnpm lint:eslint` is the direct configured ESLint check. No web page is
added because web files are outside the exclusive write paths; Playwright is therefore
not applicable. The OpenAPI generator updates the central route fingerprint snapshot.
Analytics endpoint payload contracts are the strict domain schemas and API tests;
shared operation registration remains outside this bundle's exclusive paths.

Postgres tests use the requested wrapper first on PATH. If Docker is inaccessible,
the disposable Postgres suites skip and this limitation is recorded in the final run
summary. Offline tests and fake BigQuery checks establish application semantics,
not real BigQuery ACL or live cloud evidence.

## Session postmortem (2026-10-14)

Outcome: the offline analytics pipeline, immutable storage, routes, CLI and analyst
schedule hook are implemented with a hostile SQL corpus and shared adapter tests.
The corpus caught an accepted reserved table alias; that boundary is now denied.
Additional checks validate real calendar dates, provider output and stored evidence.

Surprises: localhost listeners and the Docker socket are denied by this sandbox.
The direct npx command could not reach registry DNS despite an installed cached
Prettier 3.9.6. Running npx from that package directory reused the exact requested
version without a network request. Generated client formatting is restored after
OpenAPI generation to avoid unrelated formatting changes.

Root cause: host capabilities and npm resolution differ from ordinary local CI,
and permissive identifier grammar left an object-key boundary implicit.

Action: **no shared rule change** in this bundle. Preserve hostile alias, invalid
date, invalid estimate and engine result cases as regression tests. Record the
host failures in the run summary and rerun the full suite and Postgres contracts
on an unrestricted CI worker. Shared agent config is outside exclusive write paths.
