# FND-03: Cloud SQL persistence and recovery proposal

Status: READY_FOR_REVIEW candidate, local evidence only. Nothing here was applied. Every number is an unapproved placeholder until the operator and business confirm it (D-08, D-10, O01).

## What this delivers

| Goal                     | Artifact                                                           | Check                                                                                                                                                |
| ------------------------ | ------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| Least-privilege DB roles | `roles.sql`, `grants.sql`                                          | `verify-roles.sh` runs all migrations plus both files on a disposable Postgres 16 and asserts the grants, with a rolled-back UPDATE/DELETE/DDL probe |
| Pool budget              | `pool-budget.json`, `apps/api/src/db-pool-budget.ts`               | `db-pool-budget.test.ts` (unit, positive and negative)                                                                                               |
| Serialized migrations    | section below                                                      | Operator evidence item M1                                                                                                                            |
| HA, PITR, backups        | `infra/terraform/modules/cloud_sql` variables (defaults unchanged) | `terraform fmt`, `validate`, `test`                                                                                                                  |
| Restore checklist        | `docs/runbooks/dr-restore.md`, "Operator restore checklist"        | Live restore is AWAITING_OPERATOR                                                                                                                    |

## Database topology (O01 unresolved)

Nothing here merges, renames or moves a database. The Terraform module stays one instance per call, so a separate segment database is a second module call. `roles.sql` and `grants.sql` are run once per database with that database's own principals. The pool worksheet has one row per workload and must add a row for each workload that connects to each instance. Budget each instance on its own `maxConnections`.

## Least-privilege roles

| Role          | Login via                                | Can                                                                                                                             |
| ------------- | ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `aw_migrator` | migration job service account            | DDL, owns every table, writes `schema_migrations`                                                                               |
| `aw_app`      | API, worker, dispatcher service accounts | SELECT/INSERT/UPDATE/DELETE on tables; INSERT and SELECT only on audit-history tables; read-only on `schema_migrations`; no DDL |
| `aw_readonly` | human operators                          | SELECT only                                                                                                                     |

Application roles never own tables, because an owner can drop the immutability triggers that migrations 0010, 0012, 0013, 0015 and 0016 install. No application code issues UPDATE or DELETE on the audit-history tables (grepped, non-test sources), so revoking them breaks no caller. A new audit or history table whose name ends in `_audit`, `_audits` or `_history` fails `verify-roles.sql` until it is added to `grants.sql`.

Dependency that blocks live use: the API opens the database through `openDatabase` and the per-module migration functions at startup, so today `aw_app` would need DDL. Applying these roles requires first moving that step into the serialized job below. That code change is outside FND-03's write set and is a follow-up for the owner of `apps/api/src/db.ts` and the module `migration.ts` files.

## Pool budget

Worst case demand is, per workload, max instances times pool size, summed, plus the migration reserve, the operator reserve, `superuser_reserved_connections` and a platform reserve for Cloud SQL's own agents. It must not exceed `max_connections`. `computePoolBudget` rejects zero, fractional and infinite inputs rather than counting them as zero demand.

Facts found in the repository: `postgres` clients default to 10 connections and `apps/api/src/db.ts` and `apps/web/app/m1/db.ts` set no `max`; the Terraform modules set no Cloud Run max-instance limit. A real worksheet needs both set explicitly (`postgres(url, { max })` and the Cloud Run `max_instance_count`). Without them the budget cannot be proven, so the committed worksheet is a proposal.

The proposed worksheet uses `maxConnections: 100`. That value is an assumption, not a verified Cloud SQL default for `db-custom-1-3840`. The operator must run `SHOW max_connections;` and replace it before the check means anything. The module can then pin it with `max_connections = <n>`.

Cloud Run request concurrency may exceed the pool size; excess requests queue inside the client pool. Set explicit connect and statement timeouts at the same time as `max`. Never hold a transaction across a model or provider call.

## Serialized migration step

The unit of deployment is: migrate, grant, verify, then roll out new revisions.

1. A single-task Cloud Run Job (parallelism 1, task count 1, max retries 0) runs as the `aw_migrator` principal with a pool of at most `migrationReserve`.
2. It applies pending migrations in numeric order. Each migration module already takes a Postgres advisory transaction lock (7001, 7011, 7013, 7016, 7017 and others) and records its name in `schema_migrations`, so an accidental second runner blocks instead of racing. The job's own single-task setting is the first guard and the advisory lock the second.
3. It then runs `grants.sql` and `verify-roles.sql`. Failure stops the release before any new revision receives traffic.
4. Only after exit 0 does the deploy step shift traffic. A failed job leaves the old revision serving; old and new revisions must both work against the expanded schema (expand, then contract later, per the persistence contracts).
5. Applied migration files are never edited. Rollback of an incompatible schema is a forward repair migration; migration 0024 is reserved by the coordinator and not used here.

Operator evidence item M1: the job execution log showing one task, exit 0, the migration names applied, and `verify-roles: OK`.

## HA, PITR and backups

The existing module already enables `REGIONAL` availability and point-in-time recovery. FND-03 makes the proposal explicit and reviewable through variables whose defaults leave the plan unchanged:

| Variable                         | Default          | Proposal and open decision                                                 |
| -------------------------------- | ---------------- | -------------------------------------------------------------------------- |
| `availability_type`              | `REGIONAL`       | HA for zone failure. `ZONAL` is a cost override that needs an approved RTO |
| `transaction_log_retention_days` | 7                | Bounds PITR reach. Retention needs D-08                                    |
| `retained_backups`               | 7                | Count of automated backups. Needs D-08                                     |
| `backup_start_time`              | provider default | Pick a low-traffic window                                                  |
| `max_connections`                | tier default     | Set from the verified worksheet                                            |

Acceptance P06 proposes RTO <= 60 min and RPO <= 15 min. These are provisional, not approved. HA failover protects against a zone outage, not data corruption or a bad deploy. Recovery from those needs a restore, which is tested separately (see the checklist). Cost of REGIONAL and longer retention is unestimated here.

## Terraform validation limits

The module pins `required_version >= 1.16.5, < 1.17.0`, but this workstation has Terraform 1.10.3, 1.10.0 and 1.12.0. `validate` and `test` were run against a scratch copy with only that constraint relaxed to `>= 1.10.0`, using the real `hashicorp/google` 8.5.0 provider and mock provider plans. The repository's own constraint was not exercised and CI on the pinned version remains the authority.
