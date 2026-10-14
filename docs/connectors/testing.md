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

The approval card and web handler run through the normal web Vitest project,
which includes both `.test.ts` and `.test.tsx`. In-process mount tests exercise
the API application and web server without binding sockets. The combined fake
server tests cover OAuth grants, Docs destination ACLs, Calendar/Gmail routing,
and revocation. Real socket and Postgres tests still need an environment that
permits their services to start.

OpenAPI request schemas share their domain source with the connector routes.
Regenerate with `pnpm api:generate` after route or schema edits and formatting;
`node packages/api-contract/scripts/generate.mjs --check` verifies generated
OpenAPI/client drift, including connector route fingerprints.
