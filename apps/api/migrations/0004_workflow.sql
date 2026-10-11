create table workflow_checkpoints (
  task_id text primary key,
  step_id text not null,
  status text not null
);

create table workflow_signals (
  task_id text not null,
  signal_id text not null,
  kind text not null,
  primary key (task_id, signal_id)
);

create table workflow_receipts (
  task_id text not null,
  step_id text not null,
  body text not null,
  seq bigint generated always as identity,
  primary key (task_id, step_id)
);

create table workflow_attempts (
  task_id text not null,
  step_id text not null,
  count integer not null,
  primary key (task_id, step_id)
);
