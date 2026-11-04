create table if not exists tw_bots (
  teammate_id uuid primary key references tw_teammates (id),
  owner_sub text not null,
  active_revision integer,
  updated_at timestamptz not null
);
create table if not exists tw_bot_revisions (
  teammate_id uuid not null references tw_bots (teammate_id),
  revision integer not null check (revision > 0),
  definition jsonb not null,
  digest text not null check (digest ~ '^[a-f0-9]{64}$'),
  state text not null check (state in ('draft', 'published', 'superseded', 'discarded')),
  source text not null check (source in ('conversation', 'import', 'api')),
  source_message_id uuid,
  created_by text not null,
  created_at timestamptz not null,
  published_by text,
  published_at timestamptz,
  primary key (teammate_id, revision),
  unique (teammate_id, revision, digest),
  check ((state in ('published', 'superseded')) = (published_by is not null and published_at is not null))
);
create unique index if not exists tw_bot_one_draft on tw_bot_revisions (teammate_id) where state = 'draft';
create unique index if not exists tw_bot_one_published on tw_bot_revisions (teammate_id) where state = 'published';
alter table tw_bots drop constraint if exists tw_bots_active_revision_fkey;
alter table tw_bots add constraint tw_bots_active_revision_fkey
  foreign key (teammate_id, active_revision) references tw_bot_revisions (teammate_id, revision);

create or replace function tw_bot_revision_guard() returns trigger as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'bot revisions are never deleted';
  end if;
  if (to_jsonb(old) - 'state' - 'published_by' - 'published_at')
      is distinct from (to_jsonb(new) - 'state' - 'published_by' - 'published_at') then
    raise exception 'bot revision content is immutable';
  end if;
  if old.state = 'draft' and new.state in ('published', 'discarded') then
    return new;
  end if;
  if old.state = 'published' and new.state = 'superseded'
      and old.published_by is not distinct from new.published_by
      and old.published_at is not distinct from new.published_at then
    return new;
  end if;
  raise exception 'bot revision state is immutable after publication or discard';
end;
$$ language plpgsql;
drop trigger if exists tw_bot_revision_guard on tw_bot_revisions;
create trigger tw_bot_revision_guard before update or delete on tw_bot_revisions
  for each row execute function tw_bot_revision_guard();

alter table wb_tasks drop constraint if exists wb_tasks_kind_check;
alter table wb_tasks add constraint wb_tasks_kind_check check (kind in ('flagship', 'teamwork', 'bot'));
alter table wb_tasks drop constraint if exists wb_tasks_status_check;
alter table wb_tasks add constraint wb_tasks_status_check check (
  (kind = 'flagship' and status in ('queued', 'running', 'waiting_approval', 'executing',
    'completed', 'declined', 'failed', 'cancel_requested', 'cancelled', 'outcome_uncertain'))
  or (kind = 'teamwork' and status in ('planning', 'plan_review', 'running', 'needs_input',
    'synthesizing', 'ready', 'awaiting_action_approval', 'publishing', 'completed',
    'outcome_uncertain', 'failed', 'declined', 'cancel_requested', 'cancelled'))
  or (kind = 'bot' and status in ('queued', 'waiting_approval', 'running', 'waiting_external',
    'completed', 'failed', 'cancel_requested', 'cancelled', 'outcome_uncertain'))
);
alter table wb_tasks drop constraint if exists wb_tasks_teamwork_fields;
alter table wb_tasks add constraint wb_tasks_teamwork_fields check (
  kind <> 'teamwork' or (segment is not null and workflow is not null and mode is not null
    and result_owner is not null and scope is not null)
);

create table if not exists tw_bot_runs (
  task_id uuid primary key references wb_tasks (id),
  teammate_id uuid not null,
  revision integer not null,
  digest text not null,
  trigger_kind text not null check (trigger_kind in ('manual', 'schedule', 'event')),
  trigger_ref text,
  owner_sub text not null,
  initiated_by text not null,
  execution_sub text not null,
  approval_mode text not null check (approval_mode in ('per_run', 'standing_grant', 'checkpoints_only')),
  grant_id text,
  cost jsonb not null default '{"completeness":"unknown"}'::jsonb,
  created_at timestamptz not null,
  updated_at timestamptz not null,
  started_at timestamptz,
  finished_at timestamptz,
  foreign key (teammate_id, revision, digest) references tw_bot_revisions (teammate_id, revision, digest),
  unique (teammate_id, trigger_ref),
  check (execution_sub = owner_sub)
);
create or replace function tw_bot_run_pin_guard() returns trigger as $$
begin
  if (old.task_id, old.teammate_id, old.revision, old.digest, old.owner_sub, old.execution_sub,
      old.initiated_by, old.trigger_kind, old.trigger_ref, old.approval_mode, old.grant_id)
    is distinct from
     (new.task_id, new.teammate_id, new.revision, new.digest, new.owner_sub, new.execution_sub,
      new.initiated_by, new.trigger_kind, new.trigger_ref, new.approval_mode, new.grant_id) then
    raise exception 'bot run pin and authority are immutable';
  end if;
  return new;
end;
$$ language plpgsql;
drop trigger if exists tw_bot_run_pin_guard on tw_bot_runs;
create trigger tw_bot_run_pin_guard before update on tw_bot_runs
  for each row execute function tw_bot_run_pin_guard();
create table if not exists tw_bot_steps (
  task_id uuid not null references tw_bot_runs (task_id),
  step_id text not null check (step_id ~ '^[a-z][a-z0-9_]{0,31}$'),
  kind text not null check (kind in ('connector_read', 'skill', 'mcp_delegate', 'approval', 'result')),
  status text not null check (status in ('pending', 'ready', 'running', 'waiting_external',
    'waiting_approval', 'succeeded', 'failed', 'cancelled', 'outcome_uncertain', 'blocked')),
  depends_on jsonb not null default '[]'::jsonb,
  attempt integer not null default 0 check (attempt >= 0),
  owner_token uuid,
  input jsonb,
  output jsonb,
  idempotency_key text unique,
  external jsonb,
  error_code text,
  terminal_reason text,
  created_at timestamptz not null,
  updated_at timestamptz not null,
  started_at timestamptz,
  finished_at timestamptz,
  primary key (task_id, step_id),
  check (jsonb_typeof(depends_on) = 'array'),
  check (external is null or jsonb_typeof(external) = 'object')
);
create index if not exists tw_bot_steps_ready on tw_bot_steps (status, updated_at);
alter table tw_jobs drop constraint if exists tw_jobs_kind_check;
alter table tw_jobs add constraint tw_jobs_kind_check check (kind in ('plan', 'assignment', 'synthesis', 'publish', 'reply', 'bot_step'));
alter table wb_approvals add column if not exists step_id text;
alter table wb_approvals drop constraint if exists wb_approvals_subject_check;
alter table wb_approvals add constraint wb_approvals_subject_check check (subject in ('flagship_doc', 'publish', 'bot_run', 'bot_checkpoint'));
