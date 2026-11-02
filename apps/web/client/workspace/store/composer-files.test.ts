import { describe, expect, it } from 'vitest';

import { DEFAULT_PREFERENCES } from '../../../shared/contract.js';
import { conversationRoute } from '../../../shared/route.js';

import { createFileEffects } from './composer-files.js';
import { initial } from './reducer.js';
import { draftOf } from './selectors.js';
import { createStore } from './store.js';

import type { EffectsDeps } from './effects.js';
import type { Bootstrap, ConversationPage } from '../../../shared/contract.js';
import type { MemberTag } from '../../../shared/member-tag.js';

const T = '11111111-2222-4333-8444-555555555555';
const T2 = '22222222-2222-4333-8444-555555555555';
const CONV = '33333333-2222-4333-8444-555555555555';
const CONV2 = '44444444-2222-4333-8444-555555555555';
const STORED = '55555555-2222-4333-8444-555555555555';

const page = (id: string, teammateId: string): ConversationPage => ({
  segment: 'alpha',
  id,
  teammateId,
  messages: [],
  nextCursor: null,
  prevCursor: null,
  reply: 'none',
  tasks: [],
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
    segments: [{ id: 'alpha', name: 'Alpha' }],
    member: { email: 'alice@local.test', name: 'alice' },
    identity: 'local-test',
    sourceMode: 'fixture',
    model: { modelId: 'm', mode: 'stub', state: 'ready', callsUsed: 0, callsLimit: 1 },
    readOnly: false,
    inboxOpen: 0,
  },
  prefs: DEFAULT_PREFERENCES,
  teammates: { segment: 'alpha', items: [row(T, CONV), row(T2, CONV2)], nextCursor: null },
  conversation: page(CONV, T),
  notice: null,
  fallbackHref: '/s/alpha',
};

describe('file uploads', () => {
  it('finishes an upload in the conversation it started in after the member switches away', async () => {
    const store = createStore(initial(bootstrap, 'desktop', 0));
    let finish: (value: unknown) => void = () => undefined;
    const posts: string[] = [];
    const api = {
      get: () => Promise.reject(new Error('unused')),
      post: (path: string) => {
        posts.push(path);
        if (path.endsWith('/remove')) return Promise.resolve({ segment: 'alpha' });
        return new Promise((resolve) => {
          finish = resolve;
        });
      },
    } as unknown as EffectsDeps['api'];
    const files = createFileEffects({
      deps: { store, api, mintId: () => 'local-1' } as unknown as EffectsDeps,
      readText: () => Promise.resolve('# notes'),
      addChip: (chip) =>
        store.dispatch({ type: 'draft/chip-add', conversationId: CONV, chip, mint: 'r1' }),
      fail: (reason) => {
        throw new Error(reason);
      },
    });

    files.attachFiles([new File(['# notes'], 'notes.md', { type: 'text/markdown' })]);
    await expect.poll(() => posts.length).toBe(1);
    store.dispatch({ type: 'route/changed', route: conversationRoute('alpha', T2) });
    store.dispatch({ type: 'conversation/loaded', epoch: 2, page: page(CONV2, T2) });
    expect(store.state.peek().conversation?.id).toBe(CONV2);
    finish({
      segment: 'alpha',
      attachment: {
        id: STORED,
        name: 'notes.md',
        mediaType: 'text/markdown',
        sizeBytes: 7,
        sha256: 'a'.repeat(64),
        createdAt: '2026-10-30T00:00:00.000Z',
        preview: '# notes',
        lines: 1,
        removedAt: null,
      },
    });

    await expect
      .poll(() => draftOf(store.state.peek(), CONV).chips[0])
      .toMatchObject({ kind: 'file', status: 'ready', attachmentId: STORED });
    expect(posts.some((p) => p.endsWith('/remove'))).toBe(false);
  });
});
