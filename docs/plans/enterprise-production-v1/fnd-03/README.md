# FND-03: Cloud SQL persistence and recovery proposal

Status: READY_FOR_REVIEW candidate, local evidence only. Nothing here was applied. Every number is an unapproved placeholder until the operator and business confirm it (D-08, D-10, O01).

## What this delivers

| Goal                     | Artifact                                                           | Check                                                                                                                                                |
| ------------------------ | ------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| Least-privilege DB roles | `roles.sql`, `grants.sql`                                          | `verify-roles.sh` runs all migrations plus both files on a disposable Postgres 16 and asserts the grants, with a rolled-back UPDATE/DELETE/DDL probe |
| Pool budget              | `pool-budget.json`, `scripts/db-pool-budget.mjs`                   | `scripts/db-pool-budget.test.mjs` (unit), `node scripts/db-pool-budget.mjs` (reports the real result)                                                |
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

Application roles never own tables, because an owner can drop the immutability triggers that migrations 0010, 0012, 0013, 0015 and 0016 install. No application code issues UPDATE or DELETE on the audit-history tables (grepped, non-test sources), so revoking them breaks no caller. `verify-roles.sql` fails the release when `aw_app` can still UPDATE, DELETE or TRUNCATE a table whose name ends in `_audit`, `_audits` or `_history`, that carries an `*_immutable` trigger, or that is in the fixed list. This caught `analytics_report_versions` (migration 0015), which the first hand-written list missed.

### Mutable by design, and undecided

`verify-roles.sql` also prints a NOTICE of event-like tables (`outbox|events|audit|history|ledger|receipts`, plus `tool_calls` and `approvals`) that `aw_app` can still UPDATE or DELETE. It does not fail on them. Current output:

| Table                                               | Decision                                                                                                                                                                                               |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `approvals`, `tool_calls`                           | Decided mutable. Application code UPDATEs both (`apps/api/src/broker/approvals.ts`) for state transitions. `aw_app` keeps UPDATE on them; their history is not tamper-proof against a compromised app. |
| `outbox_events`                                     | Decided mutable for now. Non-test code only INSERTs, but a dispatcher needs to mark delivery and no delivery column is revoked here. Revisit when the dispatcher lands; append-only is the target.     |
| `received_events`, `wb_events`, `workflow_receipts` | UNDECIDED. No non-test UPDATE or DELETE found. Candidates for the append-only list; owner of each module to confirm before revoking.                                                                   |

### Default-privileges window

`roles.sql` sets default privileges so new tables are readable and writable by `aw_app` as soon as `aw_migrator` creates them. Between a migration creating an audit table and `grants.sql` running, `aw_app` holds UPDATE and DELETE on it. The serialized job runs migrate, grants and verify before traffic shifts, which closes the window only if the job is the sole path. Any other path that migrates (including today's API self-migration) reopens it.

### Read-only role scope (open decision)

`aw_readonly` has SELECT on every table, including sensitive content: `tw_messages`, `user_memory_items`, `approvals.payload` and `oauth_connections.token_ref`. For human operators that is broader than the restore drill needs. Proposal for the owner to choose: scope `aw_readonly` to an allowlist of operational tables plus counts views, with a separate audited break-glass role for content. Until decided, treat `aw_readonly` membership as access to private content.

Dependency that blocks live use: the API opens the database through `openDatabase` and the per-module migration functions at startup, so today `aw_app` would need DDL. Applying these roles requires first moving that step into the serialized job below. That code change is outside FND-03's write set and is a follow-up for the owner of `apps/api/src/db.ts` and the module `migration.ts` files.

## Pool budget

Worst case demand is, per workload, max instances times pool size, summed, plus the migration reserve, the operator reserve, `superuser_reserved_connections` and a platform reserve for Cloud SQL's own agents. It must not exceed `max_connections`. `computePoolBudget` rejects zero, fractional and infinite inputs rather than counting them as zero demand.

Facts found in the repository: `postgres` clients default to 10 connections (read from the installed driver by `scripts/db-pool-budget.mjs`), `apps/api/src/db.ts` and `apps/web/app/m1/db.ts` set no `max`, and the Terraform modules set no Cloud Run max-instance limit. A real worksheet needs both set explicitly (`postgres(url, { max })` and the Cloud Run `max_instance_count`).

The committed worksheet's pool sizes (4, 3, 3) are placeholders that the code does not implement. `node scripts/db-pool-budget.mjs` reports both cases honestly. With the placeholder pool sizes demand is 75 of 100. With the real driver default of 10 and the same placeholder instance counts (8, 5, 4) demand is 170 + 16 = 186 of 100, which fails. The unit test checks the worksheet is well formed and pins the second result, so fixing `max` or the worksheet updates the test deliberately. Instance counts are also placeholders because Terraform sets none.

The proposed worksheet uses `maxConnections: 100`. That value is an assumption, not a verified Cloud SQL default for `db-custom-1-3840`. The operator must run `SHOW max_connections;` and replace it before the check means anything.

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

The existing module already enables `REGIONAL` availability and point-in-time recovery. FND-03 turns the availability type, backup window, backup count, WAL retention and `max_connections` into variables in `infra/terraform/modules/cloud_sql/variables.tf`, whose defaults leave the plan unchanged. Retention values need D-08.

Setting `max_connections` changes a database flag, and Cloud SQL restarts the instance to apply it (also stated in the variable description). Schedule it, do not apply it casually.

Acceptance P06 proposes RTO <= 60 min and RPO <= 15 min. These are provisional, not approved. HA failover protects against a zone outage, not data corruption or a bad deploy. Recovery from those needs a restore, which is tested separately (see the checklist). Cost of REGIONAL and longer retention is unestimated here.

## Terraform validation limits

The module pins `required_version >= 1.16.5, < 1.17.0`, but this workstation has Terraform 1.10.3, 1.10.0 and 1.12.0. `validate` and `test` were run against a scratch copy with only that constraint relaxed to `>= 1.10.0`, using the real `hashicorp/google` 8.5.0 provider and mock provider plans. The repository's own constraint was not exercised and CI on the pinned version remains the authority.
