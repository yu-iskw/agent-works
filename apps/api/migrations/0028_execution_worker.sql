-- SCH-05 expand: execution worker state. The database, never the queue message, owns execution progress.
-- fence is bumped on every lease claim; every commit is a compare-and-swap on (execution_id, fence, state='running').
create table worker_executions (
 execution_id text primary key references schedule_runs(id),
 state text not null check (state in ('queued','running','awaiting-reconciliation','succeeded','failed','denied','cancelled','quarantined')),
 fence bigint not null default 0 check (fence >= 0),
 lease_owner text check (lease_owner <> ''),
 lease_until timestamptz,
 attempts integer not null default 0 check (attempts >= 0),
 max_attempts integer not null check (max_attempts > 0),
 next_attempt_at timestamptz not null,
 deadline_at timestamptz not null,
 checkpoint_version integer not null default 0 check (checkpoint_version >= 0),
 checkpoint_ref text,
 result_digest text check (result_digest ~ '^[a-f0-9]{64}$'),
 last_error_class text check (last_error_class ~ '^[a-z0-9._-]{1,64}$'),
 quarantine_reason text check (quarantine_reason ~ '^[a-z0-9._-]{1,64}$'),
 created_at timestamptz not null,
 updated_at timestamptz not null,
 check ((lease_owner is null) = (lease_until is null)),
 check ((state = 'running') = (lease_owner is not null)),
 check ((state = 'quarantined') = (quarantine_reason is not null)),
 check ((state = 'succeeded') = (result_digest is not null))
);
create index worker_executions_due on worker_executions(next_attempt_at, execution_id) where state = 'queued';
create index worker_executions_lease on worker_executions(lease_until) where state = 'running';
-- Finished states never move again, so a stale writer that slips past a CAS still cannot rewrite history.
-- quarantined stays movable only for an explicit operator replay.
create function worker_executions_terminal_guard() returns trigger language plpgsql as $$
begin
 if old.state in ('succeeded','failed','denied','cancelled') then
  raise exception 'worker_executions row % is terminal (%)', old.execution_id, old.state using errcode = '55000';
 end if;
 return new;
end $$;
create trigger worker_executions_terminal before update on worker_executions
 for each row execute function worker_executions_terminal_guard();

create table execution_attempts (
 execution_id text not null references worker_executions(execution_id),
 attempt integer not null check (attempt > 0),
 fence bigint not null,
 owner text not null,
 started_at timestamptz not null,
 ended_at timestamptz,
 outcome text check (outcome in ('succeeded','retryable','permanent','denied','uncertain','lease-expired','cancelled')),
 error_class text check (error_class ~ '^[a-z0-9._-]{1,64}$'),
 primary key (execution_id, attempt),
 check ((ended_at is null) = (outcome is null))
);

-- One row per external write. The key, digest and target are fixed at first sight; a replay with a
-- different digest or target is refused. uncertain is never retried blindly: only reconciled releases it.
create table execution_effects (
 effect_key text primary key check (effect_key ~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$'),
 execution_id text not null references worker_executions(execution_id),
 payload_digest text not null check (payload_digest ~ '^[a-f0-9]{64}$'),
 provider_target text not null check (length(provider_target) between 1 and 512),
 state text not null check (state in ('pending','succeeded','uncertain','reconciled','failed')),
 writes integer not null default 1 check (writes > 0),
 resolution text check (resolution in ('applied','not-applied')),
 resolved_by text,
 evidence_ref text,
 result_ref text,
 created_at timestamptz not null,
 updated_at timestamptz not null,
 check ((state = 'reconciled') = (resolution is not null))
);
create index execution_effects_execution on execution_effects(execution_id);
create index execution_effects_uncertain on execution_effects(updated_at) where state = 'uncertain';

-- Permanently rejected deliveries (poison). Error class and caller subject only, never the body.
create table delivery_rejections (
 id bigint generated always as identity primary key,
 reason text not null check (reason ~ '^[a-z0-9._-]{1,64}$'),
 caller_sub text not null,
 recorded_at timestamptz not null default now()
);

-- Queue-loss recovery appends a new dispatch row for an execution whose earlier row is already published.
-- The 0027 index allowed one non-abandoned row ever; one pending row at a time keeps the no-double-publish intent.
drop index dispatch_outbox_live_execution;
create unique index dispatch_outbox_pending_execution on dispatch_outbox(execution_id) where state = 'pending';
