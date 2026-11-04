-- SCH-06 admission. No limit, rate or dollar value is seeded: every cap is owner-set configuration.
-- A scope with no admission_limits row is not capped on that dimension.
create table admission_limits (
  scope_kind text not null check (scope_kind in ('member', 'bot', 'segment')),
  scope_id text not null check (scope_id <> ''),
  max_concurrent integer check (max_concurrent >= 0),
  max_share_bps integer check (max_share_bps between 1 and 10000),
  max_cost_micros bigint check (max_cost_micros >= 0),
  updated_at timestamptz not null default now(),
  primary key (scope_kind, scope_id),
  check (max_share_bps is null or (scope_kind = 'segment' and max_concurrent is not null))
);
-- Lock rows: admission serializes per scope by locking these in (kind, id) order.
create table admission_scopes (
  scope_kind text not null,
  scope_id text not null,
  primary key (scope_kind, scope_id)
);
create table admission_reservations (
  execution_id text primary key,
  member_id text not null,
  bot_id text not null,
  segment_id text not null,
  window_key text not null,
  state text not null check (state in ('active', 'succeeded', 'failed', 'cancelled', 'expired')),
  estimated_cost_micros bigint not null check (estimated_cost_micros >= 0),
  cost_micros bigint not null check (cost_micros >= 0),
  provider text,
  created_at timestamptz not null,
  expires_at timestamptz not null,
  finished_at timestamptz
);
create index admission_reservations_member on admission_reservations (member_id, segment_id) where state = 'active';
create index admission_reservations_bot on admission_reservations (bot_id) where state = 'active';
create index admission_reservations_segment on admission_reservations (segment_id) where state = 'active';
create index admission_reservations_expiry on admission_reservations (expires_at) where state = 'active';
create index admission_reservations_member_cost on admission_reservations (member_id, window_key);
create index admission_reservations_bot_cost on admission_reservations (bot_id, window_key);
create index admission_reservations_segment_cost on admission_reservations (segment_id, window_key);
create table admission_token_buckets (
  provider text primary key check (provider <> ''),
  capacity integer not null check (capacity > 0),
  refill_per_second double precision not null check (refill_per_second > 0),
  tokens double precision not null check (tokens >= 0),
  refilled_at timestamptz not null
);
