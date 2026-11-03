-- SCH-04: agent-created routines bound to a standing grant (needs 0024). Additive and re-runnable.
-- A routine row is the binding between a schedule and the grant that authorised it. The schedule
-- itself lives in the scheduler store; routine_id is the schedule id.
create table if not exists tw_routines (
  routine_id text primary key,
  grant_id text not null references tw_standing_grants (grant_id),
  sponsor text not null,
  idempotency_key text not null,
  digest text not null,
  kind text not null check (kind in ('one_time', 'recurring')),
  scopes jsonb not null,
  state text not null check (state in ('active', 'cancelled')),
  cancel_reason text,
  created_at timestamptz not null,
  expires_at timestamptz not null,
  cancelled_at timestamptz,
  unique (grant_id, idempotency_key),
  check ((state = 'cancelled') = (cancelled_at is not null)),
  check (expires_at > created_at)
);
create index if not exists tw_routines_active on tw_routines (grant_id) where state = 'active';
