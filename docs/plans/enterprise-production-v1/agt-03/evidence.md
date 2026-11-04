# Task completion evidence

- Task / owner / date / status: AGT-03 / agent worker / 2026-11-03 / READY_FOR_REVIEW (not VALIDATED)
- Base SHA / result SHA / draft PR: be725be / see commit on `epv1/agt-03-grants` / none
- Changed files and scope exceptions: new `apps/api/src/authority-lifecycle/**`, `apps/api/migrations/0024_standing_grants.sql`, `docs/plans/enterprise-production-v1/agt-03/**`. Scope exception, separate commit: alias line in `apps/api/vitest.config.ts`, without which no test importing the contract resolves.

| Criterion                                                                                | Test/command                                                                                                                      | Result            | Evidence path            | Local or live | Revision    |
| ---------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- | ----------------- | ------------------------ | ------------- | ----------- |
| Parent/child intersection covers resource/action/time/depth/budget (+ fan-out, schedule) | `pnpm exec vitest run apps/api/src/authority-lifecycle` (`parent/child intersection`, 12 widening rows, boundary, depth, fan-out) | PASS              | `lifecycle.test.ts`      | local         | branch HEAD |
| Revoked sponsor prevents queued and subsequent sensitive work                            | `resolver.test.ts` through the real broker: queued and later calls denied, zero provider posts                                    | PASS              | `resolver.test.ts`       | local         | branch HEAD |
| Expired grant mid-queue denied, zero provider calls                                      | `resolver.test.ts`                                                                                                                | PASS              | `resolver.test.ts`       | local         | branch HEAD |
| Issuance requires authorized human/admin policy                                          | `lifecycle.test.ts` (member and bot denied, owner and admin allowed)                                                              | PASS              | `lifecycle.test.ts`      | local         | branch HEAD |
| Activation OFF denies issuance                                                           | `lifecycle.test.ts` (flag defaults, root and child denied while off, audit row)                                                   | PASS              | `lifecycle.test.ts`      | local         | branch HEAD |
| Uniqueness, rollback, fencing on real Postgres                                           | `postgres-store.test.ts` (fan-out race, issue-vs-revoke race, concurrent revoke, triggers); not skipped                           | PASS              | `postgres-store.test.ts` | local         | branch HEAD |
| O04 approval before live enablement                                                      | Flag needs `AW_STANDING_GRANTS_O04_REF`; no live run                                                                              | AWAITING_OPERATOR | README "Activation"      | live          | n/a         |

- Positive controls: owner and admin issue; equal-to-parent child accepted; live grant lets exactly one ticket post through the broker.
- Negative and fault cases: each widening axis, bot or member issuer, non-grantee child, expired or revoked parent, lifetime over ceiling, store read failure (503), unbound task, wrong resource, wrong actor, flag off, trigger-blocked edits and deletes.
- Migration/backward compatibility: additive, `if not exists`, applied under advisory lock 7024 and recorded in `schema_migrations`. No applied migration edited. Nothing reads the tables while the flag is OFF.
- Rollback or forward repair: leave the flag OFF; repairs use a new migration number.
- Open risks / decisions / follow-up owner: child issuance is by the parent's grantee bot (server-built request), per the contract; coordinator should confirm that is acceptable against "never by an agent". Deep-chain insert race is covered by call-time chain walking, not by the sweep.
- Operator work still required: O04 approval and `AW_STANDING_GRANTS_O04_REF` before any live enablement; approved budget values replacing placeholders.
- Integration validation on combined revision: not run.
- Postmortem according to repository instructions: skipped; no unexpected failure beyond a missing vitest alias.

Commands (run in the worktree): `pnpm exec tsc -p apps/api --noEmit` 0; `pnpm build` 0; `pnpm typecheck` 0; `pnpm exec vitest run apps/api/src/authority-lifecycle` 0 (3 files, 97 tests); `pnpm exec eslint apps/api/src/authority-lifecycle` no issues; `pnpm exec prettier --check` clean; `pnpm knip` no new findings (one pre-existing config hint).
