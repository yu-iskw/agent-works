create table wb_tasks (
  id uuid primary key,
  owner_sub text not null,
  owner_email text,
  client_request_id uuid not null,
  title text not null,
  objective text not null,
  status text not null,
  version integer not null check (version > 0),
  llm_mode text not null check (llm_mode in ('vertex', 'stub')),
  model_id text not null,
  attempt integer not null default 1 check (attempt > 0),
  error_code text,
  error_message text,
  lease_until timestamptz,
  lease_token uuid,
  created_at timestamptz not null,
  updated_at timestamptz not null,
  unique (owner_sub, client_request_id),
  check (status in ('queued', 'running', 'waiting_approval', 'executing', 'completed', 'declined',
    'failed', 'cancel_requested', 'cancelled', 'outcome_uncertain'))
);
create index wb_tasks_owner on wb_tasks (owner_sub, created_at desc);
create index wb_tasks_work on wb_tasks (status, updated_at);

create table wb_events (
  task_id uuid not null references wb_tasks (id),
  seq integer not null check (seq > 0),
  type text not null,
  summary text not null,
  detail jsonb not null default '{}'::jsonb,
  duration_ms integer,
  at timestamptz not null,
  primary key (task_id, seq)
);

create table wb_evidence (
  id text not null,
  task_id uuid not null references wb_tasks (id),
  attempt integer not null,
  ordinal integer not null,
  source_id text not null,
  title text not null,
  excerpt text not null,
  url text,
  modified_at timestamptz not null,
  retrieved_at timestamptz not null,
  provenance text not null,
  primary key (task_id, attempt, id)
);

create table wb_artifacts (
  task_id uuid primary key references wb_tasks (id),
  report jsonb not null,
  model jsonb not null,
  dropped_citations integer not null,
  created_at timestamptz not null
);

create table wb_approvals (
  id uuid primary key,
  task_id uuid not null unique references wb_tasks (id),
  proposal jsonb not null,
  document jsonb not null,
  payload_sha256 text not null check (payload_sha256 ~ '^[a-f0-9]{64}$'),
  state text not null check (state in ('pending', 'approved', 'rejected', 'void')),
  requested_at timestamptz not null,
  expires_at timestamptz not null,
  decided_by text,
  decided_at timestamptz
);

create table wb_actions (
  task_id uuid primary key references wb_tasks (id),
  approval_id uuid not null unique references wb_approvals (id),
  idempotency_key text not null unique,
  status text not null check (status in ('intended', 'succeeded', 'failed', 'uncertain')),
  simulated boolean not null,
  attempts integer not null default 0,
  external_id text,
  external_url text,
  updated_at timestamptz not null
);

create table wb_model_calls (
  id bigserial primary key,
  task_id uuid references wb_tasks (id),
  mode text not null,
  model_id text not null,
  model_version text,
  response_id text,
  outcome text not null,
  -- False when the failure happened before any request left the process (no Vertex call spent).
  sent boolean not null default true,
  latency_ms integer,
  prompt_tokens integer,
  output_tokens integer,
  at timestamptz not null
);
create index wb_model_calls_budget on wb_model_calls (mode, sent);

-- Simulated Google Docs: the fixture adapter's external system of record. Never real Workspace.
create table wb_fixture_docs (
  idempotency_key text primary key,
  doc_id text not null unique,
  owner_sub text not null,
  title text not null,
  body jsonb not null,
  created_at timestamptz not null
);
