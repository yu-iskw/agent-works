# Capacity and fault campaign (OPS-04, operator-run)

This runbook is for the operator. Nothing here is approved, scheduled or executed by an agent.
The agent prepared the local synthetic harness (`scripts/ops-04/`) and these requests. Every live
step needs the named human approval in the matching block, bound to the exact revision. A block
with an unfilled `<<PLACEHOLDER>>` is blocked.

Results from the local harness are labeled `local-synthetic`. They show that the mechanics work and
where the code stalls on one laptop. They are not evidence for P01 to P07 in any cloud environment.
Targets P02 to P05 stay provisional until a human approves values from live runs
(`node scripts/ops-04/propose-thresholds.mjs` only proposes).

## Placeholders to fill before any block is approved

| Placeholder                                           | Meaning                                                              |
| ----------------------------------------------------- | -------------------------------------------------------------------- |
| `<<PROJECT_ID>>`                                      | Cloud project that holds the campaign environment (never production) |
| `<<ENV>>`                                             | Environment name, for example a dedicated `capacity` environment     |
| `<<REGION>>`                                          | Region of the campaign environment                                   |
| `<<DB_INSTANCE>>`                                     | Database instance identifier                                         |
| `<<WORKER_SERVICE>>`                                  | Worker service or job identifier                                     |
| `<<QUEUE_NAME>>`                                      | Task queue identifier                                                |
| `<<SOURCE_SHA>>`, `<<IMAGE_DIGEST>>`                  | Revision under test                                                  |
| `<<SCHEMA_VERSION>>`, `<<CONFIG_REVISION>>`           | Last applied migration and config/policy revision                    |
| `<<APPROVER>>`, `<<APPROVAL_REF>>`, `<<APPROVAL_TS>>` | Filled by the approver, never by an agent                            |

## Global rules (apply to every block)

- Target only `<<ENV>>` in `<<PROJECT_ID>>`. A production project, shared data or a customer-visible
  channel is out of scope. The campaign data is synthetic. Provider calls use a test provider or a
  sandbox account with write access to nothing real.
- No model-backed task runs in the campaign. Model-backed checks are a separate test with its own approval.
- Dry run first: run the same block against local disposable Postgres with
  `node scripts/ops-04/run.mjs` (any profile) before the live window. A live block never is the first run.
- One fault at a time. The next fault starts only after the previous one is recovered and the
  reconciliation check below reports zero unresolved items, or the operator records why not.
- Record, for every fault: dataset digest before, injected event and time, detection time, recovery
  time, loss, duplicates, uncertain effects, and authorization behavior after recovery (a revoked
  grant must still be denied).
- Reconcile pending and uncertain effects before any replay. Do not replay a write whose outcome is
  unknown.
- Report worst case with the median. Report sample size next to every number. Report any number that
  ran during a fault window apart from steady state.

### Stop rules (any one aborts the campaign and starts rollback)

1. Any write reaches a resource outside the approved test provider or `<<ENV>>`.
2. Any duplicate external write is observed, or any effect is applied but not recorded.
3. Unresolved uncertain effects grow for 15 minutes with no reconciliation progress.
4. A revoked or suspended grant is honored after the revocation committed and one authoritative check passed.
5. Spend for the window exceeds the approved cap in the block below.
6. The operator cannot reach the console or the CLI session for the injection tooling.
7. The window expiry passes.

### Reconciliation check (run after each fault)

```sql
select state, count(*) from execution_effects group by state;
select state, count(*) from worker_executions group by state;
select count(*) as runs_without_worker
  from schedule_runs r
 where r.status not in ('denied','cancelled','completed')
   and not exists (select 1 from worker_executions w where w.execution_id = r.id);
select count(*) as duplicate_runs from (
  select schedule_id, fire_at from schedule_runs group by 1, 2 having count(*) > 1) d;
```

Pass means: `uncertain` is 0 or each item has a recorded read-back or manual resolution, nothing is
`queued` or `running` past its deadline, `runs_without_worker` is 0, `duplicate_runs` is 0, and the
provider-side count of writes per effect key is at most 1.

