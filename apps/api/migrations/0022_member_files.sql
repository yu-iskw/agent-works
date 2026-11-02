-- Member files: bounded text a member attaches in a conversation. A task reads them as
-- `member_file` evidence; a reply reads the ones sent with the message. Every statement is
-- additive and re-runnable.

create table if not exists tw_attachments (
  id uuid primary key,
  owner_sub text not null,
  conversation_id uuid not null references tw_conversations (id),
  name text not null,
  media_type text not null,
  size_bytes integer not null check (size_bytes > 0),
  sha256 text not null check (sha256 ~ '^[a-f0-9]{64}$'),
  text text not null,
  created_at timestamptz not null,
  -- Soft removal: a file a task or a sent message references stays readable as provenance.
  removed_at timestamptz
);
create index if not exists tw_attachments_owner_conversation
  on tw_attachments (owner_sub, conversation_id, created_at desc);

-- Which files a member message carried; the reply prompt reads exactly these.
alter table tw_messages add column if not exists attachment_ids jsonb not null default '[]'::jsonb;
