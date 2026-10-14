# Connector validation

The domain suites cover strict schemas, bounded requests, canonical hashes,
manifest side effects and scope declarations, denied send, and typed responses.
API suites cover caller isolation, credential ownership and revocation, safe
step-up, single-use approval bindings, retry budgets, response validation,
idempotent create recovery, source-data classification, and the meeting-prep
workflow. Each adapter has a contract suite against its actual fake API handler.

`googleFakeTransport` adapts the fake HTTP request/reply handlers to Fetch. It
preserves HTTP methods, URLs, query parameters, headers, bodies, and statuses.
It allows deterministic offline adapter contracts in sandboxes that forbid
socket binds. The real HTTP adapter uses Fetch when no transport is injected.

Postgres tests use the existing approval migrations and durable store. Run with
`/tmp/issue135-bin` first on PATH as requested for this worktree. If the wrapper
cannot start a disposable database, the new connector Postgres suite records a
skip. This is a limitation of the environment, not a durable-storage pass.

The approval card and web handler have separate JSX unit/smoke coverage. The
existing web Vitest include pattern only lists `.test.ts`, so the new allowed
`.test.tsx` files need an explicit test configuration to execute. The issue's
exclusive paths do not allow editing the existing web test configuration.

Required checks should use the existing workspace commands. `pnpm lint` currently
invokes Trunk, which this task explicitly prohibits; use `pnpm lint:eslint` and
Prettier as the permitted lint/format checks and record that substitution.

OpenAPI route fingerprints scan `apps/api/src/routes/`. Connector factories are
inside `connectors/` and are not mounted or represented in that protected
OpenAPI registry. Existing drift validation must remain clean. Adding connector
operations to the published specification requires integration-path permission.
