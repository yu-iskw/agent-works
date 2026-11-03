# SCH-04 evidence: bounded agent-created routines

Base: `origin/epv1/integration` (71eb8d5). Branch `epv1/sch-04-routines`. Status: READY_FOR_REVIEW, not VALIDATED.

## Design

- A routine is an ordinary schedule plus a binding row in `tw_routines` (migration `0030_routines.sql`, needs 0024). `routine_id` is the schedule id.
- The model's output is a proposal: `{ grantId, idempotencyKey, kind, spec }`, parsed by a strict zod schema. The server sets `spec.id` (hash of grant and key), `consentRef` (`grant:<grantId>`) and checks the sponsor. The caller must be the grant's grantee bot, as the server established it.
- `validateProposal` (pure code, `routines/validate.ts`) checks, in order: schedule rights, sponsor, every (scope, source) pair against the grant chain through `resolveStandingAuthority`, budget, lifetime (grant `maxLifetimeSeconds`, 31 day platform cap, earliest expiry in the chain), and frequency. Frequency counts real fires, so a DST repeat is measured. The floor is `max(60 s, grant.minIntervalSeconds)`.
- Fan-out cap is the grant's `maxActiveRoutines`, counted and inserted under a per-grant advisory lock. `limits.maxFanOut` stays the child-grant cap from AGT-03.
- `authorize(routineId)` re-reads the chain. Permanent denials (revoked, expired, ancestor unusable, missing) cancel the routine and revoke the schedule, which cancels queued and running occurrences through the existing revoke and worker cancel path. Activation off pauses without cancelling.
- Activation reuses `AW_STANDING_GRANTS` plus `AW_STANDING_GRANTS_O04_REF`. Off by default, so `propose` returns `ACTIVATION_OFF`. Human schedules never pass through this code.

## Acceptance mapping

| Criterion                                                         | Test (`apps/api/src/scheduling/routines/routines.test.ts`)                                                             | Env                  |
| ----------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- | -------------------- |
| Activation off denies agent routines, human schedules unaffected  | `is denied while activation is off...`                                                                                 | local, both stores   |
| Cannot widen scope, sponsor, budget, lifetime                     | `never widens scope, sponsor, budget or lifetime...`, `caps lifetime at the earliest expiry...`                        | local                |
| Frequency floor, 60 s platform floor                              | `enforces the frequency floor...` (59 s fails schema)                                                                  | local                |
| DST                                                               | `measures cron frequency in real time across the DST fall-back repeat` (America/New_York, 1h repeat)                   | local                |
| Fan-out cap                                                       | `enforces the fan-out cap...`, parallel `never exceeds the fan-out cap...`                                             | local, real Postgres |
| Idempotent creation                                               | `treats a repeated creation request as the same routine`, parallel `collapses concurrent duplicates...` (8 concurrent) | local, real Postgres |
| Revocation and ancestor revocation cancel routine and occurrences | `cancels the routine and its queued and running occurrences...`, `cancels a child routine when an ancestor...`         | local                |
| Expiry                                                            | `stops at the routine expiry...`                                                                                       | local                |
| Cancel semantics                                                  | `cancel stops future occurrences, cancels the running one, and repeats safely`                                         | local                |
| Injection yields no authority                                     | `gives a prompt-injected proposal no new authority`                                                                    | local                |
| Scheduler refuses the schedule                                    | `cancels the binding and frees the slot...`                                                                            | local                |

Every behavior runs against both the memory stores and real Postgres (disposable container).

## Commands

| Command                                                                         | Result                                |
| ------------------------------------------------------------------------------- | ------------------------------------- |
| `pnpm exec vitest run apps/api/src/scheduling/routines`                         | 34 passed                             |
| `pnpm exec vitest run apps/api/src/scheduling apps/api/src/authority-lifecycle` | 300 passed, 1 skipped (pre-existing)  |
| `pnpm build`                                                                    | exit 0                                |
| `pnpm typecheck`                                                                | exit 0                                |
| `pnpm exec eslint apps/api/src/scheduling/routines`                             | exit 0                                |
| `pnpm exec prettier --check apps/api/src/scheduling/routines`                   | exit 0                                |
| `pnpm knip`                                                                     | exit 0 (one pre-existing config hint) |

## Migration and rollback

`0030_routines.sql` is additive and re-runnable; `applyRoutineMigration` (lock 7030) is opt-in like 0024's runner. Rollback: stop using the service; drop `tw_routines` only after cancelling its schedules. No applied migration edited.

## Wiring the coordinator must do

1. Apply 0024 then 0030 in the segment; construct `createPostgresRoutineStore(sql)`.
2. Build `createRoutineService({ grants, routines, schedules: createRoutineSchedules({ scheduler, store, consent }), activation: readGrantActivation(), now })`. `scheduler` must be built with `authority: service.guardSponsorAuthority(baseAuthority)` so the scheduler's tick, claim and post-dispatch checks enforce the binding (create the service first and pass the scheduler lazily, as the test does).
3. Before each effect of a routine execution call `service.authorize(routineId)` (or rely on the AGT-03 standing authority resolver, which the worker effect gate already uses).
4. Run `service.sweep()` on the scheduler tick so a grant revocation cancels queued occurrences without waiting for a claim.
5. Expose `service.propose` and `service.cancel` on a route (`schedules-proposal.ts` was not needed here); the actor must come from the running bot identity, never the request body.

## Operator work

AWAITING_OPERATOR: Stage 1 gate and O04 signoff before setting `AW_STANDING_GRANTS=on` with an O04 reference. Real grant limits are still placeholders.

## Residual risks

- Cron frequency is measured by a bounded minute scan (31 day cap, about 45k minutes); a very long platform cap would need a smarter enumerator.
- Consent for an agent routine is the grant itself, recorded in the local consent registry; a deployment with a durable consent registry must give `createRoutineSchedules` an equivalent sink.
- A crash between the binding insert and schedule creation leaves an active binding; a repeat of the same request re-runs the idempotent schedule create, and the sweeper never grants anything.
