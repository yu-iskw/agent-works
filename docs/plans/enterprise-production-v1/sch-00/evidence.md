# SCH-00 evidence

- Task / owner / date / status: SCH-00, worker agent, 2026-11-03, READY_FOR_REVIEW (not VALIDATED). O06 recommendation only; O06 open.
- Base: `origin/epv1/integration` 16050f5. Result SHA: see report. Branch `epv1/sch-00-contracts`. No push, no PR.
- Write set: `apps/api/src/scheduling/characterization*.test.ts`, `apps/api/src/scheduling/sch-00/*`, `packages/domain/src/dispatch-envelope{,.test}.ts`, `scripts/sch-00/run-bench.mjs`, this directory. No migration, no behavior change.

| Criterion                                                                                                                | Test/command                                                             | Result                                        | Evidence                                  | Local/live | Revision   |
| ------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------ | --------------------------------------------- | ----------------------------------------- | ---------- | ---------- |
| Existing timing/DST/catch-up tests pass                                                                                  | `pnpm exec vitest run` in apps/api (scheduling, ports)                   | PASS (see report)                             | test output                               | local      | result SHA |
| Semantics pinned (60 s, cron grammar, tz, UTC identity, DST repeat/missing, window, expiry, skip, catch-up-once, resume) | `characterization.test.ts` (38 tests)                                    | PASS                                          | file                                      | local      | result SHA |
| DUR-01 uniqueness and edit at due time on real Postgres                                                                  | `characterization-postgres.test.ts` (6 tests, Docker postgres:16-alpine) | PASS                                          | file                                      | local      | result SHA |
| Multi-dispatcher experiment with sample sizes                                                                            | `node scripts/sch-00/run-bench.mjs`                                      | PASS (0 duplicates, 0 missing in every trial) | `bench-results.json`, `bench-summary.txt` | local      | result SHA |
| Revision-induced duplicates rejected                                                                                     | `dispatch-envelope.test.ts`, Postgres edit tests                         | PASS                                          | contract.md section 2                     | local      | result SHA |
| Envelope schema, fixture, unknown version, old/new compat                                                                | `dispatch-envelope.test.ts` (27 tests)                                   | PASS                                          | contract.md section 3                     | local      | result SHA |
| O06 and boundaries                                                                                                       | contract.md section 6                                                    | RECOMMENDATION, decision open                 |                                           | n/a        |            |

## Benchmark (local, not a cloud number)

Claim: with the same data, a bounded `FOR UPDATE SKIP LOCKED` claim drains due schedules far faster than the global advisory-lock store and does not degrade with more dispatchers.

- Machine: Apple M4, 10 logical CPUs, 32 GiB, Node v24.13.0. Postgres 16.15 in Docker Desktop (VM: 2 CPUs, 4 GB), data dir on tmpfs, fsync on, synchronous_commit on, shared_buffers 128 MB. Host load average at start 3.1, 2.4, 2.2 (check `uptime`). Run 2026-11-03T03:22:10Z to 03:31:03Z. An earlier dry run under load 9 was discarded.
- Method: 5 repetitions per cell, side order alternated by repetition, fresh seeded database per trial, one pool per dispatcher. S = 200 due schedules, one UTC slot each. Row claim batch = 10 (tuned: index on `(next_due, schedule_id)`, single-statement claim, unique runs and outbox insert, cursor advance). Current store is driven through its real `claim` and `advance` calls (the real tick makes about seven calls per schedule, so this favors current).
- Row-claim scale-out probe: S = 10000, batch 50, 3 repetitions, row claim only.

| Side, N      | Occurrences/s median (range), n=5 | Op p95 ms | Mean sessions waiting on a lock |
| ------------ | --------------------------------- | --------- | ------------------------------- |
| current, 1   | 19.8 (7.6 to 21.3)                | 34.1      | 0.00                            |
| current, 2   | 12.9 (12.3 to 14.5)               | 88.7      | 0.84                            |
| current, 4   | 7.1 (6.3 to 8.7)                  | 210.1     | 2.73                            |
| row claim, 1 | 10568 (2206 to 12924)             | 0.7       | 0.00                            |
| row claim, 2 | 11952 (3902 to 12365)             | 9.6       | 0.00                            |
| row claim, 4 | 5081 (446 to 10157)               | 28.1      | 0.00                            |

S = 10000 row claim: N=1 8562 (5187 to 9777), N=2 9255 (8682 to 19484), N=4 15521 (11168 to 23006), n=3 each.

Current-store single-dispatcher op p50 vs total schedules (n=3): S=50 6.8 ms, 100 11.7, 200 22.0, 400 42.8. Linear in S.

- Verdict: row claim is about 500x faster than the current store at S=200, N=1, and the gap widens with N. Duplicates 0 and missing 0 in all trials of both sides (about 60 trials).
- Limiter, current: each call takes advisory lock 7013 and reads and rewrites all schedule state, so cost grows linearly with S and extra dispatchers only queue (throughput falls 19.8 to 7.1 as N goes 1 to 4; waiters rise to 2.7). Measured by the scaling series and lock sampling. Not a CPU profile.
- Caveats. At S = 200 a row-claim trial lasts about 20 ms, so its range is wide and the N=4 dip (median 5081) is within noise and partly Docker VM scheduling on 2 CPUs; do not read it as N=4 being slower. The S = 10000 probe is the better row-claim scaling sample, but it is n=3 and its N=2 and N=4 ranges overlap with N=1 at the low end. Tail ranges are caused by the load generator and VM, not measured separately. The prototype omits outbox publishing, leases and authorization, so it bounds only the claim step. Lock waiters are sampled at 25 ms. Single machine, single run set; not repeatable evidence for cloud.
- Raw trials with timestamps: `bench-results.json`. Rerun: `node scripts/sch-00/run-bench.mjs`.

## Other

- Positive controls: golden envelope bytes, v1 and v2 readers, unique-index winner. Negative and fault: unknown field, token field, oversize, malformed, revision in identity, non-canonical instants, stale revision, DB unique violations.
- Migration/compat: none applied; cutover plan in contract.md section 5.
- Rollback: none needed for this change (tests, harness, types, docs only).
- Open risks: O06 decision; the real tick does more calls than benchmarked; row-claim prototype is not production code; Cloud Tasks name reuse behavior is unverified (operator/live).
- Operator work: restore drill in a separate environment before cutover; Cloud Tasks live name and dedupe behavior check. AWAITING_OPERATOR.
- Integration validation on combined revision: UNTESTED (coordinator).
