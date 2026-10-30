import { decodeCursor, encodeCursor } from '@agent-works/domain/teamwork';

import { attachmentRefsFor, resolveAttachments } from './attachments.js';
import { Conflict } from './context.js';
import { enqueue, postMessage } from './store.js';
import { summary } from './tasks.js';

import type { Deps, Member } from './context.js';
import type { TaskRow } from './store.js';
import type {
  AttachmentRef,
  ConversationPage,
  ConversationQuery,
  Cursor,
  LinkedTask,
  MessageView,
  ReadMarker,
  TaskSummary,
} from '@agent-works/domain/teamwork';
import type postgres from 'postgres';

type MessageRow = {
  id: string;
  role: MessageView['role'];
  body: string;
  task_id: string | null;
  card: MessageView['card'];
  reply_state: string | null;
  created_at: Date;
  attachment_ids: string[];
};

const messageView = (m: MessageRow, attachments: readonly AttachmentRef[]): MessageView => ({
  id: m.id,
  role: m.role,
  text: m.body,
  taskId: m.task_id,
  card: m.card,
  at: m.created_at.toISOString(),
  pending: m.reply_state === 'pending',
  attachments: [...attachments],
});

async function messageViews(db: postgres.Sql, rows: readonly MessageRow[]): Promise<MessageView[]> {
  const refs = await attachmentRefsFor(db, rows);
  return rows.map((row) => messageView(row, refs.get(row.id) ?? []));
}

const messageCursor = (m: MessageView): string => encodeCursor({ at: m.at, id: m.id });

export type ConversationView = {
  readonly id: string;
  readonly teammateId: string;
  readonly messages: readonly MessageView[];
  readonly pendingReply: boolean;
  readonly tasks: readonly TaskSummary[];
};

/**
 * The persistent conversation with one teammate: its own messages plus pointers (cards) to tasks
 * started from it. Task content stays in the task; the conversation only references it.
 */
export async function conversation(
  deps: Deps,
  member: Member,
  teammateId: string,
): Promise<ConversationView | undefined> {
  const found = (
    await deps.sql<{ id: string }[]>`
    select c.id from tw_conversations c join tw_teammates t on t.id = c.teammate_id
    where c.teammate_id = ${teammateId} and c.owner_sub = ${member.sub} and not t.archived
  `
  ).at(0);
  if (found === undefined) return undefined;
  const [messages, tasks] = await Promise.all([
    deps.sql<MessageRow[]>`
      select id, role, body, task_id, card, reply_state, created_at, attachment_ids from (
        select * from tw_messages where conversation_id = ${found.id} order by created_at desc limit 100
      ) recent order by created_at
    `,
    deps.sql<TaskRow[]>`
      select * from wb_tasks where kind = 'teamwork' and owner_sub = ${member.sub}
        and (conversation_id = ${found.id} or result_owner = ${teammateId}
          or id in (select task_id from tw_assignments where teammate_id = ${teammateId}))
      order by updated_at desc limit 20
    `,
  ]);
  return {
    id: found.id,
    teammateId,
    messages: await messageViews(deps.sql, messages),
    pendingReply: messages.some((m) => m.reply_state === 'pending'),
    tasks: tasks.map(summary),
  };
}

const REPLY_STATE = { queued: 'queued', running: 'generating' } as const;

function pageCursors(
  messages: readonly MessageView[],
  input: { readonly forward: boolean; readonly more: boolean; readonly after: string | undefined },
): Pick<ConversationPage, 'nextCursor' | 'prevCursor'> {
  const first = messages.at(0);
  const last = messages.at(-1);
  return {
    nextCursor: last === undefined ? (input.after ?? null) : messageCursor(last),
    prevCursor: !input.forward && input.more && first !== undefined ? messageCursor(first) : null,
  };
}

function cursorOf(raw: string | undefined): Cursor | undefined {
  if (raw === undefined) return undefined;
  const cursor = decodeCursor(raw);
  if (cursor === undefined) throw new Conflict('invalid_cursor', 400);
  return cursor;
}

/**
 * One page of a member's conversation by (created_at, id). No cursor: the newest `limit`
 * messages. `after`: the oldest `limit` messages past the cursor, for polling. `before`: the
 * newest `limit` messages before it, for scrolling back. Messages come back oldest first.
 */
