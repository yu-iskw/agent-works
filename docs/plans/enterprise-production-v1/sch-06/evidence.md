# SCH-06 evidence: fair admission and quota controls

- Task / owner / date / status: SCH-06 / worker agent / 2026-11-03 / READY_FOR_REVIEW (local only)
- Base SHA / result SHA / draft PR: be725be / see commit on `epv1/sch-06-admission` / none
- Changed files: `apps/api/migrations/0025_admission.sql`, `apps/api/src/admission/**`, this file. No scope exceptions.

## Design

Data shape: `admission_limits` (owner-set caps per member/bot/segment, nothing seeded), `admission_scopes` (lock rows), `admission_reservations` (primary key `execution_id`), `admission_token_buckets`.

- **Atomic cap.** One transaction locks the bot, member and segment scope rows in fixed `(kind, id)` order, counts live reservations, then inserts. Counts are derived from reservations, so they cannot drift.
- **Once per logical execution.** `execution_id` is the primary key. A redelivery returns the stored reservation and takes no second slot, cost or token. A different member/bot/segment under the same id throws.
- **Release and reconcile.** `release(outcome, actualCost?)` is idempotent. Cancel refunds cost to 0, failure keeps the estimate, an actual cost overrides both. A lease lapsed past `expires_at` stops counting immediately; `sweepExpired()` marks it `expired` (cost stays charged, outcome unknown). `renew` returns false once lapsed, which fences the old holder. An expired execution redelivered later re-admits in place on the same row.
- **Token bucket.** Taken inside the same short transaction as the last step. A shortfall returns `retryAfterMs`; the caller waits outside any transaction. A denial leaves no reservation.
- **Cost budget.** `max_cost_micros` per scope per owner-defined `windowKey`. No limit row means no check; no dollar value exists in code or migration.
- **Suspension.** The existing `SuspensionEnforcer.check(ctx, 'admission')` runs first; a stopped scope returns `suspended` and writes nothing. A service built with an enforcer rejects requests without an invocation context.
- **Fairness policy.** A segment may set `max_share_bps`. One member then holds at most `max(1, floor(cap * bps / 10000))` of the segment slots, so a noisy member always leaves the rest for peers. Work-conserving sharing was rejected: it needs knowledge of waiting peers, which admission does not have.
- **Existing dev budget-alert rule.** Untouched. The rule lives in `infra/terraform/modules/budget` and this change does not edit it. `finops/**` is unchanged and is not wired to this module.

## Acceptance mapping

All tests are in `apps/api/src/admission/postgres-admission.test.ts`, real PostgreSQL (docker, `startDisposablePostgres`). Local, not live.

| Criterion                                         | Test                                                                                                                           | Result |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ | ------ |
| Concurrent admission cannot exceed cap            | `segment/member/bot cap holds under 40 parallel callers`: 5 admitted, 35 denied                                                | PASS   |
| Redelivery consumes no second reservation         | `parallel redelivery ...`: 12 parallel calls, 1 row, 1 token spent, 1 non-replay                                               | PASS   |
| Identity reuse rejected                           | `execution id reused for a different member`                                                                                   | PASS   |
| Release on success/failure/cancel                 | `release on %s ...` (3 cases), idempotent, re-admit gives `already_finished`                                                   | PASS   |
| Expiry reclaim                                    | `expired leases are reclaimed by the sweep ...`, `a lapsed lease stops counting ...`                                           | PASS   |
| Cap raised/lowered at runtime                     | `caps change at runtime ...`; lowering keeps running work and denies new                                                       | PASS   |
| Cost budget from owner limit                      | `cost budget follows the owner limit ...` (unlimited without a row, refund on cancel, actual cost)                             | PASS   |
| Token pacing, no lock while waiting               | `provider tokens are paced ...`: denial returns `retryAfterMs` 1000, bucket row lockable with `nowait`, no reservation written | PASS   |
| Suspended scope denies                            | `a suspended scope is denied admission and resumes`                                                                            | PASS   |
| Noisy member cannot starve peers                  | `fairness ...` simulation below                                                                                                | PASS   |
| Migration idempotent, no applied migration edited | `migration 0025 applies idempotently`; 0001..0023 untouched                                                                    | PASS   |

### Fairness simulation (sample sizes)

Segment cap 10. Each of 60 ticks: one noisy member makes 12 attempts (holds 3 ticks), then 4 peers make 1 attempt each (hold 1 tick). The noisy member always goes first, the worst case for peers. Single run, deterministic.

| Policy                                         | Noisy admitted / tried | Peers admitted / tried |
| ---------------------------------------------- | ---------------------- | ---------------------- |
| No share limit                                 | 200 / 720              | 0 / 240                |
| `max_share_bps` 5000 (noisy capped at 5 slots) | 100 / 720              | 240 / 240              |

The result holds for peer demand up to cap minus the noisy ceiling (here 4 of 5). Beyond that peers contend with each other; that is not covered.

## Commands

| Command                                                                                                | Exit |
| ------------------------------------------------------------------------------------------------------ | ---- |
| `pnpm exec vitest run apps/api/src/admission` (16 tests)                                               | 0    |
| `pnpm build`                                                                                           | 0    |
| `pnpm typecheck`                                                                                       | 0    |
| `pnpm exec eslint apps/api/src/admission` (0 errors, 6 object-injection warnings on fixed column maps) | 0    |
| `pnpm exec prettier --check` on touched files                                                          | 0    |
| `pnpm knip` (one pre-existing hint about `apps/web`)                                                   | 0    |

## Notes

- Migration/rollback: 0025 only adds tables; rollback is dropping the four `admission_*` tables and the `schema_migrations` row. Nothing reads them until wired.
- Lock scope: all admissions of one segment serialize on the segment row for a few statements. Throughput under one segment is bounded by that; measure before relying on it at scale (not measured here).
- Releasing with an actual cost above the estimate can exceed a cost limit after the fact; the next admission sees it.
- Open decisions for the owner: lease length (`leaseMs` has no default), sweep cadence, per-scope caps, share bps, budget windows and amounts, provider bucket capacity and refill. All are configuration.
- Operator work: none for local. Live enablement needs those values approved (`templates/operator-approval.md`): AWAITING_OPERATOR.
- Wiring the coordinator must do: in `server.ts`, `const admission = await createAdmissionService({ sql, leaseMs: <owner value>, suspension: <existing enforcer> })`; call `admit` before dispatch with the logical execution id, `release` on terminal outcomes (success/failure/cancel), `renew` on heartbeat, and run `sweepExpired` on a timer in the existing worker loop. Seed limits via `setLimit`/`setProviderBucket`. Add 0025 to the `migrations/README.md` table.
