import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { timelineItems } from './teamwork-timeline.js';

import type { Card, TimelineItem } from './teamwork-timeline.js';
import type {
  ActionApprovalView,
  AssignmentView,
  MessageView,
  PlanView,
  RevisionView,
  TaskDetail,
  TaskSummary,
} from './teamwork.js';

const T0 = Date.parse('2026-10-30T10:00:00.000Z');
const at = (minutes: number): string => new Date(T0 + minutes * 60_000).toISOString();
const NOW = at(600);
const coordinator = { id: 'tm-coord', name: 'Coordinator' };
const analyst = { id: 'tm-analyst', name: 'Research analyst' };

const message = (over: Partial<MessageView> & { id: string; at: string }): MessageView => ({
  role: 'member',
  text: 'hello',
  taskId: null,
  card: null,
  pending: false,
  ...over,
});

const task = (over: Partial<TaskSummary> = {}): TaskSummary => ({
  id: 'task-1',
  title: 'Which flag service',
  workflow: 'research_brief',
  mode: 'coordinated',
  status: 'running',
  version: 3,
  resultOwner: coordinator.id,
  conversationId: 'conv-1',
  latestRevision: 0,
  errorCode: null,
  errorMessage: null,
  createdAt: at(0),
  updatedAt: at(1),
  ...over,
});

const detail = (over: Partial<TaskDetail> = {}): TaskDetail => ({
  apiVersion: 'teamwork.v1',
  segment: 'alpha',
  task: task(),
  scope: { question: 'Which flag service?', metrics: null, repository: null, issueNumber: null },
  plans: [],
  assignments: [],
  evidence: [],
  revisions: [],
  approvals: [],
  messages: [],
  events: [],
  ...over,
});

const assignment = (over: Partial<AssignmentView> & { id: string }): AssignmentView => ({
  key: 'part-1',
  teammateId: analyst.id,
  teammateName: analyst.name,
  skills: [],
  brief: 'Compare',
  deliverable: 'Findings',
  sources: ['drive_research'],
  status: 'queued',
  attempt: 1,
  planVersion: 1,
  question: null,
  errorCode: null,
  errorMessage: null,
  startedAt: null,
  finishedAt: null,
  deadlineAt: at(60),
  output: null,
  model: null,
  ...over,
});

const revision = (n: number, createdAt: string): RevisionView => ({
  revision: n,
  parent: n === 1 ? null : n - 1,
  request: null,
  content: {
    title: `Brief v${n}`,
    summary: `Summary ${n}`,
    sections: [{ heading: 'Findings', statements: [] }],
    limitations: n === 2 ? ['One source was stale'] : [],
  },
  evidenceIds: [],
  calculations: [],
  unsupported: n,
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
  createdAt,
});

const approval = (
  over: Partial<ActionApprovalView> & { id: string; revision: number },
): ActionApprovalView => ({
  state: 'pending',
  proposal: {
    tool: 'google_docs.create',
    account: 'alice@example.test',
    destination: 'Drive/Briefs',
    documentTitle: 'Brief',
    revision: over.revision,
    contentMarkdown: '# Brief',
    wordCount: 10,
    consequences: [],
  },
  digest: 'b'.repeat(64),
  requestedAt: at(100),
  expiresAt: at(700),
  decidedAt: null,
  action: null,
  ...over,
});

const plan = (version: number, state: PlanView['state']): PlanView => ({
  version,
  state,
  author: 'coordinator',
  content: {
    summary: 'Two readers in parallel',
    assignments: [
      {
        key: 'part-1',
        teammateId: analyst.id,
        brief: 'Compare',
        deliverable: 'Findings',
        sources: ['drive_research'],
        dependsOn: [],
      },
    ],
    synthesisOwner: coordinator.id,
    expectedEffects: [],
  },
  capabilities: ['drive.read'],
  digest: 'c'.repeat(64),
  createdAt: at(2),
  decidedAt: null,
});

const anchor = (
  id: string,
  minutes: number,
  kind: NonNullable<MessageView['card']>['kind'],
  ref: string | undefined,
  taskId = 'task-1',
): MessageView =>
  message({
    id,
    at: at(minutes),
    role: 'system',
    text: `anchor ${kind}`,
    taskId,
    card: { kind, taskId, title: 'Which flag service', ...(ref === undefined ? {} : { ref }) },
  });

const timeline = (
  messages: readonly MessageView[],
  tasks: readonly TaskDetail[] = [],
): readonly TimelineItem[] =>
  timelineItems({ teammate: coordinator, messages, tasks, teammates: [analyst], now: NOW });

