-- M1 teamwork. Extends the P0 workbench tables so there is one task history, one approval store
-- and one model-call ledger. Existing P0 rows keep their meaning through column defaults.

alter table wb_tasks
  add column kind text not null default 'flagship' check (kind in ('flagship', 'teamwork')),
  add column segment text,
  add column workflow text,
  add column mode text check (mode in ('manual', 'coordinated')),
  add column result_owner uuid,
  add column conversation_id uuid,
  add column scope jsonb,
  add column latest_revision integer not null default 0,
  -- Teamwork only: the member's pending revision request, and which stage a failure stopped.
  add column revision_request text,
  add column failed_stage text check (failed_stage in ('planning', 'synthesis', 'publish'));
alter table wb_tasks drop constraint wb_tasks_status_check;
alter table wb_tasks add constraint wb_tasks_status_check check (
  (kind = 'flagship' and status in ('queued', 'running', 'waiting_approval', 'executing',
    'completed', 'declined', 'failed', 'cancel_requested', 'cancelled', 'outcome_uncertain'))
  or (kind = 'teamwork' and status in ('planning', 'plan_review', 'running', 'needs_input',
    'synthesizing', 'ready', 'awaiting_action_approval', 'publishing', 'completed',
    'outcome_uncertain', 'failed', 'declined', 'cancel_requested', 'cancelled'))
);
alter table wb_tasks add constraint wb_tasks_teamwork_fields check (
  kind = 'flagship' or (segment is not null and workflow is not null and mode is not null
    and result_owner is not null and scope is not null)
);
create index wb_tasks_kind_owner on wb_tasks (kind, owner_sub, created_at desc);

alter table wb_approvals
  add column subject text not null default 'flagship_doc'
    check (subject in ('flagship_doc', 'publish')),
  add column subject_ref integer;
alter table wb_approvals drop constraint wb_approvals_task_id_key;
create unique index wb_approvals_flagship on wb_approvals (task_id) where subject = 'flagship_doc';
create index wb_approvals_task on wb_approvals (task_id, requested_at);

alter table wb_actions
  add column kind text not null default 'flagship_doc' check (kind in ('flagship_doc', 'publish')),
  add column confirmed_at timestamptz;
alter table wb_actions drop constraint wb_actions_pkey;
create unique index wb_actions_flagship on wb_actions (task_id) where kind = 'flagship_doc';

alter table wb_evidence
  add column assignment_id uuid,
  add column source_kind text,
  add column location text,
  add column source_revision text,
  add column stale boolean not null default false,
  alter column modified_at drop not null;

alter table wb_model_calls
  add column segment text,
  add column assignment_id uuid,
  add column purpose text;

-- Catalog: immutable versions; a private copy is a new skill or template owned by the member.
create table tw_skills (
  id uuid primary key,
  origin text not null check (origin in ('curated', 'private', 'imported')),
  owner_sub text,
  derived_from_id uuid,
  derived_from_version integer,
  created_at timestamptz not null,
  check ((origin = 'curated') = (owner_sub is null))
);
create table tw_skill_versions (
  skill_id uuid not null references tw_skills (id),
  version integer not null check (version > 0),
  definition jsonb not null,
  created_at timestamptz not null,
  primary key (skill_id, version)
);

create table tw_templates (
  id uuid primary key,
  origin text not null check (origin in ('curated', 'private', 'imported')),
  owner_sub text,
  created_at timestamptz not null,
  check ((origin = 'curated') = (owner_sub is null))
);
create table tw_template_versions (
  template_id uuid not null references tw_templates (id),
  version integer not null check (version > 0),
  definition jsonb not null,
  created_at timestamptz not null,
  primary key (template_id, version)
);

-- Curated seed bookkeeping: the content hash makes re-seeding idempotent and versioned.
create table tw_curated_keys (
  key text primary key,
  kind text not null check (kind in ('skill', 'template')),
  id uuid not null,
  content_sha256 text not null
);

create table tw_teammates (
  id uuid primary key,
  owner_sub text not null,
  client_request_id uuid not null,
  origin text not null check (origin in ('template', 'imported')),
  template_id uuid not null references tw_templates (id),
  template_version integer not null,
  name text not null,
  role text not null,
  instructions text not null,
  capability_requests jsonb not null,
  version integer not null check (version > 0),
  conversation_id uuid not null,
  archived boolean not null default false,
  created_at timestamptz not null,
  updated_at timestamptz not null,
  unique (owner_sub, client_request_id),
  foreign key (template_id, template_version) references tw_template_versions (template_id, version)
);
create index tw_teammates_owner on tw_teammates (owner_sub, created_at);

create table tw_teammate_skills (
  teammate_id uuid not null references tw_teammates (id),
  skill_id uuid not null,
  skill_version integer not null,
  attached_at timestamptz not null,
  primary key (teammate_id, skill_id),
  foreign key (skill_id, skill_version) references tw_skill_versions (skill_id, version)
);

create table tw_conversations (
  id uuid primary key,
  owner_sub text not null,
  teammate_id uuid not null,
  created_at timestamptz not null
);

