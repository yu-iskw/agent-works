# Opt-in user memory (issue 148)

This offline feature stores small personal preferences from authenticated user
turns. Tenant policy and user consent must both enable memory. Their defaults are
off. Memories are quoted context; they never grant roles, source access, tool
permissions, or authority to an agent.

## Components

| Boundary                | Implementation                               |
| ----------------------- | -------------------------------------------- |
| Domain validation       | `packages/domain/src/user-memory.ts`         |
| Local PII minimization  | `packages/domain/src/user-memory-pii.ts`     |
| Transaction port        | `apps/api/src/ports/user-memory.ts`          |
| In-memory adapter       | `apps/api/src/ports/memory/user-memory.ts`   |
| Postgres adapter        | `apps/api/src/ports/user-memory-postgres.ts` |
| Schema migration        | `apps/api/migrations/0016_user_memory.sql`   |
| Offline composition     | `apps/api/src/memory/runtime.ts`             |
| Governance registration | `apps/api/src/memory/governance.ts`          |
| Own-memory HTTP API     | `apps/api/src/routes/memory-*.ts`            |
| Management handler      | `apps/web/app/memory/handler.ts`             |
| CLI commands            | `packages/cli/src/memory.ts`                 |

The transaction port has one callback-based operation. Mutations run on detached
state under a serial lock. Validation checks history, origin ownership, scope,
TTL, audit immutability, and deletion evidence before committing. Both adapters
implement the same callback semantics and run the same contract suite.

## Trusted composition

Construct `createUserMemoryRuntime` with a governance port, trusted tenant
resolver, trusted runner scope resolver, and explicit policy. Use the same
governance port for its administrative routes and for deletion processing.
`runtime.app` mounts the memory API alongside the existing API. `runtime.recall`
is passed to `createAdkRunner` as `recallMemory`. `runtime.sweep` executes the
TTL sweep. `runtime.restore` replays current deletion evidence into a restored
memory store before serving traffic.

A scope is the exact tuple `(tenant, owner, agent)`. Never resolve it from a
question, retrieved document, model output, request body, or identity header
other than a verified IAP assertion. The offline API resolves owner from the
verified caller and tenant from the trusted directory function.

For permitted writes, call `proposeMemory` from trusted user-turn intake. The
proposal contains a task identifier, turn identifier, authenticated subject,
optional source reference, classification, and bounded TTL. There is deliberately
no public proposal route that lets an arbitrary client claim a turn provenance.
The runner only recalls; it does not automatically promote model output or source
material into long-term storage.

The compiled domain modules are imported through relative `dist` paths so the
feature does not modify the domain package's export map outside the issue's
exclusive paths. Build the domain before building or testing downstream packages.

## Consent

`GET /v1/memory/consent` returns the current consent, visible notice, and tenant
policy state. With no prior record, consent has revision zero and is disabled.
The notice version is `memory-v1`. Enabling or disabling consent requires the
current revision and that notice version. Stale commands fail with a conflict.

Consent is owner-wide within one tenant. Each agent still reads only its own
scope. Consent for Alice in tenant A cannot enable Bob or Alice in tenant B.
Tenant disablement immediately prevents proposal and recall while preserving
storage for lifecycle administration. User opt-out physically purges current
items and all revisions unless a legal hold requires sealed preservation.

## Management and evidence

The web handler offers inspection, revision, deletion, export, and opt-out.
It forwards the IAP assertion to the API, escapes all rendered content, limits
form size, checks a path-scoped CSRF cookie, and rejects cross-origin mutations.
Responses are private and use `Cache-Control: no-store`.

The CLI provides `aw memory --help`, list, export, consent, opt-in, opt-out, edit,
and delete. Mutations read an explicit JSON command file. The API ignores client
identity claims and enforces current revision numbers. CLI failures print safe
status messages instead of response bodies or credential-bearing exceptions.

Audit events retain action, timestamp, revision and hashed tenant, owner and
target identifiers. They do not contain memory text. Tombstones similarly contain
hashed identity references and deletion reasons. Source revocation references are
retained locally to prevent restored or newly proposed source-linked rows from
bypassing revocation.

## Evidence pending

The Memory Bank adapter is a typed, gated stub. The default is disabled. Turning
on its flag still reports `operator evidence pending (#107)` and performs no
managed service operations. Isolation, managed backup deletion, and managed
operator evidence remain owned by issue 107.

See [security](security.md), [lifecycle](lifecycle.md), [operations](operations.md),
and [API and CLI](api.md) for the detailed offline contract.