const cards = (items: readonly TimelineItem[]): readonly (Card & { id: string })[] =>
  items.flatMap((item) => (item.kind === 'card' ? [{ ...item.card, id: item.id }] : []));

const card = <K extends Card['kind']>(
  items: readonly TimelineItem[],
  kind: K,
  id?: string,
): Extract<Card, { kind: K }> & { id: string } => {
  const found = cards(items).find((c) => c.kind === kind && (id === undefined || c.id === id));
  if (found === undefined) throw new Error(`no ${kind} card`);
  return found as Extract<Card, { kind: K }> & { id: string };
};

describe('timeline messages', () => {
  it('dedupes overlapping pages, orders by time and keeps content-free ids', () => {
    const older = [message({ id: 'm1', at: at(0) }), message({ id: 'm2', at: at(1) })];
    const newer = [
      message({ id: 'm2', at: at(1) }),
      message({ id: 'm3', at: at(2), role: 'teammate' }),
    ];
    const items = timeline([...newer, ...older]);
    expect(items.map((i) => i.id)).toEqual(['day:2026-10-30', 'msg:m1', 'msg:m2', 'msg:m3']);
    expect(items[3]).toMatchObject({ kind: 'message', author: coordinator, text: 'hello' });
  });

  it('groups consecutive same-author messages within five minutes and nothing else', () => {
    const items = timeline([
      message({ id: 'a', at: at(0) }),
      message({ id: 'b', at: at(4) }),
      message({ id: 'c', at: at(10) }),
      message({ id: 'd', at: at(11), role: 'teammate' }),
      message({ id: 'e', at: at(12), role: 'teammate' }),
      message({ id: 'f', at: at(12.5), role: 'system', text: 'note' }),
      message({ id: 'g', at: at(13), role: 'teammate' }),
    ]);
    const grouped = Object.fromEntries(
      items.flatMap((i) => (i.kind === 'message' ? [[i.messageId, i.grouped]] : [])),
    );
    expect(grouped).toEqual({ a: false, b: true, c: false, d: false, e: true, g: false });
    expect(items.find((i) => i.id === 'msg:f')).toMatchObject({ kind: 'system', text: 'note' });
  });

  it('separates days and never groups across them', () => {
    const items = timeline([
      message({ id: 'a', at: '2026-10-30T23:58:00.000Z' }),
      message({ id: 'b', at: '2026-10-31T00:01:00.000Z' }),
    ]);
    expect(items.map((i) => i.id)).toEqual(['day:2026-10-30', 'msg:a', 'day:2026-10-31', 'msg:b']);
    expect(items[3]).toMatchObject({ grouped: false });
  });

  it('keeps an anchor whose task is not loaded as its persisted system row', () => {
    const items = timeline([anchor('x', 1, 'plan_review', 'plan:1')]);
    expect(items[1]).toMatchObject({ kind: 'system', id: 'msg:x', text: 'anchor plan_review' });
  });
});