export async function conversationPage(
  deps: Deps,
  member: Member,
  conversationId: string,
  query: ConversationQuery,
): Promise<ConversationPage | undefined> {
  const sql = deps.sql;
  const found = (
    await sql<{ id: string; teammate_id: string }[]>`
      select c.id, c.teammate_id from tw_conversations c join tw_teammates t on t.id = c.teammate_id
      where c.id = ${conversationId} and c.owner_sub = ${member.sub} and not t.archived
    `
  ).at(0);
  if (found === undefined) return undefined;
  const after = cursorOf(query.after);
  const before = cursorOf(query.before);
  const forward = after !== undefined;
  const [rows, jobs, tasks] = await Promise.all([
    sql<MessageRow[]>`
      select id, role, body, task_id, card, reply_state, created_at, attachment_ids from tw_messages
      where conversation_id = ${found.id}
      ${after === undefined ? sql`` : sql`and (created_at, id) > (${after.at}::timestamptz, ${after.id}::uuid)`}
      ${before === undefined ? sql`` : sql`and (created_at, id) < (${before.at}::timestamptz, ${before.id}::uuid)`}
      order by ${forward ? sql`created_at asc, id asc` : sql`created_at desc, id desc`}
      limit ${query.limit + 1}
    `,
    sql<{ state: 'queued' | 'running' }[]>`
      select j.state from tw_jobs j join tw_messages m on m.id::text = j.ref
      where j.kind = 'reply' and j.state in ('queued', 'running') and m.conversation_id = ${found.id}
      order by j.state = 'running' desc limit 1
    `,
    sql<{ id: string; version: number; status: LinkedTask['status']; title: string }[]>`
      select id, version, status, title from wb_tasks
      where kind = 'teamwork' and owner_sub = ${member.sub}
        and (conversation_id = ${found.id} or (conversation_id is null and result_owner = ${found.teammate_id}))
      order by updated_at desc, id desc limit 50
    `,
  ]);
  const held = await messageViews(sql, rows.slice(0, query.limit));
  const messages = forward ? held : held.reverse();
  const job = jobs.at(0);
  return {
    id: found.id,
    teammateId: found.teammate_id,
    messages,
    ...pageCursors(messages, { forward, more: rows.length > query.limit, after: query.after }),
    reply: job === undefined ? 'none' : REPLY_STATE[job.state],
    tasks: tasks.map((t) => ({ id: t.id, version: t.version, status: t.status, title: t.title })),
  };
}

/**
 * Moves the member's read marker forward to a message of this conversation; an older message
 * leaves it where it is. Reading changes nothing else: no inbox item resolves, no task moves.
 */
export async function markRead(
  deps: Deps,
  member: Member,
  conversationId: string,
  upToMessageId: string,
): Promise<ReadMarker> {
  // A data-modifying CTE is invisible to the outer select, so the fresh row comes from `returning`.
  const rows = await deps.sql<{ last_read_message_id: string; last_read_at: Date }[]>`
    with target as (
      select m.id, m.created_at from tw_messages m join tw_conversations c on c.id = m.conversation_id
      where m.id = ${upToMessageId} and m.conversation_id = ${conversationId} and c.owner_sub = ${member.sub}
    ), moved as (
      insert into tw_conversation_reads (owner_sub, conversation_id, last_read_message_id, last_read_at)
      select ${member.sub}, ${conversationId}, id, created_at from target
      on conflict (owner_sub, conversation_id) do update
        set last_read_message_id = excluded.last_read_message_id, last_read_at = excluded.last_read_at
        where (excluded.last_read_at, excluded.last_read_message_id)
          > (tw_conversation_reads.last_read_at, tw_conversation_reads.last_read_message_id)
      returning last_read_message_id, last_read_at
    )
    select last_read_message_id, last_read_at from moved
    union all
    select r.last_read_message_id, r.last_read_at from tw_conversation_reads r
    where r.owner_sub = ${member.sub} and r.conversation_id = ${conversationId}
      and exists (select 1 from target) and not exists (select 1 from moved)
  `;
  const marker = rows.at(0);
  if (marker === undefined) throw new Conflict('not_found', 404);
  return {
    lastReadMessageId: marker.last_read_message_id,
    lastReadAt: marker.last_read_at.toISOString(),
  };
}

export async function postToConversation(
  deps: Deps,
  member: Member,
  conversationId: string,
  input: {
    readonly clientRequestId: string;
    readonly text: string;
    readonly attachmentIds?: readonly string[];
  },
): Promise<void> {
  await deps.sql.begin(async (tx) => {
    const owned =
      await tx`select 1 from tw_conversations where id = ${conversationId} and owner_sub = ${member.sub}`;
    if (owned.length === 0) throw new Conflict('not_found', 404);
    const duplicate =
      await tx`select 1 from tw_messages where owner_sub = ${member.sub} and client_request_id = ${input.clientRequestId}`;
    if (duplicate.length > 0) return;
    const pending =
      await tx`select 1 from tw_messages where conversation_id = ${conversationId} and reply_state = 'pending'`;
    if (pending.length > 0) throw new Conflict('reply_pending');
    const files = await resolveAttachments(tx, member, conversationId, input.attachmentIds ?? []);
    const id = await postMessage(deps, tx, {
      conversationId,
      ownerSub: member.sub,
      role: 'member',
      body: input.text,
      clientRequestId: input.clientRequestId,
      replyState: 'pending',
      attachmentIds: files.map((file) => file.id),
    });
    await enqueue(deps, tx, null, 'reply', id);
  });
}
