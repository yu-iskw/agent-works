import { describe, expect, it } from 'vitest';

import { DEFAULT_PREFERENCES } from '../../../shared/contract.js';
import { conversationRoute } from '../../../shared/route.js';

import { initial, reduce } from './reducer.js';
import { activeDraft } from './selectors.js';

import type { WorkspaceState } from './state.js';
import type { ContextChip, FileChip, TaskDraft } from '../../../shared/composer.js';
import type { Bootstrap, ConversationPage } from '../../../shared/contract.js';
import type { MemberTag } from '../../../shared/member-tag.js';

const T = '11111111-2222-4333-8444-555555555555';
const T2 = '22222222-2222-4333-8444-555555555555';
const CONV = '33333333-2222-4333-8444-555555555555';
const CONV2 = '44444444-2222-4333-8444-555555555555';

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

const start = (): WorkspaceState => initial(bootstrap, 'desktop', 0);

const teammateChip: ContextChip = { kind: 'teammate', id: T2, name: 'Mika', role: 'Metrics' };
const fileChip: FileChip = {
  kind: 'file',
  localId: 'f1',
  name: 'notes.md',
  mediaType: 'text/markdown',
  sizeBytes: 12,
  status: 'uploading',
  attachmentId: null,
  error: null,
  preview: null,
  lines: null,
  sha256: null,
};

describe('chips', () => {
  it('adds a chip once, mints the request id, and keeps the chip when text is cleared', () => {
    let state = reduce(start(), {
      type: 'draft/chip-add',
      conversationId: CONV,
      chip: teammateChip,
      mint: 'r1',
    });
    const again = reduce(state, {
      type: 'draft/chip-add',
      conversationId: CONV,
      chip: teammateChip,
      mint: 'r2',
    });
    expect(again).toBe(state);
    expect(activeDraft(state)).toMatchObject({
      text: '',
      clientRequestId: 'r1',
      chips: [teammateChip],
    });
    state = reduce(state, { type: 'draft/text', conversationId: CONV, text: 'hi', mint: 'r3' });
    state = reduce(state, { type: 'draft/text', conversationId: CONV, text: '', mint: 'r4' });
    expect(activeDraft(state)).toMatchObject({
      text: '',
      clientRequestId: 'r1',
      chips: [teammateChip],
    });
  });

  it('drops the draft when the last chip of an empty draft is removed', () => {
    let state = reduce(start(), {
      type: 'draft/chip-add',
      conversationId: CONV,
      chip: teammateChip,
      mint: 'r1',
    });
    state = reduce(state, {
      type: 'draft/chip-remove',
      conversationId: CONV,
      key: `teammate:${T2}`,
    });
    expect(CONV in state.drafts).toBe(false);
    expect(
      reduce(state, { type: 'draft/chip-remove', conversationId: CONV, key: 'teammate:none' }),
    ).toBe(state);
  });

  it('moves a file chip through uploading, failed and ready', () => {
    let state = reduce(start(), {
      type: 'draft/chip-add',
      conversationId: CONV,
      chip: fileChip,
      mint: 'r1',
    });
    state = reduce(state, {
      type: 'draft/file',
      conversationId: CONV,
      localId: 'f1',
      patch: { status: 'failed', error: 'nope' },
    });
    expect(activeDraft(state).chips[0]).toMatchObject({ status: 'failed', error: 'nope' });
    state = reduce(state, {
      type: 'draft/file',
      conversationId: CONV,
      localId: 'f1',
      patch: { status: 'ready', attachmentId: 'a1', error: null, preview: 'first line', lines: 3 },
    });
    expect(activeDraft(state).chips[0]).toMatchObject({
      status: 'ready',
      attachmentId: 'a1',
      lines: 3,
    });
    expect(
      reduce(state, {
        type: 'draft/file',
        conversationId: CONV,
        localId: 'zz',
        patch: { status: 'ready' },
      }),
    ).toBe(state);
  });

  it('keeps chips per conversation and restores a saved draft only when none is in memory', () => {
    let state = reduce(start(), {
      type: 'draft/chip-add',
      conversationId: CONV,
      chip: teammateChip,
      mint: 'r1',
    });
    state = reduce(state, {
      type: 'draft/chip-add',
      conversationId: CONV2,
      chip: fileChip,
      mint: 'r2',
    });
    expect(state.drafts).toMatchObject({
      [CONV]: { chips: [teammateChip] },
      [CONV2]: { chips: [fileChip] },
    });
    const saved = { text: 'saved', clientRequestId: 'r9', chips: [], target: null };
    expect(reduce(state, { type: 'draft/restored', conversationId: CONV, draft: saved })).toBe(
      state,
    );
    const fresh = reduce(start(), { type: 'draft/restored', conversationId: CONV, draft: saved });
    expect(activeDraft(fresh)).toEqual(saved);
  });

  it('records an explicit target and clears it back to the default', () => {
    const revise = { kind: 'revise' as const, taskId: 'task-1', revision: 2, title: 'Tools' };
    let state = reduce(start(), { type: 'draft/target', conversationId: CONV, target: revise });
    expect(activeDraft(state).target).toEqual(revise);
    state = reduce(state, { type: 'draft/target', conversationId: CONV, target: null });
    expect(CONV in state.drafts).toBe(false);
  });
});

describe('composer slice', () => {
  const draft: TaskDraft = {
    clientRequestId: 'r1',
    conversationId: CONV,
    objective: 'Compare tools',
    workflow: 'research_brief',
    mode: 'manual',
    resultOwnerId: T,
    specialists: [],
    attachments: [],
    repository: null,
    issueNumber: null,
    metrics: null,
    expanded: false,
  };

  it('opens, edits, and clears the task draft together with the conversation draft on start', () => {
    let state = reduce(start(), {
      type: 'draft/text',
      conversationId: CONV,
      text: 'Compare tools',
      mint: 'r1',
    });
    state = reduce(state, { type: 'task-draft/open', draft });
    state = reduce(state, { type: 'task-draft/edit', patch: { mode: 'coordinated' } });
    expect(state.composer.taskDraft?.mode).toBe('coordinated');
    state = reduce(state, { type: 'task-draft/starting', starting: true });
    state = reduce(state, { type: 'task-draft/started', conversationId: CONV });
    expect(state.composer).toMatchObject({ taskDraft: null, starting: false });
    expect(CONV in state.drafts).toBe(false);
  });

  it('keeps the menu context across a conversation change but drops the draft card and targets', () => {
    const context = {
      segment: 'alpha',
      teammates: [],
      skills: [],
      sources: [],
      repositories: [],
      issue: null,
    };
    let state = reduce(start(), { type: 'composer/context', context });
    state = reduce(state, { type: 'task-draft/open', draft });
    state = reduce(state, {
      type: 'composer/targets',
      epoch: state.epoch,
      conversationId: CONV,
      targets: [],
      key: 'k1',
    });
    expect(state.composer.targetsKey).toBe('k1');
    state = reduce(state, { type: 'route/changed', route: conversationRoute('alpha', T2) });
    expect(state.composer).toMatchObject({ context, taskDraft: null, targetsKey: '', error: null });
  });

  it('ignores targets for another conversation or an older epoch', () => {
    const state = start();
    expect(
      reduce(state, {
        type: 'composer/targets',
        epoch: state.epoch,
        conversationId: CONV2,
        targets: [],
        key: 'x',
      }),
    ).toBe(state);
    expect(
      reduce(state, {
        type: 'composer/targets',
        epoch: state.epoch - 1,
        conversationId: CONV,
        targets: [],
        key: 'x',
      }),
    ).toBe(state);
  });
});
