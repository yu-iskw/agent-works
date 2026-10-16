# 4. Application core and adapter boundaries

Date: 2026-10-16

## Status

Proposed

## Context

RFC-001 adopts a TypeScript modular monolith and requires the platform to own task, approval, policy, artifact, and audit semantics independently of an LLM framework. The repository already separates domain, policy, API-contract, fakes, and infrastructure concerns in several places, but application orchestration and concrete infrastructure dependencies are also colocated in `apps/api`.

For example, the ask route currently coordinates authentication, authorization, retrieval, runner selection, task persistence, audit construction, and HTTP serialization. The API package also directly depends on `@google/adk` and the PostgreSQL driver. Colocation is not itself a defect, but framework and transport details must not become business contracts.

A broad directory move would create churn without proving better boundaries. Microservices, multi-cloud portability, or a new persistence engine are not current requirements.

## Decision

Keep a modular monolith and strengthen dependency direction incrementally.

Framework-neutral application use cases and ports own business orchestration contracts. Domain and policy packages remain independent of HTTP frameworks, Google ADK, database drivers, and connector SDKs. Concrete adapters implement application-defined ports. `apps/api` remains the HTTP delivery and composition root.

Extraction is evidence-driven. Start with representative use cases where current coupling impedes independent tests, replacement, or security enforcement. Do not move every `apps/api` module merely to satisfy a target folder diagram.

The first representative extraction should use the ask flow. Preserve API paths, task state transitions, audit behavior, persisted contracts, and security semantics while separating transport concerns from application orchestration.

The agent runtime boundary follows ADR-0001. ADK is the preferred implementation, but ADK-specific types must not leak into application/domain contracts. A dedicated adapter package is optional and should be created only when dependency or reuse evidence justifies it.

Tool execution uses the canonical authority model already owned by the domain. Do not introduce a parallel self-asserted execution-authority model. Broker execution must derive or validate actor/policy information from trusted authority and server-side state.

## Dependency rule

```text
domain / policy
      ^
      |
application contracts + use cases
      ^
      | implemented by
adapters
      ^
      | wired by
apps/api
```

Runtime calls may flow from application code to adapters. Compile-time dependencies for application/domain semantics flow toward framework-neutral contracts.

## Consequences

- The repository stays a modular monolith.
- Existing code can remain in `apps/api` until a concrete extraction provides value.
- Representative use cases can be tested with fakes without HTTP, ADK, or database-driver dependencies.
- Infrastructure replacements do not redefine task, approval, authority, or policy semantics.
- CI architecture checks should enforce a small set of forbidden dependency edges and detect cycles.
- Package count is not an architectural success metric.

## Alternatives considered

### Leave all boundaries conventional rather than enforced

Rejected because direct infrastructure imports can gradually make nominal ports ineffective and make security-sensitive orchestration harder to test independently.

### Move all backend modules into packages immediately

Rejected because folder relocation alone does not demonstrate lower coupling and would create a large migration surface.

### Split the control plane into microservices

Rejected for the current pilot. Independent deployment, distributed consistency, and additional operational boundaries are not justified by a demonstrated requirement.

### Introduce a multi-cloud abstraction layer

Rejected until portability becomes a concrete requirement.

## Validation

This record remains Proposed until representative implementation work demonstrates that:

1. at least one use case can execute against fake ports without HTTP, ADK, or a database driver;
2. API and persisted behavior remain compatible;
3. dependency checks can express the intended boundaries without broad exception lists; and
4. the resulting structure reduces coupling without disproportionate indirection.

If those conditions are not demonstrated, amend or reject this record rather than forcing the repository to match the diagram.
