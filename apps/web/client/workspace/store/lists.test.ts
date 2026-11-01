import { describe, expect, it } from 'vitest';

import { DEFAULT_PREFERENCES } from '../../../shared/contract.js';
import { conversationRoute } from '../../../shared/route.js';

import { EMPTY_LISTS, listLoaded, resetList } from './lists.js';
import { initial, reduce } from './reducer.js';

import type { WorkspaceState } from './state.js';
import type { Bootstrap, TaskRow } from '../../../shared/contract.js';
import type { MemberTag } from '../../../shared/member-tag.js';

const T = '11111111-2222-4333-8444-555555555555';
const CONV = '33333333-2222-4333-8444-555555555555';

const task = (n: number): TaskRow => ({
  id: `${String(n).padStart(8, '0')}-2222-4333-8444-555555555555`,
  title: `ui-seed task ${n}`,
  workflow: 'research_brief',
  mode: 'manual',
  status: n % 2 === 0 ? 'running' : 'completed',
  version: 1,
  resultOwner: T,
  conversationId: CONV,
  latestRevision: 0,
  errorCode: null,
  errorMessage: null,
  createdAt: '2026-10-30T00:00:00.000Z',
  updatedAt: '2026-10-30T00:00:00.000Z',
});

const page = (from: number, count: number, nextCursor: string | null) => ({
  items: Array.from({ length: count }, (_, i) => task(from + i)),
  nextCursor,
});

const bootstrap: Bootstrap = {
  scope: { memberTag: '0123456789abcdef' as MemberTag, segment: 'alpha', csrf: 'c' },
  route: conversationRoute('alpha', T),
  me: {
    segment: 'alpha',
    segmentName: 'Alpha',
    segments: [{ id: 'alpha', name: 'Alpha' }],
    member: { email: 'alice@local.test', name: 'alice' },
    identity: 'local-test',
    sourceMode: 'fixture',
    model: { modelId: 'm', mode: 'vertex', state: 'ready', callsUsed: 0, callsLimit: 300 },
    readOnly: false,
    inboxOpen: 0,
  },
  prefs: DEFAULT_PREFERENCES,
  teammates: {
    segment: 'alpha',
    items: [
      {
        id: T,
        name: 'Haru',
        role: 'Research',
        conversationId: CONV,
        appearance: { avatar: null, accent: null },
        lastMessage: null,
        unread: true,
        working: false,
        needsAttention: false,
        unreadResult: true,
        updatedAt: '2026-10-30T00:00:00.000Z',
      },
    ],
    nextCursor: null,
  },
  conversation: {
    segment: 'alpha',
    id: CONV,
    teammateId: T,
    messages: [],
    nextCursor: null,
    prevCursor: null,
    reply: 'none',
    tasks: [],
  },
  notice: null,
  fallbackHref: '/s/alpha/teammates',
};

const start = (): WorkspaceState => initial(bootstrap, 'desktop', 0);

describe('list paging', () => {
  it('appends pages in order, drops rows it already holds, and adopts the newest cursor', () => {
    const first = listLoaded(EMPTY_LISTS.work, 1, page(1, 25, 'c1'), (row) => row.id);
    expect(first.items).toHaveLength(25);
    expect(first.nextCursor).toBe('c1');
    expect(first.status).toBe('ready');
    const second = listLoaded(first, 1, page(20, 25, null), (row) => row.id);
    expect(second.items).toHaveLength(44);
    expect(new Set(second.items.map((row) => row.id)).size).toBe(44);
    expect(second.items.map((row) => row.title).slice(0, 2)).toEqual([
      'ui-seed task 1',
      'ui-seed task 2',
    ]);
    expect(second.nextCursor).toBeNull();
  });

  it('ignores a page from before the query changed', () => {
    const loaded = listLoaded(EMPTY_LISTS.work, 1, page(1, 3, 'c1'), (row) => row.id);
    const reset = resetList(loaded);
    expect(reset.items).toEqual([]);
    expect(reset.generation).toBe(2);
    const stale = listLoaded(reset, 1, page(1, 3, 'c1'), (row) => row.id);
    expect(stale).toBe(reset);
    const fresh = listLoaded(reset, 2, page(50, 2, null), (row) => row.id);
    expect(fresh.items.map((row) => row.title)).toEqual(['ui-seed task 50', 'ui-seed task 51']);
  });

  it('keeps the selection across a filter change and only resets its own list', () => {
    let state = reduce(start(), { type: 'list/select', list: 'work', key: task(3).id });
    state = reduce(state, {
      type: 'list/loaded',
      list: 'work',
      generation: 1,
      page: page(1, 5, null),
    });
    state = reduce(state, {
      type: 'list/loaded',
      list: 'results',
      generation: 1,
      page: { items: [], nextCursor: null },
    });
    const resultsBefore = state.lists.results;
    state = reduce(state, { type: 'work/filter', filter: 'running' });
    expect(state.lists.work.items).toEqual([]);
    expect(state.lists.work.filter).toBe('running');
    expect(state.lists.work.selected).toBe(task(3).id);
    expect(state.lists.results).toBe(resultsBefore);
    expect(reduce(state, { type: 'work/filter', filter: 'running' })).toBe(state);
  });
});

describe('sidebar tabs', () => {
  it('switching tabs keeps the conversation, route and draft by reference', () => {
    const typed = reduce(start(), {
      type: 'draft/text',
      conversationId: CONV,
      text: 'keep me',
      mint: 'mint-1',
    });
    const { conversation, route, drafts } = typed;
    const onWork = reduce(typed, { type: 'sidebar/tab', tab: 'work' });
    const scrolled = reduce(onWork, { type: 'sidebar/scroll', tab: 'work', top: 240 });
    const back = reduce(scrolled, { type: 'sidebar/tab', tab: 'teammates' });
    for (const state of [onWork, scrolled, back]) {
      expect(state.conversation).toBe(conversation);
      expect(state.route).toBe(route);
      expect(state.drafts).toBe(drafts);
    }
    expect(back.sidebar.scroll.work).toBe(240);
    expect(reduce(back, { type: 'sidebar/tab', tab: 'work' }).sidebar.scroll.work).toBe(240);
  });
});

describe('read marker row update', () => {
  it('clears Unread and New result on the read conversation only, and is a no-op otherwise', () => {
    const state = start();
    const read = reduce(state, { type: 'sidebar/read', conversationId: CONV });
    expect(read.sidebar.teammates.items[0]).toMatchObject({ unread: false, unreadResult: false });
    expect(reduce(read, { type: 'sidebar/read', conversationId: CONV })).toBe(read);
    expect(reduce(state, { type: 'sidebar/read', conversationId: 'other' })).toBe(state);
  });
});
