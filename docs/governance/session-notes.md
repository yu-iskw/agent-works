# Issue 139 session notes

## Outcome

Preserved and completed the existing local governance implementation inside its
exclusive paths. Added stronger request evidence validation, restore reconciliation,
SQL envelope/required-field constraints, adapter consistency checks, shared
integrity assertions, HTTP boundary tests and operator documentation. Build,
TypeScript, lint and focused tests are recorded in the final session summary.

The CLI client is exported and tested, and `aw governance` is wired through the
executable dispatcher in `packages/cli/src/aw.ts`. The narrowly scoped dispatcher
change was authorized and applied.

## Failures and surprises

- Vitest's array form of `it.each` expanded role arrays into arguments. An empty
  role array supplied no callback argument, and single-role arrays supplied a
  string. This produced both compiler errors and incorrect authorization tests.
  Named object cases preserve each role array as one value.
- SQL CHECK expressions can evaluate to NULL for missing JSON fields. Required
  generated projections now have NOT NULL constraints, and the envelope check
  explicitly coalesces absent/malformed values to false.
- A restored artifact can predate source revocation or have an obsolete hold
  summary. Replay now imports authoritative hold evidence before recomputing
  summaries and re-purging matching bytes.
- Transaction results and drafts need detachment before persistence to prevent
  mutable aliases from affecting commit behavior. Memory must also clone the
  return value before replacing state, so an uncloneable callback result rolls
  back rather than committing a rejected operation. The shared contract covers it.
- The execution sandbox blocks local listeners and Docker access. A tmpfs data
  directory fixes disk pressure but does not grant socket permissions.
- The required Prettier version could not be downloaded because registry DNS is
  unavailable. The installed formatter was used as a documented fallback.
- Node's `writeHead` header argument is not exposed by `getHeader` in the same way
  as headers set through `setHeader`. The in-process HTTP tests capture actual
  `writeHead` arguments to verify response headers.

## Follow-up classification

**No shared rule/config change.** These findings belong to this bundle's tests
and operator documentation. The request-integrity validator, SQL constraints and
restore regression tests enforce the local invariants directly. The existing
repository-wide instructions already require preserving scope and reporting
execution blockers, so another general rule would add noise.

Before deployment, run the real Postgres contract and full networked test suite in
an environment with Docker/TCP capabilities, obtain managed-service operator
evidence under #107, and replace the KMS failure stub through a separately reviewed
integration. The local tests do not establish those external guarantees.

## P4B1 regression fix (2026-10-14)

Restored the caller-bound search result shape and kept the complete authorized
source text in the runner input contract. Both ADK and scripted adapters now apply
the source-data envelope while constructing the model prompt. The governance
adversarial test captures each adapter's outgoing model request and verifies the
envelope, unchanged retrieval text, unchanged runner input and citation identity.
The two existing retrieval/authorization regression test files were not edited.

Wrapping in `boundTo` had changed a shared retrieval contract, causing three
existing assertions to fail. Moving wrapping to the model boundary also changed
the exact prompt hash used by the fake LLM. A second triage fixture registers the
wrapped prompt while retaining the original fixture and its behavior.

**Follow-up classification: no shared rule/config change.** The boundary tests
now enforce both compatibility and model-facing wrapping directly. Existing
repository guidance is sufficient; another broad rule would add noise.
