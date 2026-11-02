-- FND-03 PROPOSAL: post-migration grants. Run after every migration, as the owner (aw_migrator) or
-- cloudsqlsuperuser. Idempotent. Pairs with roles.sql.
--
-- Audit-history tables are append-only for the application: INSERT and SELECT only.
-- A table whose name ends in _audit, _audits or _history, or is listed here, must appear in this
-- list; verify-roles.sql fails the release if one is missing.

do $$
declare
  t text;
  audit_tables text[] := array[
    'audit_events', 'governance_audit', 'schedule_audit', 'tw_audit',
    'user_memory_audit', 'analytics_query_audit', 'delegation_audits',
    'model_routing_audits', 'suspension_history', 'user_memory_history',
    'budget_events', 'task_transition_receipts'
  ];
begin
  -- Cover tables created before the default privileges existed (restores, first rollout).
  execute 'grant select, insert, update, delete on all tables in schema public to aw_app';
  execute 'grant usage, select on all sequences in schema public to aw_app';
  execute 'grant select on all tables in schema public to aw_readonly';
  execute 'grant select on all sequences in schema public to aw_readonly';

  foreach t in array audit_tables loop
    if to_regclass('public.' || t) is not null then
      execute format('revoke update, delete, truncate, references, trigger on public.%I from aw_app', t);
    end if;
  end loop;
end
$$;

-- Schema history is not application-writable: DDL tracking belongs to the migration job.
revoke update, delete, truncate on schema_migrations from aw_app;
-- The app still reads it to detect drift; and cannot insert, so it cannot mark a migration applied.
revoke insert on schema_migrations from aw_app;
