-- SCH-02 expand-only: transactional dispatch outbox. Adds objects only; nothing existing is altered.
-- Written in the claim transaction beside schedule_runs, published outside it. Duplicate publish is expected.
-- fence is bumped on every lease claim; completion is a compare-and-swap on (dispatch_id, fence, state='pending').
create table dispatch_outbox (
 dispatch_id text primary key check (dispatch_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'),
 execution_id text not null check (execution_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'),
 target_kind text not null check (target_kind in ('cloud-tasks-http')),
 transport_name text not null unique check (transport_name ~ '^d-[a-f0-9]{64}$'),
 envelope jsonb not null,
 state text not null default 'pending' check (state in ('pending','published','abandoned')),
 attempts integer not null default 0 check (attempts >= 0),
 next_attempt_at timestamptz not null,
 lease_owner text check (lease_owner <> ''),
 lease_until timestamptz,
 fence bigint not null default 0 check (fence >= 0),
 last_error_class text check (length(last_error_class) between 1 and 64),
 created_at timestamptz not null,
 published_at timestamptz,
 check ((lease_owner is null) = (lease_until is null)),
 check ((state = 'published') = (published_at is not null)),
 check (state = 'pending' or lease_owner is null)
);
-- One live dispatch chain per occurrence. An abandoned chain may be replayed under a new dispatch id.
create unique index dispatch_outbox_live_execution on dispatch_outbox(execution_id) where state <> 'abandoned';
create index dispatch_outbox_due on dispatch_outbox(next_attempt_at, dispatch_id) where state = 'pending';
-- published and abandoned are terminal. No writer, stale or not, may move a row out of them.
create function dispatch_outbox_terminal_guard() returns trigger language plpgsql as $$
begin
 if old.state <> 'pending' then
  raise exception 'dispatch_outbox row % is terminal (%)', old.dispatch_id, old.state using errcode = '55000';
 end if;
 return new;
end $$;
create trigger dispatch_outbox_terminal before update on dispatch_outbox
 for each row execute function dispatch_outbox_terminal_guard();
