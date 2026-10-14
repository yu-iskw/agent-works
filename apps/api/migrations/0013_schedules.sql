-- Offline scheduler state. All service mutations serialize with advisory lock 7013.
create table schedules (
 id uuid primary key,
 sponsor_sub text not null,
 revision integer not null check (revision > 0),
 state text not null check (state in ('active','paused','revoked')),
 expires_at timestamptz not null,
 payload jsonb not null check (jsonb_typeof(payload) = 'object')
);
create index schedules_owner on schedules(sponsor_sub, id);
create index schedules_active_expiry on schedules(expires_at) where state = 'active';
create table event_triggers (
 id uuid primary key,
 schedule_id uuid not null unique references schedules(id),
 source text not null,
 signing_key_id text not null,
 payload jsonb not null check (jsonb_typeof(payload) = 'object')
);
create table schedule_runs (
 id text primary key check (id ~ '^[a-f0-9]{64}$'),
 schedule_id uuid not null references schedules(id),
 fire_at timestamptz not null,
 event_key text,
 status text not null check (status in ('dispatching','accepted','denied','cancelled','completed')),
 fence integer not null check (fence > 0),
 lease_until timestamptz not null,
 task_id text,
 payload jsonb not null check (jsonb_typeof(payload) = 'object'),
 check (status <> 'accepted' or task_id is not null)
);
create unique index schedule_run_slot on schedule_runs(schedule_id, fire_at) where event_key is null;
create unique index schedule_run_event on schedule_runs(event_key) where event_key is not null;
create index schedule_runs_pending on schedule_runs(lease_until) where status = 'dispatching';
create table received_events (
 key text primary key check (key ~ '^[a-f0-9]{64}$'),
 source text not null,
 source_event_id text not null,
 trigger_id uuid not null references event_triggers(id),
 run_id text not null unique references schedule_runs(id),
 trust text not null check (trust = 'untrusted'),
 payload jsonb not null check (jsonb_typeof(payload) = 'object'),
 unique(source, source_event_id)
);
create table schedule_audit (
 seq bigint generated always as identity primary key,
 id text not null unique,
 schedule_id uuid not null references schedules(id),
 payload jsonb not null check (jsonb_typeof(payload) = 'object')
);
create function reject_schedule_audit_rewrite() returns trigger language plpgsql as $$
begin
 raise exception 'schedule audit is append-only';
end;
$$;
create trigger schedule_audit_immutable before update or delete or truncate on schedule_audit
for each statement execute function reject_schedule_audit_rewrite();