## Order of work

1. Local harness dry runs (agent or operator): `pnpm build`, then
   `node scripts/ops-04/run.mjs scripts/ops-04/workload-local-scaled.json`.
2. Block A: soak and burst (steady state baseline).
3. Block B: worker termination.
4. Block C: provider outage.
5. Block D: database failover and restore.

Block A is the baseline for B to D. Run D last because it is the most disruptive.

---

## Block A: 24 h soak and 500-slot burst (P01, P02, P03, P05)

- Task and reason: OPS-04. Measure due-to-start latency, terminal-success rate and stop/revoke observation under the P01 shape on the real deployment.
- Exact project/environment/region: `<<PROJECT_ID>>` / `<<ENV>>` / `<<REGION>>`.
- Source SHA / image digest / schema/config versions: `<<SOURCE_SHA>>` / `<<IMAGE_DIGEST>>` / `<<SCHEMA_VERSION>>` / `<<CONFIG_REVISION>>`.
- Proposed commands or manual workflow and inputs: load the workload in `scripts/ops-04/workload-full.json` (10,000 base schedules plus a 500-schedule burst group due at one instant; 5,000 executions per day; 50 concurrently active steps; 3 steps per execution; 60 revocations spread over the run). The seeding and the reconciliation queries use the same SQL as the harness. Synthetic workers only. Start the soak, trigger nothing else, and let the burst fire at hour 6.
- IAM/OAuth scopes or external writes involved: the deployer role already approved for `<<ENV>>` to seed schedules; no new scope. External writes go only to the test provider.
- Expected cost and blast radius: 24 h of the campaign environment at the configured worker count plus provider sandbox usage. Proposed cap: twice the metered cost of the environment for the window; the approver confirms or lowers it. Customer impact: none. Shared databases or queues: none.
- Preconditions and local evidence: local dry run results file path `<<LOCAL_RESULT_PATH>>` with zero loss and zero duplicates; `pnpm build`, typecheck and affected tests green on `<<SOURCE_SHA>>`; alerting configured to page the operator; clocks in UTC.
- Stop conditions: global stop rules; plus no worker claims for 10 minutes while due work exists.
- Rollback/recovery steps: stop the seeding job, scale workers to zero, cancel remaining executions through the cancel path, drop the synthetic schedules by sponsor, confirm the reconciliation check.
- Evidence to capture: per-execution due time, first-claim time, terminal time (query in the harness `collect`), outbox and queue backlog charts, worker count, DB CPU, connection count, the result JSON with machine shape (instance classes, region), the config revision, and the exact time window.
- Requested approval scope and expiry: Block A only, at `<<SOURCE_SHA>>`, expiring 7 days after the approval timestamp.
- Approver / approval reference / timestamp: `<<APPROVER>>` / `<<APPROVAL_REF>>` / `<<APPROVAL_TS>>`.

Accounting rules for the numbers:

- P02: UTC scheduled instant to first valid worker claim. Include cold starts and retries. Report dropped and cancelled separately.
- P03: at least 5,000 steps. Exclude intentional deny or cancel only with an explicit count. Provider-backed results are reported separately.
- P05: revocation commit time to the first authoritative deny or cancel. In-flight provider calls may already have happened; count them.

---

## Block B: worker termination (P04)

