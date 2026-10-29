import { Conflict } from './context.js';
import { enqueue, postMessage } from './store.js';
import { summary } from './tasks.js';

import type { Deps, Member } from './context.js';
import type { TaskRow } from './store.js';
import type { MessageView, TaskSummary } from '@agent-works/domain/teamwork';

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
    deps.sql<
      {
        id: string;
        role: MessageView['role'];
        body: string;
        task_id: string | null;
        card: MessageView['card'];
        reply_state: string | null;
        created_at: Date;
      }[]
    >`
      select id, role, body, task_id, card, reply_state, created_at from (
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
    messages: messages.map((m) => ({
      id: m.id,
      role: m.role,
      text: m.body,
      taskId: m.task_id,
      card: m.card,
      at: m.created_at.toISOString(),
      pending: m.reply_state === 'pending',
    })),
    pendingReply: messages.some((m) => m.reply_state === 'pending'),
    tasks: tasks.map(summary),
  };
}

export async function postToConversation(
  deps: Deps,
  member: Member,
  conversationId: string,
  input: { readonly clientRequestId: string; readonly text: string },
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
    const id = await postMessage(deps, tx, {
      conversationId,
      ownerSub: member.sub,
      role: 'member',
      body: input.text,
      clientRequestId: input.clientRequestId,
      replyState: 'pending',
    });
    await enqueue(deps, tx, null, 'reply', id);
  });
}
