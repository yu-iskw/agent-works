-- FND-03 verification of roles.sql + grants.sql. Read-only apart from rolled-back probes.
-- Run as a superuser after migrations and grants.sql. Any failed check raises an exception.

do $$
declare
  bad text;
begin
  -- 1. Application role has no DDL or ownership anywhere.
  if has_schema_privilege('aw_app', 'public', 'CREATE') then
    raise exception 'aw_app can create objects in public';
  end if;
  select string_agg(tablename, ', ') into bad from pg_tables
    where schemaname = 'public' and tableowner in ('aw_app', 'aw_readonly');
  if bad is not null then raise exception 'application roles own tables: %', bad; end if;

  -- 2. Every audit/history table is append-only for aw_app.
  select string_agg(c.relname, ', ') into bad from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind = 'r'
      and (c.relname ~ '(_audit|_audits|_history)$' or c.relname in ('audit_events', 'budget_events', 'task_transition_receipts'))
      and (has_table_privilege('aw_app', c.oid, 'UPDATE')
        or has_table_privilege('aw_app', c.oid, 'DELETE')
        or has_table_privilege('aw_app', c.oid, 'TRUNCATE'));
  if bad is not null then raise exception 'audit tables mutable by aw_app (add to grants.sql): %', bad; end if;

  -- 3. Positive control: app still reads and writes ordinary and audit tables.
  if not (has_table_privilege('aw_app', 'audit_events', 'INSERT')
      and has_table_privilege('aw_app', 'audit_events', 'SELECT')
      and has_table_privilege('aw_app', 'tasks', 'INSERT')
      and has_table_privilege('aw_app', 'tasks', 'UPDATE')) then
    raise exception 'aw_app lost required DML';
  end if;

  -- 4. Schema history is app-read-only; read-only role cannot write anything.
  if has_table_privilege('aw_app', 'schema_migrations', 'INSERT')
     or has_table_privilege('aw_app', 'schema_migrations', 'UPDATE') then
    raise exception 'aw_app can write schema_migrations';
  end if;
  select string_agg(c.relname, ', ') into bad from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind = 'r'
      and (has_table_privilege('aw_readonly', c.oid, 'INSERT')
        or has_table_privilege('aw_readonly', c.oid, 'UPDATE')
        or has_table_privilege('aw_readonly', c.oid, 'DELETE'));
  if bad is not null then raise exception 'aw_readonly can write: %', bad; end if;
end
$$;

-- Behavioral probes: actual statements under SET ROLE, rolled back.
begin;
set local role aw_app;
insert into audit_events (event_id, event_type, schema_version, occurred_at, task_id, step_id,
  trace_id, initiator_subject, agent_principal, outcome)
  values ('verify-1', 't', '1', now(), 't', 's', 'tr', 'u', 'a', 'ok');
do $$
begin
  begin
    update audit_events set outcome = 'tampered' where event_id = 'verify-1';
    raise exception 'UPDATE on audit_events unexpectedly succeeded';
  exception when insufficient_privilege then null;
  end;
  begin
    delete from audit_events where event_id = 'verify-1';
    raise exception 'DELETE on audit_events unexpectedly succeeded';
  exception when insufficient_privilege then null;
  end;
  begin
    execute 'create table aw_probe (id int)';
    raise exception 'DDL unexpectedly succeeded';
  exception when insufficient_privilege then null;
  end;
end
$$;
rollback;
select 'verify-roles: OK' as result;
