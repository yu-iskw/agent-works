import { describe, expect, it } from 'vitest';

import { readMarkerTarget } from './read-marker.js';

import type { ConversationState } from './state.js';
import type { MessageView } from '@agent-works/domain/teamwork';

const msg = (id: string, role: MessageView['role']): MessageView => ({
  id,
  role,
  text: id,
  taskId: null,
  card: null,
  pending: false,
  at: '2026-10-30T00:00:00.000Z',
});

const conversation = (
  messages: readonly MessageView[],
  extra: Partial<ConversationState> = {},
): ConversationState => ({
  id: 'conv',
  teammateId: 't',
  messages,
  nextCursor: null,
  prevCursor: null,
  reply: 'none',
  tasks: [],
  follow: true,
  unseen: 0,
  ...extra,
});

describe('readMarkerTarget', () => {
  const replied = conversation([msg('m1', 'member'), msg('m2', 'teammate')]);

  it('marks the newest teammate message when the member is at the bottom of a visible tab', () => {
    expect(readMarkerTarget(replied, false, null)).toEqual({
      conversationId: 'conv',
      upToMessageId: 'm2',
    });
  });

  it('waits while the tab is hidden or the member is reading earlier content', () => {
    expect(readMarkerTarget(replied, true, null)).toBeNull();
    expect(
      readMarkerTarget(conversation(replied.messages, { follow: false }), false, null),
    ).toBeNull();
    expect(readMarkerTarget(conversation(replied.messages, { unseen: 1 }), false, null)).toBeNull();
  });

  it('does not post for the member’s own message, an empty conversation, or twice for one message', () => {
    expect(readMarkerTarget(conversation([msg('m1', 'member')]), false, null)).toBeNull();
    expect(readMarkerTarget(conversation([]), false, null)).toBeNull();
    expect(readMarkerTarget(null, false, null)).toBeNull();
    const posted = { conversationId: 'conv', upToMessageId: 'm2' };
    expect(readMarkerTarget(replied, false, posted)).toBeNull();
    const later = conversation([...replied.messages, msg('m3', 'system')]);
    expect(readMarkerTarget(later, false, posted)?.upToMessageId).toBe('m3');
  });
});