describe('live and result cards', () => {
  it('anchors the live card at task_created with the observed stage and contribution count', () => {
    const base = {
      ...detail({
        assignments: [
          assignment({ id: 'a1', status: 'succeeded', finishedAt: at(20) }),
          assignment({ id: 'a2', status: 'running', startedAt: at(21) }),
          assignment({ id: 'a3', status: 'superseded' }),
        ],
      }),
    };
    const reading = timeline([anchor('m', 1, 'task_created', undefined)], [base]);
    expect(card(reading, 'running')).toMatchObject({
      id: 'card:task-1:live',
      stage: 'reading',
      owner: { kind: 'teammate', ...coordinator },
      done: 1,
      total: 2,
    });
    const contributing = timeline(
      [anchor('m', 1, 'task_created', undefined)],
      [
        {
          ...base,
          events: [
            {
              seq: 1,
              type: 'retrieval.completed',
              summary: 'read',
              at: at(22),
              durationMs: null,
              detail: { assignmentId: 'a2' },
            },
          ],
        },
      ],
    );
    expect(card(contributing, 'running').stage).toBe('contributing');
    const waiting = timeline(
      [anchor('m', 1, 'task_created', undefined)],
      [detail({ assignments: [assignment({ id: 'a1' })] })],
    );
    expect(card(waiting, 'running').stage).toBe('queued');
    const done = timeline(
      [anchor('m', 1, 'task_created', undefined)],
      [detail({ task: task({ status: 'completed' }) })],
    );
    expect(card(done, 'running').stage).toBe('completed');
  });

  it('keeps one result card per revision and links an old card to the newest revision', () => {
    const d = detail({
      task: task({ status: 'ready', latestRevision: 2 }),
      revisions: [revision(1, at(30)), revision(2, at(90))],
    });
    const items = timeline(
      [
        anchor('r1', 30.1, 'result_ready', undefined),
        anchor('r2', 90.1, 'result_ready', 'revision:2'),
        anchor('r2-published', 95, 'result_ready', 'revision:2'),
      ],
      [d],
    );
    expect(cards(items).map((c) => c.id)).toEqual([
      'card:task-1:revision:1',
      'card:task-1:revision:2',
    ]);
    expect(card(items, 'result', 'card:task-1:revision:1')).toMatchObject({
      revision: 1,
      latest: 2,
      title: 'Brief v1',
      unsupported: 1,
      limitations: 0,
    });
    expect(card(items, 'result', 'card:task-1:revision:2')).toMatchObject({
      revision: 2,
      latest: 2,
      limitations: 1,
    });
    expect(items.find((i) => i.id === 'msg:r2-published')).toMatchObject({ kind: 'system' });
  });

  it('takes the newest task version when pages disagree', () => {
    const stale = detail({ task: task({ version: 2, status: 'running' }) });
    const fresh = detail({ task: task({ version: 5, status: 'completed' }) });
    const items = timeline([anchor('m', 1, 'task_created', undefined)], [fresh, stale]);
    expect(card(items, 'running').stage).toBe('completed');
  });
});

