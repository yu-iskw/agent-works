create table tasks (
  id text primary key,
  created_by_sub text not null,
  status text not null,
  objective_digest text not null,
  skill_version text not null,
  agent_version text not null,
  policy_version text not null,
  budget numeric not null,
  version integer not null check (version > 0),
  created_at timestamptz not null,
  updated_at timestamptz not null
);

create table task_claims (
  subject text not null,
  idempotency_key text not null,
  body_digest text not null,
  task_id text not null,
  primary key (subject, idempotency_key)
);

create table outbox_events (
  event_id text primary key,
  destination text not null,
  body_digest text not null,
  payload jsonb not null
);
