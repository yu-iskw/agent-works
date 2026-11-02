# AUTH-01 follow-up: teamwork gateway authority enforcement

Scope: `apps/api/src/teamwork/**`. Not edited by AUTH-01 (flagship broker). Needs its own owner and write set.
Base: main 8d2dc6d. Related: #169, pack tasks/AUTH-01.md, specs/03-authority-security.md, SEC-01 and SEC-03.

## Inventory (read from code, not run live)

- `gateway.ts` `invoke` rechecks on every call: task owner (`readTask(sub, id)`), `deps.config.members` entitlement, segment capability (`segmentCapabilities`), the member's connection, the assignment's capability snapshot, input schema, and for writes the approval row (state, digest, revision). Denials write a `gateway.denied` audit row. This is the pattern to keep.
- Entitlement is a static `config.members` lookup. There is no directory call, so a transient directory failure cannot occur here today. If a directory-backed check is added, it must throw a retryable error and never read as "member removed".
- There is no `Authority` value, grant expiry, grant revocation or delegation depth on this path. Capability state is the only grant. `expiresAt`, revocation and child-subset checks from SEC-01 therefore have no enforcement point yet.
- `approvedPublication` binds approval to task, digest and `latest_revision`. It does not compare the approval's requester to `member.sub`; ownership holds only because the task read is owner-scoped. Add the explicit comparison.
- `diagnostics.ts` `checkSources` calls `deps.sources.read` directly, bypassing `invoke`. It filters by `memberCapabilities` but does not re-check `config.members`, and it audits one aggregate `sources.check` row, not per-call rows. It makes real provider reads with the member's token.
- `reconciler.ts` acts as `system:reconciler` on installations and the runtime manager. It makes no provider call with a member's authority. Its `installation.reconcile*` writes go through `store.update` with an actor and action. Confirm each runtime `ensure` and `remove` is attributable and that a disabled installation is never re-ensured.

## Required changes

1. Route `checkSources` reads through `invoke`, or give it the same membership, segment, connection and capability rechecks plus per-source audit rows. Keep it read-only and non-blocking per source.
2. Add the requester-equals-member check to `approvedPublication`.
3. Introduce a gateway authority resolution that reuses the canonical `Authority` from `@agent-works/domain` (do not add a second model). Resolve it server-side from segment config, installations and connections, check expiry, scope and resource, and recheck right before `handler.run`. Reuse the checks in `apps/api/src/broker/authority.ts` (`judgeAuthority`) or move them to a shared module once both hosts use them.
4. Fail closed with a retryable error when resolution cannot read its state. Do not treat it as deprovisioning.
5. Reconciler: add a test that a disabled or reduced installation is not re-enabled by a stale pass, and that its runtime calls carry an attributable actor.

## Acceptance (per ACCEPTANCE.md SEC-01, SEC-03)

Each test counts provider calls through the `SourcePort` fake and asserts zero for every denial:

- forged member or segment in the request
- expired or revoked grant between plan and call
- capability or connector disabled while a task runs (next call denied)
- membership removed after enqueue
- approval reused for a different digest, revision or requester
- transient resolution failure is retryable and makes no provider call
- owner positive controls for read and publish
- `checkSources` denial paths match `invoke`

Run the teamwork gateway and flagship broker suites independently.

## Constraints

No migrations. No public API or persisted schema break. Distributed revocation cannot retract a provider call already accepted; document the check-to-call gap and reconcile completion.
