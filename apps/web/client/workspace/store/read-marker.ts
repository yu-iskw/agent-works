// When to tell the segment the member has read a conversation. Pure, so the timing rule is
// testable: only the newest non-member message counts, only while the member is at the bottom
// of the timeline with nothing unseen, only while the tab is visible, and never twice for the
// same message. Reading never resolves inbox items; the segment keeps those on task state.

import type { ConversationState } from './state.js';

export type ReadTarget = { readonly conversationId: string; readonly upToMessageId: string };

export function readMarkerTarget(
  conversation: ConversationState | null,
  hidden: boolean,
  lastPosted: ReadTarget | null,
): ReadTarget | null {
  if (conversation === null || hidden || !conversation.follow || conversation.unseen > 0)
    return null;
  const newest = conversation.messages.at(-1);
  if (newest === undefined || newest.role === 'member') return null;
  if (
    lastPosted !== null &&
    lastPosted.conversationId === conversation.id &&
    lastPosted.upToMessageId === newest.id
  )
    return null;
  return { conversationId: conversation.id, upToMessageId: newest.id };
}
