import { describe, expect, it } from 'vitest';

import { DEFAULT_PREFERENCES } from '../../../shared/contract.js';
import { conversationRoute } from '../../../shared/route.js';

import { initial, mergeMessages, reduce } from './reducer.js';

import type { WorkspaceState } from './state.js';
import type { Bootstrap, ConversationPage } from '../../../shared/contract.js';
import type { MemberTag } from '../../../shared/member-tag.js';
import type { MessageView } from '@agent-works/domain/teamwork';

const T = '11111111-2222-4333-8444-555555555555';
const T2 = '22222222-2222-4333-8444-555555555555';
const CONV = '33333333-2222-4333-8444-555555555555';
const CONV2 = '44444444-2222-4333-8444-555555555555';

const msg = (id: string, at: string, role: MessageView['role'] = 'teammate'): MessageView => ({
  id,
  role,
  text: `m${id}`,
  taskId: null,
  card: null,
  pending: false,
  at,
});

const page = (
  messages: readonly MessageView[],
  extra: Partial<ConversationPage> = {},
): ConversationPage => ({
  segment: 'alpha',
  id: CONV,
  teammateId: T,
  messages,
  nextCursor: null,
  prevCursor: null,
  reply: 'none',
  tasks: [],
  ...extra,
});

const row = (id: string, conversationId: string) => ({
  id,
  name: `tm-${id}`,
  role: 'Research',
  conversationId,
  appearance: { avatar: null, accent: null },
  lastMessage: null,
  unread: false,
  working: false,
  needsAttention: false,
  unreadResult: false,
  updatedAt: '2026-10-30T00:00:00.000Z',
});

const bootstrap: Bootstrap = {
  scope: { memberTag: '0123456789abcdef' as MemberTag, segment: 'alpha', csrf: 'c' },
  route: conversationRoute('alpha', T),
  me: {
    segment: 'alpha',
    segmentName: 'Alpha',
    segments: [],
    member: { email: 'a@b', name: 'a' },
    identity: 'local-test',
    sourceMode: 'fixture',
    model: { modelId: 'g', mode: 'vertex', state: 'ready', callsUsed: 0, callsLimit: 1 },
    readOnly: false,
    inboxOpen: 0,
  },
  prefs: DEFAULT_PREFERENCES,
  teammates: { segment: 'alpha', items: [row(T, CONV), row(T2, CONV2)], nextCursor: null },
  conversation: page([
    msg('a', '2026-10-30T10:00:00.000Z', 'member'),
    msg('b', '2026-10-30T10:01:00.000Z'),
  ]),
  notice: null,
  fallbackHref: '/x',
};

const start = () => initial(bootstrap, 'desktop', 1);
// CONV is a fixed literal key of a plain record.
// eslint-disable-next-line security/detect-object-injection
const draft = (state: WorkspaceState) => state.drafts[CONV];