- Task and reason: OPS-04. Show that an expired lease is recovered within the target and that no effect is duplicated or silently lost.
- Exact project/environment/region: `<<PROJECT_ID>>` / `<<ENV>>` / `<<REGION>>`; service `<<WORKER_SERVICE>>`.
- Source SHA / image digest / schema/config versions: `<<SOURCE_SHA>>` / `<<IMAGE_DIGEST>>` / `<<SCHEMA_VERSION>>` / `<<CONFIG_REVISION>>`.
- Proposed commands or manual workflow and inputs: while Block A load runs, terminate at least 100 worker instances one at a time, spaced at least 3 minutes apart, alternating between instances that are mid-provider-write and instances between steps. Terminate by the platform's instance-delete or SIGKILL equivalent, not a graceful drain. Record each instance id and kill time. Command: `<<TERMINATE_COMMAND_FOR_WORKER_SERVICE>>`.
- IAM/OAuth scopes or external writes involved: permission to delete instances of `<<WORKER_SERVICE>>` in `<<ENV>>` only. External writes: test provider only.
- Expected cost and blast radius: loss of in-flight work on the killed instance; the lease and sweeper must recover it. Autoscaler replaces the instance. No other service is touched.
- Preconditions and local evidence: Block A running steady for at least 1 hour; local harness P04 section shows all injected deaths released (`<<LOCAL_RESULT_PATH>>`); sweeper is running at the approved cadence.
- Stop conditions: global stop rules; plus two consecutive deaths whose lease is not released 10 minutes after expiry.
- Rollback/recovery steps: stop terminating, confirm the autoscaler restored worker count, run the reconciliation check and resolve each uncertain effect by provider read-back before replay.
- Evidence to capture: for each death the attempt row of the killed claim (`execution_attempts.outcome = 'lease-expired'`, `ended_at`), the lease expiry time, the next attempt start, effect state before and after, provider write count per key.
- Requested approval scope and expiry: Block B only, 100 terminations, at `<<SOURCE_SHA>>`, expiring 7 days after the approval timestamp.
- Approver / approval reference / timestamp: `<<APPROVER>>` / `<<APPROVAL_REF>>` / `<<APPROVAL_TS>>`.

Recovery measurement (record exactly this):

- Recovery time = lease expiry time to the instant the attempt is closed as `lease-expired` and the execution is `queued` or `awaiting-reconciliation`. Also record death time to next attempt start. Report the worst of at least 100, not only the median.
- An execution parked in `awaiting-reconciliation` counts as recovered once released, and its reconciliation time is reported on its own line.

---

## Block C: provider outage simulation (P03)

- Task and reason: OPS-04. Show retry, quarantine and reconciliation behavior when the provider is down or loses acknowledgements.
- Exact project/environment/region: `<<PROJECT_ID>>` / `<<ENV>>` / `<<REGION>>`.
- Source SHA / image digest / schema/config versions: `<<SOURCE_SHA>>` / `<<IMAGE_DIGEST>>` / `<<SCHEMA_VERSION>>` / `<<CONFIG_REVISION>>`.
- Proposed commands or manual workflow and inputs: using the sandbox provider's fault switch `<<PROVIDER_FAULT_SWITCH>>`, run two windows during Block A load: 15 minutes returning 503 before applying the write, then 5 minutes applying the write and dropping the response. Do not block the real provider network path or edit firewall rules; the switch lives in the sandbox only.
- IAM/OAuth scopes or external writes involved: sandbox provider admin for the fault switch only. No network, firewall or IAM change.
- Expected cost and blast radius: executions in the window retry with backoff or park for reconciliation; none replay an unknown write. Sandbox only.
- Preconditions and local evidence: local harness shows `appliedButUnrecorded = 0` and zero duplicate remote writes through an `ack-lost` window (`<<LOCAL_RESULT_PATH>>`); the provider exposes a way to count writes per effect key.
- Stop conditions: global stop rules; plus any duplicate write per effect key.
- Rollback/recovery steps: switch the provider back to normal, wait for the queue to drain, run the reconciliation check, resolve remaining `uncertain` effects by provider read-back or manual resolution with evidence.
- Evidence to capture: outage window times, per-class counts (retried, quarantined, uncertain, reconciled-applied, reconciled-not-applied), terminal-success rate with the window and without it, time from outage end to queue drained.
- Requested approval scope and expiry: Block C only, two windows, at `<<SOURCE_SHA>>`, expiring 7 days after the approval timestamp.
- Approver / approval reference / timestamp: `<<APPROVER>>` / `<<APPROVAL_REF>>` / `<<APPROVAL_TS>>`.

---

## Block D: database failover and restore (P06)