create table tw_messages (
  id uuid primary key,
  conversation_id uuid not null references tw_conversations (id),
  owner_sub text not null,
  client_request_id uuid,
  role text not null check (role in ('member', 'teammate', 'system')),
  body text not null,
  task_id uuid references wb_tasks (id),
  card jsonb,
  reply_state text check (reply_state in ('pending', 'done', 'failed')),
  created_at timestamptz not null,
  unique (owner_sub, client_request_id)
);
create index tw_messages_conversation on tw_messages (conversation_id, created_at);
create index tw_messages_task on tw_messages (task_id, created_at);

create table tw_plans (
  task_id uuid not null references wb_tasks (id),
  version integer not null check (version > 0),
  author text not null check (author in ('coordinator', 'member')),
  content jsonb not null,
  capabilities jsonb not null,
  digest text not null check (digest ~ '^[a-f0-9]{64}$'),
  state text not null check (state in ('proposed', 'approved', 'rejected', 'superseded')),
  created_at timestamptz not null,
  decided_at timestamptz,
  decided_by text,
  primary key (task_id, version)
);
-- At most one live (proposed or approved) plan per task.
create unique index tw_plans_live on tw_plans (task_id) where state in ('proposed', 'approved');

create table tw_assignments (
  id uuid primary key,
  task_id uuid not null references wb_tasks (id),
  key text not null,
  teammate_id uuid not null references tw_teammates (id),
  -- Snapshot at dispatch: later edits to the teammate or skills never change active work.
  teammate_snapshot jsonb not null,
  skills jsonb not null,
  brief text not null,
  deliverable text not null,
  sources jsonb not null,
  capabilities jsonb not null,
  plan_version integer,
  status text not null check (status in ('queued', 'running', 'needs_input', 'succeeded',
    'failed', 'timed_out', 'cancelled', 'superseded')),
  attempt integer not null default 1 check (attempt > 0),
  question text,
  answer text,
  output jsonb,
  calculations jsonb not null default '[]'::jsonb,
  model jsonb,
  error_code text,
  error_message text,
  deadline_at timestamptz not null,
  started_at timestamptz,
  finished_at timestamptz,
  created_at timestamptz not null,
  updated_at timestamptz not null
);
create index tw_assignments_task on tw_assignments (task_id, created_at);

create table tw_revisions (
  task_id uuid not null references wb_tasks (id),
  revision integer not null check (revision > 0),
  parent integer,
  request text,
  content jsonb not null,
  evidence_ids jsonb not null,
  calculations jsonb not null,
  unsupported integer not null,
  dropped_citations integer not null,
  missing_assignments jsonb not null,
  generation jsonb not null,
  diff jsonb,
  digest text not null check (digest ~ '^[a-f0-9]{64}$'),
  created_at timestamptz not null,
  primary key (task_id, revision)
);

create table tw_inbox (
  id uuid primary key,
  owner_sub text not null,
  task_id uuid not null references wb_tasks (id),
  kind text not null check (kind in ('question', 'plan_review', 'approval', 'completed',
    'failed', 'uncertain')),
  ref text not null,
  summary text not null,
  state text not null check (state in ('open', 'resolved', 'dismissed')),
  created_at timestamptz not null,
  resolved_at timestamptz,
  unique (task_id, ref)
);
create index tw_inbox_owner on tw_inbox (owner_sub, state, created_at desc);

-- Durable work queue. A row is enqueued in the same transaction as the state change it serves,
-- so a crash between the two is impossible; leases make a crashed worker's job reclaimable.
create table tw_jobs (
  id bigserial primary key,
  -- Null only for conversation replies that are not about a task.
  task_id uuid references wb_tasks (id),
  kind text not null check (kind in ('plan', 'assignment', 'synthesis', 'publish', 'reply')),
  ref text not null,
  state text not null check (state in ('queued', 'running', 'done', 'cancelled')),
  attempts integer not null default 0,
  lease_until timestamptz,
  lease_token uuid,
  created_at timestamptz not null,
  updated_at timestamptz not null
);
create unique index tw_jobs_live on tw_jobs (kind, ref) where state in ('queued', 'running');
create index tw_jobs_claim on tw_jobs (state, created_at);

-- Per-segment delegated connections. Tokens are AES-256-GCM sealed with this segment's key.
create table tw_connections (
  owner_sub text not null,
  provider text not null check (provider in ('google', 'github')),
  account text not null,
  scopes jsonb not null,
  sealed_access text not null,
  sealed_refresh text,
  access_expires_at timestamptz,
  status text not null check (status in ('active', 'revoked', 'error')),
  error_code text,
  connected_at timestamptz not null,
  updated_at timestamptz not null,
  primary key (owner_sub, provider)
);

create table tw_oauth_states (
  state text primary key,
  owner_sub text not null,
  provider text not null,
  code_verifier text not null,
  expires_at timestamptz not null,
  used_at timestamptz
);

create table tw_audit (
  id bigserial primary key,
  at timestamptz not null,
  owner_sub text,
  task_id uuid,
  assignment_id uuid,
  action text not null,
  outcome text not null,
  detail jsonb not null default '{}'::jsonb
);
create index tw_audit_task on tw_audit (task_id, at);