describe('decision cards', () => {
  it('derives a plan card from the plan the ref names', () => {
    const d = detail({
      task: task({ status: 'running' }),
      plans: [plan(1, 'rejected'), plan(2, 'approved')],
    });
    const items = timeline(
      [anchor('p1', 2, 'plan_review', 'plan:1'), anchor('p2', 5, 'plan_review', 'plan:2')],
      [d],
    );
    expect(card(items, 'plan', 'card:task-1:plan:1')).toMatchObject({
      version: 1,
      state: 'rejected',
    });
    expect(card(items, 'plan', 'card:task-1:plan:2')).toMatchObject({
      version: 2,
      state: 'approved',
      summary: 'Two readers in parallel',
      assignments: 1,
      inboxRef: 'plan:2',
    });
  });

  it('marks a question answered once the assignment moved past that attempt', () => {
    const open = detail({
      task: task({ status: 'needs_input' }),
      assignments: [
        assignment({
          id: 'a1',
          status: 'needs_input',
          question: 'Which region?',
          finishedAt: at(8),
        }),
      ],
    });
    const items = timeline([anchor('q', 8, 'question', 'question:a1:1')], [open]);
    expect(card(items, 'question')).toMatchObject({
      id: 'card:task-1:question:a1:1',
      author: { kind: 'teammate', ...analyst },
      question: 'Which region?',
      answered: false,
    });
    const answered = detail({
      assignments: [
        assignment({ id: 'a1', status: 'running', attempt: 2, question: 'Which region?' }),
      ],
    });
    expect(
      card(timeline([anchor('q', 8, 'question', 'question:a1:1')], [answered]), 'question')
        .answered,
    ).toBe(true);
  });

  it('judges an approval exactly as the server will: pending, latest revision, not expired', () => {
    const anchors = [anchor('ap', 100, 'approval', 'approval:ap-1')];
    const valid = detail({
      task: task({ status: 'awaiting_action_approval', latestRevision: 2 }),
      approvals: [approval({ id: 'ap-1', revision: 2 })],
    });
    expect(card(timeline(anchors, [valid]), 'approval')).toMatchObject({
      valid: true,
      invalidReason: null,
      revision: 2,
      latestRevision: 2,
      destination: 'Drive/Briefs',
    });
    const stale = detail({
      task: task({ status: 'awaiting_action_approval', latestRevision: 3 }),
      approvals: [approval({ id: 'ap-1', revision: 2 })],
    });
    expect(card(timeline(anchors, [stale]), 'approval')).toMatchObject({
      valid: false,
      invalidReason: 'stale_revision',
      latestRevision: 3,
    });
    const expired = detail({
      task: task({ status: 'awaiting_action_approval', latestRevision: 2 }),
      approvals: [approval({ id: 'ap-1', revision: 2, expiresAt: at(500) })],
    });
    expect(card(timeline(anchors, [expired]), 'approval')).toMatchObject({
      valid: false,
      invalidReason: 'expired',
    });
    const decided = detail({
      task: task({ status: 'completed', latestRevision: 2 }),
      approvals: [approval({ id: 'ap-1', revision: 2, state: 'approved', decidedAt: at(110) })],
    });
    expect(card(timeline(anchors, [decided]), 'approval')).toMatchObject({
      valid: false,
      invalidReason: 'decided',
    });
  });

  it('keeps a partial failure visible: the missing card names the assignments and their contributions stay', () => {
    const d = detail({
      task: task({ status: 'needs_input' }),
      assignments: [
        assignment({
          id: 'ok',
          status: 'succeeded',
          finishedAt: at(20),
          output: { summary: 'Found two options', statements: [], gaps: [], question: null },
        }),
        assignment({
          id: 'bad',
          key: 'part-2',
          status: 'timed_out',
          finishedAt: at(25),
          errorMessage: 'deadline passed',
        }),
      ],
    });
    const items = timeline([anchor('miss', 26, 'question', 'missing:bad.1')], [d]);
    expect(card(items, 'failure')).toMatchObject({
      id: 'card:task-1:missing:bad.1',
      stage: 'assignment',
      recovery: 'decide',
      resolved: false,
      missing: [
        { assignmentId: 'bad', status: 'timed_out', author: { kind: 'teammate', ...analyst } },
      ],
    });
    const contributions = items.filter((i) => i.kind === 'contribution');
    expect(contributions.map((c) => c.id)).toEqual(['asg:ok', 'asg:bad']);
    expect(contributions[0]).toMatchObject({
      status: 'succeeded',
      summary: 'Found two options',
      at: at(20),
    });
    expect(contributions[1]).toMatchObject({
      status: 'timed_out',
      error: 'deadline passed',
      summary: null,
    });
    const proceeded = timeline(
      [anchor('miss', 26, 'question', 'missing:bad.1')],
      [{ ...d, task: task({ status: 'synthesizing' }) }],
    );
    expect(card(proceeded, 'failure').resolved).toBe(true);
  });

  it('reads the failed stage from the nearest task.failed event and resolves after a retry', () => {
    const failed = detail({
      task: task({
        status: 'failed',
        errorCode: 'model_unavailable',
        errorMessage: 'Model refused',
      }),
      events: [
        {
          seq: 1,
          type: 'task.failed',
          summary: 'x',
          at: at(5),
          durationMs: null,
          detail: { stage: 'planning' },
        },
        {
          seq: 2,
          type: 'task.failed',
          summary: 'y',
          at: at(40),
          durationMs: null,
          detail: { stage: 'synthesis' },
        },
      ],
    });
    const items = timeline(
      [anchor('f1', 5, 'failed', 'failed:2'), anchor('f2', 40, 'failed', 'failed:7')],
      [failed],
    );
    expect(card(items, 'failure', 'card:task-1:failed:2')).toMatchObject({
      stage: 'planning',
      resolved: false,
    });
    expect(card(items, 'failure', 'card:task-1:failed:7')).toMatchObject({
      stage: 'synthesis',
      code: 'model_unavailable',
      message: 'Model refused',
      recovery: 'retry',
    });
    const retried = timeline(
      [anchor('f2', 40, 'failed', 'failed:7')],
      [{ ...failed, task: task({ status: 'synthesizing' }) }],
    );
    expect(card(retried, 'failure').resolved).toBe(true);
  });

  it('derives an uncertain-effect card that asks for reconciliation', () => {
    const d = detail({ task: task({ status: 'outcome_uncertain', latestRevision: 1 }) });
    expect(
      card(timeline([anchor('u', 120, 'uncertain', 'uncertain:9')], [d]), 'failure'),
    ).toMatchObject({
      stage: 'action',
      recovery: 'reconcile',
      resolved: false,
      inboxRef: 'uncertain:9',
    });
  });
});

describe('module boundary', () => {
  it('imports nothing at runtime, so the browser bundle carries no zod', () => {
    // Static repository path, never request controlled.
    // eslint-disable-next-line security/detect-non-literal-fs-filename
    const source = readFileSync(new URL('./teamwork-timeline.ts', import.meta.url), 'utf8');
    const imports = source.split('\n').filter((line) => line.startsWith('import'));
    expect(imports.length).toBeGreaterThan(0);
    for (const line of imports) expect(line).toMatch(/^import type /);
  });
});
