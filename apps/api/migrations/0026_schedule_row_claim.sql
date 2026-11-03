-- SCH-01 expand-only: indexed due claims and a single-writer cutover switch.
-- Adds objects only. schedule_runs and its unique indexes (0013) stay the duplicate backstop for both writers.
-- schedules.next_due is derived from the payload cursor and spec; payload.cursor stays authoritative.
alter table schedules add column next_due timestamptz;
create index schedules_next_due on schedules(next_due, id) where next_due is not null;
create table scheduler_owner (
 singleton boolean primary key default true check (singleton),
 owner text not null check (owner in ('legacy','rowclaim')),
 generation integer not null default 1 check (generation > 0),
 changed_at timestamptz not null default now()
);
insert into scheduler_owner(singleton, owner) values (true, 'legacy');
-- A write is allowed only when the writer protocol it declares is the active owner. Row-claim
-- transactions declare themselves with set_config('agentworks.scheduler_writer','rowclaim',true).
-- Anything else is the legacy global-lock store. FOR SHARE makes an owner flip wait for in-flight writers.
create function schedule_writer_guard() returns trigger language plpgsql as $$
declare
 active text;
 writer text;
begin
 select owner into active from scheduler_owner where singleton for share;
 writer := coalesce(nullif(current_setting('agentworks.scheduler_writer', true), ''), 'legacy');
 if active is distinct from writer then
  raise exception 'scheduler writer protocol % is not active (owner %)', writer, active using errcode = '55000';
 end if;
 return new;
end;
$$;
create trigger schedules_writer_guard before insert or update on schedules
for each row execute function schedule_writer_guard();
create trigger event_triggers_writer_guard before insert or update on event_triggers
for each row execute function schedule_writer_guard();
create trigger schedule_runs_writer_guard before insert or update on schedule_runs
for each row execute function schedule_writer_guard();
create trigger received_events_writer_guard before insert or update on received_events
for each row execute function schedule_writer_guard();
create trigger schedule_audit_writer_guard before insert on schedule_audit
for each row execute function schedule_writer_guard();
