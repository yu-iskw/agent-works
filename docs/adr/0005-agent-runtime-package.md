# 5. Agent runtime package

Date: 2026-11-02

## Status

Proposed

## Context

ADR 0004 says a dedicated agent adapter package should be created only when dependency or reuse evidence justifies it. Spec decision 7 says the same: create packages only for proven dependency or reuse needs. Acceptance criterion A10 says no unnecessary package was added.

Three callers now need the same native ADK runner and the same eval glue: the `apps/api` ask route, `tools/evals` and the incident-analysis eval. The `aw` CLI needs them as well. Keeping copies in each caller would make the runner and its budget and tool-call checks diverge.

## Decision

Add the workspace package `packages/agent-runtime` (`@agent-works/agent-runtime`). It owns the `AgentRunner` port, the native ADK runner, the fake model adapter, the live Vertex configuration and the eval glue.

This overrides spec decision 7 for this package and is the recorded exception to A10. The package adds no new external dependency. It moves the existing `@google/adk` 2.2.0 dependency from `apps/api`.

The `/port` entry point exports the port without loading ADK, so evaluation code can use injected runners without loading ADK.

## Consequences

- The package is the only place that owns the ADK runner. Callers pass a model and configuration.
- Dependency direction is one way. The package does not import `apps/api` or the CLI.
- The ADK-specific types stay inside the package. The port uses framework-neutral types, consistent with ADR 0004.
- Other frameworks can integrate by implementing `AgentRunner` or by emitting v1 observations.
- This record stays Proposed until a human accepts it. The rationale is recorded here rather than in the spec, so the spec stays unchanged.

## Alternatives considered

### Keep the runner in `apps/api` and import it from the other callers

Rejected because `tools/evals` and the CLI would depend on the HTTP delivery package. That reverses the dependency rule in ADR 0004.

### Copy the runner into each caller

Rejected because the budget, tool-call and error mapping would diverge across three callers.

## Validation

This record remains Proposed until the package has passed the offline gate and its runner is shared by all three callers. If the package stops having at least three callers, or if its exception to A10 is no longer needed, amend or reject this record rather than keeping the package by default.
