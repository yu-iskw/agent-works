import { describe, expect, it } from 'vitest';

import { DEFAULT_PREFERENCES } from '../../../shared/contract.js';
import { conversationRoute } from '../../../shared/route.js';

import { initial, reduce } from './reducer.js';
import { tasksToFetch, timelineOf, timelineSettled } from './timeline-select.js';

import type { WorkspaceState } from './state.js';
import type { Bootstrap, TaskDetailPage } from '../../../shared/contract.js';
import type { MessageView } from '@agent-works/domain/teamwork';

const T = '11111111-2222-4333-8444-555555555555';
const CONV = '33333333-2222-4333-8444-555555555555';
const TASK = '22222222-2222-4333-8444-555555555555';
const at = (minutes: number) => new Date(Date.UTC(2026, 9, 30, 10, minutes)).toISOString();
const NOW = new Date(at(600));

const message = (over: Partial<MessageView> & { id: string }): MessageView => ({
  role: 'teammate',
  text: 'hi',
  taskId: null,
  card: null,
  pending: false,
  at: at(1),
  ...over,
});

const detail = (version: number, over: Partial<TaskDetailPage> = {}): TaskDetailPage => ({
  segment: 'alpha',
  task: {
    id: TASK,
    title: 'Flag service',
    workflow: 'research_brief',
    mode: 'coordinated',
    status: 'ready',
    version,
    resultOwner: T,
    conversationId: CONV,
    latestRevision: 1,
    errorCode: null,
    errorMessage: null,
    createdAt: at(0),
    updatedAt: at(5),
  },
  scope: { question: 'q', metrics: null, repository: null, issueNumber: null },
  plans: [],
  assignments: [],
  evidence: [],
  revisions: [
    {
      revision: 1,
      parent: null,
      request: null,
      content: {
        title: 'Brief',
        summary: 'Sum',
        sections: [{ heading: 'F', statements: [] }],
        limitations: [],
      },
      evidenceIds: [],
      calculations: [],
      unsupported: 0,
      droppedCitations: 0,
      missingAssignments: [],
      generation: {
        modelId: 'm',
        modelVersion: 'm',
        responseId: null,
        planVersion: null,
        skills: [],
        repositoryRevision: null,
      },
      diff: null,
      digest: 'a'.repeat(64),
      createdAt: at(4),
    },
  ],
  approvals: [],
  messages: [],
  events: [],
  ...over,
});

function state(messages: readonly MessageView[], version = 3): WorkspaceState {
  const bootstrap: Bootstrap = {
    scope: {
      memberTag: 'abcdef0123456789' as Bootstrap['scope']['memberTag'],
      segment: 'alpha',
      csrf: 'c',
    },
    route: conversationRoute('alpha', T),
    me: {
      segment: 'alpha',
      segmentName: 'Alpha',
      segments: [],
      member: { email: 'a@x', name: 'alice' },
      identity: 'local-test',
      sourceMode: 'fixture',
      model: { modelId: 'm', mode: 'vertex', state: 'ready', callsUsed: 0, callsLimit: 1 },
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
          unread: false,
          working: false,
          needsAttention: false,
          unreadResult: false,
          updatedAt: at(0),
        },
      ],
      nextCursor: null,
    },
    conversation: {
      segment: 'alpha',
      id: CONV,
      teammateId: T,
      messages,
      nextCursor: null,
      prevCursor: null,
      reply: 'none',
      tasks: [{ id: TASK, version, status: 'ready', title: 'Flag service' }],
    },
    notice: null,
    fallbackHref: '/x',
  };
  return initial(bootstrap, 'desktop', NOW.getTime());
}

describe('timeline glue', () => {
  it('is busy until every linked task detail has loaded or failed', () => {
    const empty = state([]);
    expect(timelineSettled(empty)).toBe(false);
    const held = reduce(empty, { type: 'task/loaded', epoch: empty.epoch, detail: detail(3) });
    expect(timelineSettled(held)).toBe(true);
    const failed = reduce(empty, { type: 'task/failed', taskId: TASK, error: 'unavailable' });
    expect(timelineSettled(failed)).toBe(true);
  });

  it('asks for linked task details it does not hold or holds at an older version', () => {
    const empty = state([]);
    expect(tasksToFetch(empty)).toEqual([TASK]);
    const held = reduce(empty, { type: 'task/loaded', epoch: empty.epoch, detail: detail(3) });
    expect(tasksToFetch(held)).toEqual([]);
    const moved = {
      ...held,
      conversation: {
        ...held.conversation!,
        tasks: [{ ...held.conversation!.tasks[0], version: 4 }],
      },
    };
    expect(tasksToFetch(moved)).toEqual([TASK]);
  });

  it('shows a card row as a plain system line until the task detail arrives, then as a card', () => {
    const anchor = message({
      id: 'm1',
      role: 'system',
      text: 'Result ready',
      taskId: TASK,
      card: { kind: 'result_ready', taskId: TASK, title: 'Flag service', ref: 'revision:1' },
    });
    const before = state([message({ id: 'm0', text: 'hello', at: at(0) }), anchor]);
    expect(timelineOf(before, NOW).map((i) => i.kind)).toEqual(['day', 'message', 'system']);
    const after = reduce(before, { type: 'task/loaded', epoch: before.epoch, detail: detail(3) });
    const items = timelineOf(after, NOW);
    expect(items.map((i) => i.kind)).toEqual(['day', 'message', 'card']);
    const card = items[2];
    expect(card.kind === 'card' && card.card.kind === 'result' && card.card.revision).toBe(1);
    expect(card.kind === 'message' ? null : card.id).toBe(`card:${TASK}:revision:1`);
  });

  it('attributes teammate messages to the conversation teammate by name', () => {
    const items = timelineOf(state([message({ id: 'm0' })]), NOW);
    const first = items[1];
    expect(first.kind === 'message' && first.author).toEqual({
      kind: 'teammate',
      id: T,
      name: 'Haru',
    });
  });
});
