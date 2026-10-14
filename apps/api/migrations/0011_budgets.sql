-- ISSUE 135: all limits, monetary amounts and retention are UNAPPROVED PLACEHOLDERS.
-- ADR 0003: default observe mode; this does not install a dev hard stop or billing control.
-- D-08: no retention expiry, deletion job, or SIEM destination is authorized.
create table budget_accounts (
  scope_key text primary key,
  scope_kind text not null check (scope_kind in ('task', 'user')),
  owner_subject text not null,
  sponsor text,
  window_key text not null,
  cost_micros bigint not null default 0 check (cost_micros >= 0),
  inference_steps bigint not null default 0 check (inference_steps >= 0),
  parallelism bigint not null default 0 check (parallelism >= 0)
);
create table budget_reservations (
  operation_id text primary key,
  fingerprint text not null,
  task_key text not null references budget_accounts(scope_key),
  user_key text not null references budget_accounts(scope_key),
  parallelism bigint not null check (parallelism >= 0),
  allowed boolean not null,
  released boolean not null default false,
  result jsonb not null
);
create table budget_events (
  event_id text primary key,
  operation_id text not null references budget_reservations(operation_id),
  payload jsonb not null,
  created_at timestamptz not null default now()
);
create index budget_events_operation on budget_events(operation_id);

-- Review queue only. No background worker or automatic write replay is installed.
create table reliability_dlq (
  entry_id text primary key,
  task_id text not null references tasks(id),
  idempotency_key text not null,
  subject text not null,
  risky_write boolean not null,
  state text not null check (state in ('review', 'requeue_pending', 'requeued', 'compensated')),
  version integer not null check (version > 0),
  payload jsonb not null,
  created_at timestamptz not null default now(),
  unique(task_id, idempotency_key)
);
create table reliability_dlq_decisions (
  decision_id text primary key,
  entry_id text not null references reliability_dlq(entry_id),
  payload jsonb not null,
  created_at timestamptz not null default now()
);
create index reliability_dlq_review on reliability_dlq(state, created_at, entry_id);
