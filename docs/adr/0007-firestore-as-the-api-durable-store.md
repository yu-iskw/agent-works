# 7. Firestore as the API durable store

Date: 2026-11-05

## Status

Proposed

## Context

The API persists tasks, ledger, outbox, memory, finops, model routing, teamwork and scheduling state in PostgreSQL. Production startup (`apps/api/src/startup/providers.ts`) requires a non-local PostgreSQL `DATABASE_URL` for `authority-persistence`, so the API cannot start in production on Firestore without changing that guard.

Measured coupling in `apps/api/src` (non-test files):

- About 16 files import or reference the PostgreSQL driver or `DATABASE_URL`, including the ledger, dispatch, governance, memory, finops, scheduling, teamwork and outbox stores.
- SQL migrations exist for several modules (`memory`, `finops`, `model-routing`, the API migrations).
- Concurrency relies on SQL semantics: `FOR UPDATE` and `SKIP LOCKED` row claims (scheduling, outbox), `ON CONFLICT` idempotent writes, and multi-statement transactions (claim-with-outbox, memory lifecycle).
- Analytics and restore drill read relational state.

ADR 0004 records that a new persistence engine is not a current requirement. This proposal is therefore a challenge to that context. The new requirement is a Cloud Run deployment that needs no private database network: the Cloud SQL Private Service Connect path is blocked because the dev rule forbids global IP addresses and the applier lacks Service Directory rights. Firestore needs no VPC, no private endpoint and no database password, and it authenticates with the service account.

## Decision

Propose replacing the PostgreSQL authority persistence with Firestore behind the existing application ports. This is a proposal, not an accepted decision.

- Each store becomes an adapter that implements an application-defined port. No Firestore type appears in domain, policy or application contracts (ADR 0004).
- Atomic multi-document updates use Firestore transactions. Row claims use transactions with a lease field and an expiry instead of `SKIP LOCKED`. Idempotent writes use document IDs derived from the idempotency key.
- The production guard for `authority-persistence` accepts a Firestore project and database id instead of `DATABASE_URL`. A local in-memory or emulator adapter stays for dev and e2e.
- SQL migrations are retired per module. Schema versions become document fields checked at read time.
- Delivery is phased: the outbox and scheduling claim first (highest concurrency risk), then ledger and dispatch, then memory, finops, model routing and teamwork.

## Consequences

Easier:

- No private network, peering, Service Directory or database password for the API. The service account authenticates keylessly.
- Cloud Run deployment and rollback need fewer infrastructure resources.

Harder or riskier:

- Firestore transactions have contention and document limits that differ from SQL. Hot documents (for example a single scheduler lease) need sharding or a different claim pattern. This must be load-tested before acceptance.
- The restore drill, analytics queries and any SQL reporting need rewriting. Point-in-time recovery must be re-verified against Firestore's backup and restore options.
- Decision-changing risk: ADR 0004's context says a new persistence engine is out of scope. Accepting this record requires that context to be updated first.
- Every existing `ON CONFLICT` and `SKIP LOCKED` path needs a tested equivalent. Until then, production stays blocked on `authority-persistence`.

Not decided here: whether to keep Cloud SQL as an alternative. The Cloud SQL module and its PSC endpoint remain in the repository as an unused option until a human accepts or rejects this record.
