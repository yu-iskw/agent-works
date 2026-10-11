create table approvals (
  id text primary key,
  task_id text not null,
  step_id text not null,
  tool text not null,
  target_resource text not null,
  payload_sha256 text not null,
  requested_by_sub text not null,
  approver_sub text,
  state text not null,
  expires_at timestamptz not null,
  max_executions integer not null,
  executions_used integer not null,
  check (state in ('pending', 'approved', 'rejected')),
  check (max_executions >= 1),
  check (executions_used >= 0 and executions_used <= max_executions),
  check (payload_sha256 ~ '^[a-f0-9]{64}$'),
  unique (task_id, step_id, payload_sha256)
);

create table tool_calls (
  id text primary key,
  task_id text not null,
  step_id text not null,
  tool_ref text not null,
  idempotency_key text not null unique,
  approval_id text not null references approvals (id),
  status text not null,
  external_receipt text,
  payload_sha256 text not null,
  policy_decision_id text not null,
  intended_at timestamptz not null,
  trace_id text not null,
  actor_sub text not null,
  check (status in ('INTENDED', 'COMPLETED')),
  check (payload_sha256 ~ '^[a-f0-9]{64}$')
);
