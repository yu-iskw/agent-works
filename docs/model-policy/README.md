# Offline model policy and delegation

This implementation supplies injectable Phase 4 components for RFC-001 sections 6.3 and 6.4. It uses scripted model calls and fixtures, and keeps delegation off by default. It does not activate real Gemini endpoints or modify the default API route wiring.

- [Routing](routing.md): allowlist, benchmark gating, fallback boundaries and inference evidence.
- [Delegation](delegation.md): computed authority, shared budget/trace and independent verification.
- [Persistence](persistence.md): migration and memory/Postgres contracts.
- [Evaluation](evaluation.md): report-only fixture comparison and limitations.
- [Acceptance matrix](../api/acceptance.md): executable tests and commands.

The accepted pilot region is `asia-northeast1`. ADR 0003 requires observe-only spend tracking in the dev project. Isolated tests may use the existing `isolated-test-enforce` budget mode; that is not a production spending policy change.

Model IDs in routing fixtures (`fixture-gemini-default`, `fixture-gemini-fast`) and version `offline-1` are test coordinates. They are not a provider allowlist, current product recommendation or validated deployment location. No artifact or report enables a production feature flag.
