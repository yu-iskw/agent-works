# AGT-04 evidence: bot isolation and gateway authority

Base: origin/epv1/integration. All results are local (Postgres via Docker). Nothing live.

| Criterion                                          | Test (apps/api/src/teamwork)                                                                                    | Result |
| -------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- | ------ |
| SEC-01 diagnostics recheck and per-source audit    | `diagnostics.characterization.test.ts` (non-member, directory down, removed, member, disabled source)           | PASS   |
| SEC-01 approval requester equals member            | `gateway.test.ts` "denies an approval decided by someone other than the calling member" (plus positive control) | PASS   |
| SEC-03 directory failure is retryable fail-closed  | `gateway.test.ts` "treats a directory failure as retryable..."; queued variant `source_resolution_unavailable`  | PASS   |
| Revoked membership / disabled connector, queued    | `gateway.test.ts` queued work after disable; subset reduction on next call; zero provider reads asserted        | PASS   |
| Shared-bot user cannot read another's private data | `gateway.test.ts` "shared bot isolation": history, task, export, token, gateway read all denied; owner positive | PASS   |
| Segment admin cannot widen env allowlist           | `installations.test.ts` row listing non-env capabilities; `gateway.test.ts` gateway-level denial                | PASS   |
| Reconciler authorization and audit equivalence     | `reconciler.test.ts` stale pass does not re-ensure a disabled connector; writes carry `system:reconciler`       | PASS   |

Commands (all exit 0): `pnpm build`, `pnpm typecheck`, `pnpm exec vitest run apps/api/src/teamwork apps/api/src/delegation` (179 tests), `pnpm exec eslint apps/api/src/teamwork`, `pnpm knip`.

## Behavior changes

- `checkSources` throws `GatewayDenied` (`not_entitled` or `resolution_unavailable`) before any provider read, audits `gateway.denied`, and writes one `sources.check.source` row per source plus the existing aggregate `sources.check`.
- `approvedPublication` requires `wb_approvals.decided_by === member.sub`.
- `Deps.directory?: { isMember(email) }` is optional. Absent, the static `config.members` list applies. A throw becomes `GatewayDenied('resolution_unavailable')` (`retryable`). Routes map it to 503, other denials to 403. The worker fails the assignment with `source_resolution_unavailable` (member retries) instead of `source_denied`.
- Reconciler: no code change. The generation CAS claim already blocks a stale pass; a test now pins it. Between claim and runtime call, an admin disable is not seen until the next pass, which removes the runtime. Documented gap.

## childContext (item 7): left unchanged

`childContext` trims widened grants through `intersectAuthority`. Its only caller is `delegation/orchestrator.ts`. Denying needs a new `DelegationAudit['reason']` value in `packages/domain/src/delegation.ts` (outside this write set). The shared `fixtureChild` in `delegation/fixtures.ts` deliberately carries a widened `email.send` grant that many orchestrator tests rely on. AGT-02 owns `context.ts` and `orchestrator.ts` per the AGT-00 path table. Deferred to AGT-02: add reason `grant_widening`, deny when `request.grants` is not a subset of the parent, update the fixture.

## Residual risks

- A provider call already accepted cannot be retracted; the check-to-call gap remains.
- No real directory client exists; `Deps.directory` is a seam until one is wired.
- MCP/A2A marketplace entries untouched.
