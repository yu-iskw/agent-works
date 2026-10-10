create table audit_events (
  event_id text primary key,
  event_type text not null,
  schema_version text not null,
  occurred_at timestamptz not null,
  task_id text not null,
  step_id text not null,
  trace_id text not null,
  initiator_subject text not null,
  agent_principal text not null,
  tool text,
  policy_decision_id text,
  approval_id text,
  request_digest_sha256 text check (request_digest_sha256 ~ '^[a-f0-9]{64}$'),
  outcome text not null,
  external_object_ref text,
  prev_digest text check (prev_digest ~ '^[a-f0-9]{64}$')
);
