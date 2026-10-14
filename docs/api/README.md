# API contract

Issue #141 adds an offline OpenAPI 3.1 contract and a typed client for the existing API. The canonical specification is [openapi.json](../../packages/api-contract/openapi.json). Domain Zod schemas are converted to JSON Schema 2020-12; the operation manifest binds those schemas to the existing route methods and paths. Route handlers retain authentication, authorization, feature flags and execution behavior.

The contract covers ask, tasks, approvals, skills, OAuth connections and administrative suspension/version endpoints. Artifact reads and search are documented feature slots. A documented operation does not bypass its deployment feature flag or imply that a real provider is enabled.

- [Generation and drift](generation.md): regenerate, review and check the specification and client.
- [Client and CLI](client.md): task and approval command examples.
- [Validation](validation.md): request composition and client validation boundaries.
- [Acceptance evidence](acceptance.md): requirements, tests and verification commands.
- [Model routing and delegation](../model-policy/README.md): offline runtime policy and migration.

## Development

```sh
pnpm install --frozen-lockfile
pnpm api:generate
pnpm build
pnpm exec vitest run --project @agent-works/api-contract
```

Root `prebuild` and `pretest` build the domain and contract packages before consumers use their compiled files. `packages/*` already includes the new workspace. API-contract has no new registry dependencies. The CLI imports the generated sibling build because this change is constrained to its two existing command implementation files.

The client is deliberately small and retained as source while its formatted size is at most 1,500 lines. A regression test enforces that bound. `dist/` is an ignored compiler artifact. If generation exceeds the bound, move the generated source to a package-local ignored build artifact and generate it before compilation; do not disable the size test merely to keep a larger client in source control.
