-- UI workspace: bounded lists, read markers, card anchors and teammate appearance.
-- Every statement is additive and re-runnable.

-- Work tab order and keyset cursor (updated_at desc, id desc) for one member's teamwork tasks.
create index if not exists wb_tasks_owner_updated on wb_tasks (kind, owner_sub, updated_at desc, id desc);
-- Results tab: newest revisions first, joined to owner-scoped tasks.
create index if not exists tw_revisions_recent on tw_revisions (created_at desc, task_id, revision);
-- Open-decision checks per task (Work "attention" filter, teammate rows).
create index if not exists tw_inbox_task_open on tw_inbox (task_id) where state = 'open';

-- Card anchors use `card:<taskId>:<ref>` as their client request id; member posts keep UUIDs.
alter table tw_messages alter column client_request_id type text;

-- Where the member has read to in a conversation. `last_read_at` is the created_at of that
-- message, so "after the marker" is a position in the conversation, not a wall-clock time.
create table if not exists tw_conversation_reads (
  owner_sub text not null,
  conversation_id uuid not null references tw_conversations (id),
  last_read_message_id uuid not null references tw_messages (id),
  last_read_at timestamptz not null,
  primary key (owner_sub, conversation_id)
);

-- Display identity, member-owned; closed sets are enforced by the domain schema, never
-- snapshotted into assignments, templates or the portable export.
alter table tw_teammates add column if not exists avatar text;
alter table tw_teammates add column if not exists accent text;
