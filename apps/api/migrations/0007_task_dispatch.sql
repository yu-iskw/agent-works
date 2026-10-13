create table task_deliveries (
  task_id text primary key references tasks (id),
  payload jsonb not null,
  available_at timestamptz not null,
  attempt integer not null check (attempt >= 0),
  worker_id text,
  lease_until timestamptz,
  fencing_token integer not null check (fencing_token >= 0),
  constraint task_deliveries_lease_pair check (
    (worker_id is null and lease_until is null)
    or (worker_id is not null and lease_until is not null)
  )
);

create index task_deliveries_claim on task_deliveries (available_at, task_id);

create table task_transition_receipts (
  task_id text not null references tasks (id),
  version integer not null check (version > 0),
  ref text not null,
  digest text not null,
  primary key (task_id, version)
);