- Task and reason: OPS-04. Measure RTO and RPO with the full definition, including service verification and reconciliation.
- Exact project/environment/region: `<<PROJECT_ID>>` / `<<ENV>>` / `<<REGION>>`; instance `<<DB_INSTANCE>>`.
- Source SHA / image digest / schema/config versions: `<<SOURCE_SHA>>` / `<<IMAGE_DIGEST>>` / `<<SCHEMA_VERSION>>` / `<<CONFIG_REVISION>>`.
- Proposed commands or manual workflow and inputs: two drills, each on `<<ENV>>` under moderate Block A load. Drill 1, high-availability failover: `<<FAILOVER_COMMAND>>`. Drill 2, point-in-time restore into a new instance named `<<RESTORE_TARGET_INSTANCE>>` at a recovery point `<<RECOVERY_POINT_TS>>`, then repoint `<<ENV>>` services to it. Offline rehearsal first: `node tools/restore-drill/run.mjs tools/restore-drill/fixtures/request.json` (see `docs/runbooks/dr-restore.md`).
- IAM/OAuth scopes or external writes involved: instance failover permission and backup restore permission on `<<DB_INSTANCE>>` only; creation of `<<RESTORE_TARGET_INSTANCE>>`; service configuration change to point at it. No access to any other instance.
- Expected cost and blast radius: write outage for the failover duration; a second instance for the restore for the drill duration; delete `<<RESTORE_TARGET_INSTANCE>>` only by the approver after the evidence is captured. Proposed cap: twice the metered cost of the environment for the window; the approver confirms or lowers it.
- Preconditions and local evidence: a successful offline restore rehearsal on the current revision; backups and PITR enabled with the retention in the approval; the external marker writer below is running; local DB crash and restart result shows loss 0 and recovery (`<<LOCAL_RESULT_PATH>>`).
- Stop conditions: global stop rules; plus the restore target cannot be verified within 2 hours.
- Rollback/recovery steps: repoint services to the original instance if it is healthy; otherwise stay on the restored instance and forward-repair. Never delete the original instance during the drill.
- Evidence to capture: the timeline below, dataset digest before and after, schema version after, the reconciliation check output, a post-recovery authorization test.
- Requested approval scope and expiry: Block D only, two drills, at `<<SOURCE_SHA>>`, expiring 7 days after the approval timestamp.
- Approver / approval reference / timestamp: `<<APPROVER>>` / `<<APPROVAL_REF>>` / `<<APPROVAL_TS>>`.

### Measurement definitions (P06)

- Marker writer: a small job outside the database inserts one row per second into a marker table
  in `<<ENV>>` and appends the marker id and its client-side commit-acknowledged time to its own
  log file. The table and the writer exist only in `<<ENV>>`.
- Dataset digest: `select md5(string_agg(execution_id || ':' || state, ',' order by execution_id)) from worker_executions;`
  captured just before injection.
- T0: the instant the failure is injected or declared. T_db: the database accepts connections.
  T_schema: schema version equals `<<SCHEMA_VERSION>>`. T_api: service health checks pass.
  T_e2e: one synthetic schedule fires and completes end to end. T_recon: the reconciliation check
  passes and every uncertain effect has a resolution. T_authz: a grant revoked before T0 is still denied.
- RTO = the latest of T_e2e, T_recon and T_authz, minus T0. DB startup alone is not recovery.
  Target 60 minutes or less.
- RPO = T0 minus the commit time of the last marker present after recovery. Any marker whose
  acknowledged commit is missing after recovery is data loss; count them and list the oldest missing.
  Target 15 minutes or less.

---

## After the campaign

1. Save the result JSON and logs under `docs/plans/enterprise-production-v1/ops-04/live/` (redacted) with the operator identity, timestamps and the revision.
2. Run `node scripts/ops-04/propose-thresholds.mjs <results-dir>`. The output is a proposal with `approved: false`. A named owner approves values; nothing else changes the targets.
3. Mark P01 to P07 in `docs/plans/enterprise-production-v1/ops-04/evidence.md` from LIVE evidence only. P07 needs a monthly observation window and cannot be closed by this campaign.
