-- FND-03 PROPOSAL: least-privilege roles. Not a migration; never applied by application code.
-- Run by a human operator (or the serialized migration job) as cloudsqlsuperuser, once per database,
-- BEFORE the migration runner. Idempotent. Apply grants.sql AFTER migrations on every release.
--
-- Group roles are NOLOGIN. Cloud SQL IAM principals join them, for example:
--   GRANT aw_migrator TO "aw-migrator@PROJECT.iam";   -- migration job service account
--   GRANT aw_app      TO "aw-api@PROJECT.iam";        -- API / worker / dispatcher service account
--   GRANT aw_readonly TO "oncall@example.com";        -- human operator, read only
-- The segment database (O01 unresolved) is a separate instance or database: run these two files
-- against each database that holds migrated tables, with that database's own IAM principals.

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'aw_migrator') then
    create role aw_migrator nologin;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'aw_app') then
    create role aw_app nologin;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'aw_readonly') then
    create role aw_readonly nologin;
  end if;
end
$$;

-- The migrator owns every object it creates, so application roles never own tables
-- (an owner can drop the immutability triggers on audit tables).
grant create, usage on schema public to aw_migrator;
revoke create on schema public from public;
grant usage on schema public to aw_app, aw_readonly;

-- Objects created by aw_migrator from now on: DML for the app, read for operators.
-- grants.sql then removes UPDATE/DELETE/TRUNCATE from audit-history tables.
alter default privileges for role aw_migrator in schema public
  grant select, insert, update, delete on tables to aw_app;
alter default privileges for role aw_migrator in schema public
  grant select on tables to aw_readonly;
alter default privileges for role aw_migrator in schema public
  grant usage, select on sequences to aw_app;
alter default privileges for role aw_migrator in schema public
  grant select on sequences to aw_readonly;
