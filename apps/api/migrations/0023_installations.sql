-- Connector activation for this segment. The segment database is the workspace, so there is no
-- workspace column. Rows narrow the env allowlist and never widen it. Every statement is
-- additive and re-runnable.

create table if not exists tw_installations (
  item_kind text not null check (item_kind in ('connector')),
  item_id text not null,
  version text not null,
  previous_version text,
  -- The enabled subset; read and write capabilities are independent.
  capabilities jsonb not null,
  desired_state text not null check (desired_state in ('enabled', 'disabled')),
  observed_state text not null check (
    observed_state in ('pending', 'provisioning', 'healthy', 'failed', 'disabled', 'not_required')
  ),
  -- A safe code only, never a provider body.
  observed_detail text,
  -- Compare-and-swap token for admin writes and the reconciler.
  generation integer not null default 1,
  updated_by text not null,
  updated_at timestamptz not null,
  primary key (item_kind, item_id)
);
