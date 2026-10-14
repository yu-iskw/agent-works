-- Immutable control-plane revisions. A resume is a new row, never a delete.
create table suspension_states (
  target_key text not null check (target_key ~ '^[a-f0-9]{64}$'),
  revision integer not null check (revision > 0),
  command_id uuid not null unique,
  payload jsonb not null check (jsonb_typeof(payload) = 'object'),
  primary key (target_key, revision)
);
create table capability_version_states (
  pin_key text not null check (pin_key ~ '^[a-f0-9]{64}$'),
  revision integer not null check (revision > 0),
  command_id uuid not null unique,
  payload jsonb not null check (jsonb_typeof(payload) = 'object'),
  primary key (pin_key, revision)
);
create table suspension_history (
  sequence bigint generated always as identity primary key,
  event_id text not null unique,
  command_digest text check (command_digest ~ '^[a-f0-9]{64}$'),
  payload jsonb not null check (jsonb_typeof(payload) = 'object'),
  result jsonb,
  constraint suspension_history_command_pair check (
    (command_digest is null and result is null) or
    (command_digest is not null and result is not null)
  )
);
create index suspension_history_actor on suspension_history ((payload->>'actorSub'), sequence);
create index suspension_history_task on suspension_history ((payload->>'taskId'), sequence)
  where payload->>'taskId' is not null;

create function reject_suspension_rewrite() returns trigger language plpgsql as $$
begin
  raise exception 'suspension ledger is append-only' using errcode = '55000';
end;
$$;
create trigger suspension_states_immutable before update or delete or truncate on suspension_states
  for each statement execute function reject_suspension_rewrite();
create trigger capability_version_states_immutable before update or delete or truncate on capability_version_states
  for each statement execute function reject_suspension_rewrite();
create trigger suspension_history_immutable before update or delete or truncate on suspension_history
  for each statement execute function reject_suspension_rewrite();
