create table if not exists tw_bot_trigger_cursors (
  teammate_id uuid not null,
  revision integer not null,
  trigger_index integer not null check (trigger_index >= 0),
  cursor_at timestamptz not null,
  pending_at timestamptz,
  primary key (teammate_id, revision, trigger_index),
  foreign key (teammate_id, revision) references tw_bot_revisions (teammate_id, revision)
);
