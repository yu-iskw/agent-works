# OPS-04 evidence

- Task / owner / date / status: OPS-04 / agent / 2026-11-04 / READY_FOR_REVIEW locally. Live campaign AWAITING_OPERATOR.
- Base SHA / result SHA / draft PR: origin/epv1/integration / see commit on `epv1/ops-04-campaign` / none.
- Changed files and scope exceptions: `scripts/ops-04/**`, `docs/plans/enterprise-production-v1/ops-04/**`, `docs/runbooks/capacity-campaign.md`. No exceptions, no migration.

## Criteria

| Criterion                                                                              | Test/command                                                                            | Result                                                 | Evidence path                                      | Local or live               | Revision                             |
| -------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- | ------------------------------------------------------ | -------------------------------------------------- | --------------------------- | ------------------------------------ |
| Harness runs dispatcher, outbox, worker, sweeper on real Postgres with injected faults | `pnpm exec vitest run --project scripts scripts/ops-04` (tiny profile, Docker Postgres) | PASS (14 tests)                                        | `scripts/ops-04/ops-04.test.mjs`                   | local-synthetic             | branch head                          |
| 24 h soak, 500-slot burst (P01)                                                        | `node scripts/ops-04/run.mjs scripts/ops-04/workload-local-scaled.json` (480x)          | RAN, see below                                         | `results/ops04-2026-11-03T23-22-45-825Z.json`      | local-synthetic, compressed | harness at working tree on `71eb8d5` |
| Full-length P01 spec for operator                                                      | `scripts/ops-04/workload-full.json`                                                     | SPEC ONLY, not run                                     | spec file                                          | n/a                         | n/a                                  |
| Worker death, P04                                                                      | same run, 100 injected deaths                                                           | RAN, not comparable                                    | same file                                          | local-synthetic             | same                                 |
| Lost queue messages, DB restart, provider outage                                       | same run                                                                                | RAN                                                    | same file, `faults`                                | local-synthetic             | same                                 |
| Stop/revoke observation, P05                                                           | same run, 55 revocations                                                                | RAN, not comparable                                    | same file                                          | local-synthetic             | same                                 |
| Threshold proposal, never approves                                                     | `node scripts/ops-04/propose-thresholds.mjs`                                            | PASS: all lines NO_COMPARABLE_EVIDENCE, approved=false | `proposals/proposal-2026-11-03T23-26-08-539Z.json` | local-synthetic             | same                                 |
| Live soak, burst, worker kill, DB failover/restore, provider outage                    | `docs/runbooks/capacity-campaign.md` blocks A to D                                      | AWAITING_OPERATOR                                      | none                                               | live                        | n/a                                  |
| P06 RTO/RPO, P07 monthly availability                                                  | runbook Block D; P07 needs a monthly window                                             | AWAITING_OPERATOR                                      | none                                               | live                        | n/a                                  |

## Scaled run (480x, one run, local-synthetic)

Machine: Apple M4, 10 cores, 32 GB, Docker 29.9.2, Postgres 16.15 container, Node 24.13.0, load average about 2.5 at start. Pool 30, 50 workers, 3 steps per execution.

- Sample sizes: 1,500 schedules, 2,499 executions (7,497 steps), 100 worker deaths, 55 revocations (3 moot because the run had already finished).
- Integrity: loss 0, duplicate remote writes 0, duplicate runs 0, applied-but-unrecorded 0. Uncertain effects ever 50, all reconciled, 0 unresolved. 36 effects were rewritten after a not-applied resolution (not duplicates: provider count per key stayed 1). Terminal states: 2,423 succeeded, 47 denied (revoked), 8 cancelled (revoked), 21 quarantined (visible, not lost).
- P02 due-to-start: p50 54 s, p95 1,303 s, p99 4,072 s, max 5,126 s virtual (real p50 0.11 s, p95 2.7 s, max 10.7 s). Exceeds the provisional 120 s and 300 s, but not comparable: the tail is the DB crash window (database answered 5.4 s real after the kill, the dispatcher recovered 10.2 s real after it) and the two provider and queue windows, each multiplied by 480 in virtual time. Limiter for the median: two 50 ms ticks, 20 ms queue delay, 50 ms worker poll (170 ms real, 82 s virtual). The burst of 500 slots adds worker-capacity wait.
- P03 terminal success within 10 min: 72.1% of 2,444 eligible executions (7,332 steps; 55 intentional revocations excluded; 21 quarantined). The sample meets 5,000 steps. The shortfall comes from executions that waited out the DB, provider and queue windows past 10 virtual minutes; a window of 15 virtual minutes is 1.9 real seconds here. Not comparable to the live 99% target.
- P04 lease recovery (lease expiry to release): n=100, p50 46 s, p95 1,892 s, worst 4,024 s virtual (real worst 8.4 s). Zero unreleased. Worst cases coincide with the DB-down window when the sweeper could not run. Death to resumed attempt: p50 551 s virtual, worst 2,531 s (the in-effect deaths wait for reconciliation).
- P05 stop/revoke: queued n=5, worst 30 s virtual (63 ms real); running n=50, p95 629 s, worst 5,630 s virtual (11.7 s real). Zero unobserved. Running revocations are seen at the next gate check, which is delayed while the execution sits in retry backoff or a fault window.
- Harness as limiter: event-loop delay p99 13 ms, process CPU 29.7 s over a roughly 3.5 min run, so the single-process harness was not saturated. Postgres CPU was not profiled, so the database limiter is inferred from the crash-window timing, not measured. Single run, no range.
- Slots: 2,499 expected by formula, 2,499 claimed.
- The run logged one harmless duplicate-key error from the revocation injector picking an already revoked execution; the injector now excludes those. Results were produced from a working tree marked dirty (`sourceDirty: true`) at `71eb8d5` plus the harness files.

Verdicts against provisional targets are `exceeds-provisional-target` for P02 to P05 and are indicative only. No target is approved or changed.

## Positive controls

Clean-run metrics report zero loss and duplicates; the tiny profile injects 3 deaths, a queue drop, duplicate deliveries, a DB crash and an ack-lost window and loses nothing.

## Negative and fault cases

Pure metric tests detect a duplicate remote write, an applied-but-unrecorded effect, a missing worker row, a stuck run, an unreleased lease, and compressed time marked not comparable. Small samples return `insufficient-sample`. The proposal tool ignores non-`local-synthetic` results and never approves.

## Migration/backward compatibility

No migration. The harness only reads `apps/api/dist`. It creates `ops04_revocations` in its own disposable container.

## Rollback or forward repair

Delete `scripts/ops-04/`, `docs/plans/enterprise-production-v1/ops-04/` and `docs/runbooks/capacity-campaign.md`.

## Open risks / decisions / follow-up owner

- Targets P02 to P05 remain provisional; an owner approves values from live runs.
- The harness bypasses the HTTP delivery handler and OIDC; the queue and provider are stand-ins.
- Finding to investigate: the dispatcher needed about 5 s after the database answered to recover from a SIGKILL (inferred: stale pooled connections; not verified).
- The dispatcher claim lease is capped at 300,000 ms by the scheduler store, so the harness clamps it.

## Operator work still required

Fill the placeholders in `docs/runbooks/capacity-campaign.md`, obtain approval for each block, run A to D, and attach live evidence. P06 and P07 cannot be closed locally.

## Integration validation on combined revision

Not done.

## Postmortem according to repository instructions

Friction: first scaled run stalled silently because the dispatcher lease exceeded the store cap; the harness now records error messages and has an optional progress line (`OPS04_PROGRESS=1`).
