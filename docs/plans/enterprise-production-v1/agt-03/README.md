# AGT-03: standing-grant lifecycle

Base `origin/epv1/integration` be725be. Local, behind an activation flag that defaults OFF. Not VALIDATED.

## What it is

A persistent lifecycle over the frozen AGT-00 contract (`packages/domain/src/standing-grant-contract.ts`). It adds no second authority system. A grant projects onto the canonical `Authority` through `authorityForCall`, and the broker's `AuthorityResolver` consumes that.

| Piece                               | File (`apps/api/src/authority-lifecycle/`)         |
| ----------------------------------- | -------------------------------------------------- |
| One store port, two implementations | `store.ts`, `memory-store.ts`, `postgres-store.ts` |
| Issue, revoke, review, audit        | `lifecycle.ts`                                     |
| Call-time resolution for the broker | `resolver.ts`                                      |
| Migration runner for `0024`         | `migration.ts`                                     |
| Schema, triggers                    | `apps/api/migrations/0024_standing_grants.sql`     |

## Rules

- **Issuance.** A root grant needs a human `owner` or `admin`, built by the server from session or directory state. A `bot` actor, a `member`, or anything derived from model output is refused. A child grant needs the parent's own grantee, a usable chain, and `deriveChildGrant` passing, so it is never wider than its parent on permissions, expiry, depth, schedule, concurrency, fan-out or budget. The server sets `grantId`, `issuedAt`, `auditRef`, sponsor, issuer, depth and policy revision. A root lifetime above `maxRootLifetimeSeconds` (default 90 days) is refused.
- **Fan-out.** `limits.maxFanOut` also caps the active children a parent holds. The Postgres insert locks the parent row, so racing siblings cannot pass the cap together.
- **Revocation.** `revokeTree` revokes the grant and every active descendant in one transaction and audits each one. It is idempotent. An owner, an admin or the chain's sponsor may revoke. `revokeSponsor` revokes every root of a sponsor. Revocation and review work while the flag is OFF, because they only narrow authority.
- **Resolution.** `resolveStandingAuthority` reads the whole chain on every call. A revoked or expired link, a missing link or a changed sponsor denies, even if a descendant row still says active. A store read error throws, so the broker answers `AUTHORITY_UNAVAILABLE` (retryable). Because it reads at call time, work queued before a revocation is denied when it runs, with no provider call.
- **Audit.** `tw_standing_grant_audit` is append-only (trigger). It records `issued`, `issue_denied`, `revoked`, `revoked_by_ancestor` and `reviewed`, with safe codes and ids only.
- **Immutability.** A grant row cannot change except by the one-way revocation columns, and cannot be deleted (trigger).
- **Activation (O04).** `readGrantActivation(env)` is enabled only when `AW_STANDING_GRANTS=on` and `AW_STANDING_GRANTS_O04_REF` holds the operator's approval reference. Default OFF denies issuance and resolution.

## Mapping to the broker

`createStandingAuthorityResolver({ store, activation, now, bindingFor, facts })` returns an `AuthorityResolver`. `bindingFor` says which grant and action back a task (server state). `facts` supplies the sponsor's current policy facts (membership, role, source access); a grant is never proof of those. Denials map to the broker's existing reasons (`revoked`, `unknown_actor`); `broker/authority.ts` is unchanged. `delegation` is left unset: `authoritySubset` requires equal agent principals and a child grant's grantee differs by design, so the parent/child subset is enforced at issue time instead.

## Known limits

- A descendant inserted below a deep node while a higher ancestor is being revoked can escape the sweep. The resolver walks the chain, so it is still denied. A test proves it.
- The sponsor is a label. Nothing here verifies the sponsor is a live human; the policy facts do.
- Budget values are the contract's `PLACEHOLDER` values until O04 approves real limits.

## Wiring left to the coordinator

1. `apps/api/vitest.config.ts` needs the `@agent-works/domain/standing-grant-contract` alias (committed here as a separate commit).
2. Build the lifecycle and resolver in `server.ts` (or the teamwork gateway) with `createPostgresGrantStore(sql)` and `readGrantActivation()`, and call `applyStandingGrantMigration(sql)` at start (or add `0024_standing_grants.sql` to `workbench/migration.ts`).
3. Provide `bindingFor` and `facts` from AGT-04's gateway or the schedule runner, and expose `revoke`, `revokeSponsor`, `listForReview` and `review` through an admin route.

## Rollback

`0024` only adds two tables, one index pair and four triggers; nothing reads them while the flag is OFF. Rolling back is leaving the flag OFF. A forward repair is a new migration number, never an edit of `0024`.

See [evidence.md](evidence.md).
