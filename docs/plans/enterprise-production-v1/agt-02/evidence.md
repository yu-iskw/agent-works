# AGT-02 evidence: coordinator proposals and bounded delegation

Base: origin/epv1/integration. All results local (Postgres via Docker). Nothing live. Not VALIDATED.

| Criterion                                              | Test                                                                                                                                                                             | Result |
| ------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| Injected plan gets no new tools, grants or approval    | `teamwork/coordinator-proposal.test.ts` "prompt-injected output" (extra keys refused, `approval_bypass`, no grant without ask)                                                   | PASS   |
| Requested grants must be a subset of the parent (deny) | same file: `grant_widening` for extra grant or other resource; revoked/expired parent `grant_denied`; deeper chain `depth`                                                       | PASS   |
| Unauthorized bot or source refused                     | same file: `unknown_bot`, `unauthorized_source`, `wrong_result_owner`                                                                                                            | PASS   |
| Cycle, dangling edge, duplicate key refused            | same file "structure and caps"                                                                                                                                                   | PASS   |
| Node, fan-out and depth caps deterministic             | same file: `node_cap` (policy and parent `maxFanOut`), `fan_out`, `depth`; identical verdict across runs and node order                                                          | PASS   |
| Child context denies widening, is a bounded copy       | `delegation/context.test.ts` (`grant_widening`, own task id, mutation does not touch parent); `orchestrator.test.ts` (no edge, charge or execution; audit `grant_widening`)      | PASS   |
| Fresh coordinator resumes from committed graph         | `teamwork/coordinator-proposal.postgres.test.ts` (real Postgres): worker killed during node 2; new deps/model finish it; node 1 output and `finished_at` unchanged, 1 model call | PASS   |

## Design

- `validateProposal(raw, ctx)` takes parsed JSON (`parseProposalText`), never the lenient `parsePlan` result. Strict schema: any unknown key (tools, approval flags) is refused whole. It denies, never trims. All reasons come back in a fixed order, so equal input gives an equal verdict.
- Accepted output is a `PlanContent` for the existing `proposed` plan (member approval unchanged) plus a derived `StandingGrant` per node that asked for authority, built by `deriveChildGrant` from the coordinator grant (read-only, no further delegation, parent expiry and budget).
- `childContext` now throws `DelegationDenied('grant_widening')` instead of intersecting. New `DelegationAudit` reason `grant_widening` in `packages/domain/src/delegation.ts`. `fixtureChild` lost its widened `email.send` grant; `fixtureWidenedChild` carries it for the negative tests.

## Behavior change and rollback

No migration. Only `childContext` behavior changed (deny vs trim); its sole caller is the delegator. Rollback is reverting the commit.

## Wiring left to the coordinator

In `teamwork/worker.ts` `plan()`, replace `parsePlan` plus the silent filtering with `validateProposal(parseProposalText(raw.text), ctx)`; build `roster` (bot id to `{version, sources}`) from the existing roster and `effectiveFor`, and `parentGrant` from the AGT-03 resolver. On refusal fail the task `invalid_output`/`plan_unusable` and record the reasons. Nothing is wired yet, so behavior in production code is unchanged.

## Residual risks

- Grants requested by the proposal are validated and derived but not yet consumed by a scheduler. The delegator accepts `childGrants` via `DelegationRequest.grants`.
- Kill test covers a worker dying mid-node; a crash during the `plan` job itself was not tested.