describe('reducer', () => {
  it('ingests the bootstrap through the loaded paths', () => {
    const state = start();
    expect(state.conversation?.messages.map((m) => m.id)).toEqual(['a', 'b']);
    expect(state.sidebar.teammates.items).toHaveLength(2);
    expect(state.epoch).toBe(1);
  });

  it('returns the same state when a poll brings nothing new', () => {
    const state = start();
    const same = reduce(state, {
      type: 'conversation/appended',
      epoch: 1,
      page: page([msg('b', '2026-10-30T10:01:00.000Z')]),
    });
    expect(same).toBe(state);
  });

  it('keeps route, drafts, panel and sidebar scroll by reference across polls', () => {
    let state = start();
    state = reduce(state, {
      type: 'draft/text',
      conversationId: CONV,
      text: 'hello',
      mint: 'rid-1',
    });
    state = reduce(state, { type: 'sidebar/scroll', tab: 'teammates', top: 120 });
    const next = reduce(state, {
      type: 'conversation/appended',
      epoch: 1,
      page: page([msg('c', '2026-10-30T10:02:00.000Z')], { reply: 'generating' }),
    });
    expect(next).not.toBe(state);
    expect(next.route).toBe(state.route);
    expect(next.drafts).toBe(state.drafts);
    expect(next.panel).toBe(state.panel);
    expect(next.sidebar).toBe(state.sidebar);
    expect(next.sidebar.scroll).toBe(state.sidebar.scroll);
    expect(next.conversation?.reply).toBe('generating');
    expect(next.conversation?.messages.map((m) => m.id)).toEqual(['a', 'b', 'c']);
  });

  it('drops results from an older epoch and from another conversation', () => {
    const state = start();
    const stale = reduce(state, {
      type: 'conversation/appended',
      epoch: 0,
      page: page([msg('z', '2026-10-30T11:00:00.000Z')]),
    });
    expect(stale).toBe(state);
    const other = reduce(state, {
      type: 'conversation/appended',
      epoch: 1,
      page: page([msg('z', '2026-10-30T11:00:00.000Z')], { id: CONV2, teammateId: T2 }),
    });
    expect(other).toBe(state);
  });

  it('bumps the epoch and clears the conversation on a route to another teammate, keeping drafts', () => {
    let state = start();
    state = reduce(state, {
      type: 'draft/text',
      conversationId: CONV,
      text: 'keep me',
      mint: 'rid-1',
    });
    const next = reduce(state, { type: 'route/changed', route: conversationRoute('alpha', T2) });
    expect(next.epoch).toBe(2);
    expect(next.conversation).toBeNull();
    expect(next.drafts).toBe(state.drafts);
    const late = reduce(next, { type: 'conversation/loaded', epoch: 1, page: page([]) });
    expect(late).toBe(next);
    const panel = reduce(next, {
      type: 'route/changed',
      route: { ...next.route, panel: { kind: 'teammate' } },
    });
    expect(panel.epoch).toBe(2);
  });

  it('merges overlapping pages without duplicates and keeps time order', () => {
    const current = [msg('a', '2026-10-30T10:00:00.000Z'), msg('c', '2026-10-30T10:02:00.000Z')];
    const { messages, added } = mergeMessages(current, [
      msg('c', '2026-10-30T10:02:00.000Z'),
      msg('b', '2026-10-30T10:01:00.000Z'),
      msg('b', '2026-10-30T10:01:00.000Z'),
    ]);
    expect(added.map((m) => m.id)).toEqual(['b']);
    expect(messages.map((m) => m.id)).toEqual(['a', 'b', 'c']);
    expect(mergeMessages(current, current).messages).toBe(current);
  });

  it('counts unseen arrivals only while not following', () => {
    let state = start();
    state = reduce(state, { type: 'conversation/follow', follow: false });
    state = reduce(state, {
      type: 'conversation/appended',
      epoch: 1,
      page: page([
        msg('c', '2026-10-30T10:02:00.000Z'),
        msg('d', '2026-10-30T10:03:00.000Z', 'member'),
      ]),
    });
    expect(state.conversation?.unseen).toBe(1);
    state = reduce(state, { type: 'conversation/seen' });
    expect(state.conversation).toMatchObject({ unseen: 0, follow: true });
    const following = reduce(state, {
      type: 'conversation/appended',
      epoch: 1,
      page: page([msg('e', '2026-10-30T10:04:00.000Z')]),
    });
    expect(following.conversation?.unseen).toBe(0);
  });

  it('mints one clientRequestId per draft and reuses it across edits and failures', () => {
    let state = start();
    state = reduce(state, { type: 'draft/text', conversationId: CONV, text: 'h', mint: 'rid-1' });
    state = reduce(state, { type: 'draft/text', conversationId: CONV, text: 'he', mint: 'rid-2' });
    expect(draft(state)).toEqual({ text: 'he', clientRequestId: 'rid-1' });
    state = reduce(state, { type: 'composer/sending', clientRequestId: 'rid-1' });
    const second = reduce(state, { type: 'composer/sending', clientRequestId: 'rid-1' });
    expect(second).toBe(state);
    state = reduce(state, { type: 'composer/failed', reason: 'boom' });
    expect(state.composer).toEqual({ sending: null, error: 'boom' });
    expect(draft(state)).toEqual({ text: 'he', clientRequestId: 'rid-1' });
    state = reduce(state, { type: 'composer/sent', conversationId: CONV });
    expect(draft(state)).toBeUndefined();
    const fresh = reduce(state, {
      type: 'draft/text',
      conversationId: CONV,
      text: 'x',
      mint: 'rid-3',
    });
    expect(draft(fresh)).toEqual({ text: 'x', clientRequestId: 'rid-3' });
    const cleared = reduce(fresh, {
      type: 'draft/text',
      conversationId: CONV,
      text: '',
      mint: 'rid-4',
    });
    expect(draft(cleared)).toBeUndefined();
  });

  it('switches sidebar tabs without touching the route, conversation or drafts', () => {
    let state = start();
    state = reduce(state, {
      type: 'draft/text',
      conversationId: CONV,
      text: 'typing',
      mint: 'rid-1',
    });
    const next = reduce(state, { type: 'sidebar/tab', tab: 'work' });
    expect(next.sidebar.tab).toBe('work');
    expect(next.route).toBe(state.route);
    expect(next.conversation).toBe(state.conversation);
    expect(next.drafts).toBe(state.drafts);
  });

  it('clamps the panel width into the allowed range', () => {
    const state = start();
    expect(reduce(state, { type: 'panel/width', width: 10 }).panel.width).toBe(320);
    expect(reduce(state, { type: 'panel/width', width: 9999 }).panel.width).toBe(1600);
    expect(reduce(state, { type: 'panel/width', width: 480 })).toBe(state);
  });
});
