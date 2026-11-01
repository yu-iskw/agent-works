import { describe, expect, it } from 'vitest';

import {
  commandPrefix,
  completeMetrics,
  liveTaskKeys,
  defaultOwner,
  defaultTarget,
  draftFromChips,
  draftProblems,
  planSend,
  sourceOptions,
  synthesisOwners,
  targetCandidates,
  targetLabel,
  taskCreateBody,
} from './composer-routing.js';

import type {
  ComposerContext,
  ContextChip,
  FileChip,
  TargetTask,
} from '../../../shared/composer.js';

const T1 = '11111111-2222-4333-8444-555555555555';
const T2 = '22222222-2222-4333-8444-555555555555';
const CONV = '33333333-2222-4333-8444-555555555555';
const REQ = '44444444-2222-4333-8444-555555555555';
const ATT = '55555555-2222-4333-8444-555555555555';
const SYN = '66666666-2222-4333-8444-555555555555';

const granted = (
  capability: 'drive.read' | 'files.read' | 'bigquery.query',
  effective: boolean,
) => ({
  capability,
  requested: true,
  permitted: effective,
  connected: effective,
  effective,
  reason: effective ? null : 'Google is not connected in this segment',
});

const context: ComposerContext = {
  segment: 'alpha',
  teammates: [
    {
      id: T1,
      name: 'Haru',
      role: 'Research',
      appearance: { avatar: null, accent: null },
      templateName: 'Researcher',
      skills: [],
      capabilities: [granted('drive.read', true), granted('files.read', true)],
    },
    {
      id: T2,
      name: 'Mika',
      role: 'Metrics analyst',
      appearance: { avatar: null, accent: null },
      templateName: 'Metrics analyst',
      skills: [],
      capabilities: [
        granted('drive.read', false),
        granted('files.read', true),
        granted('bigquery.query', true),
      ],
    },
  ],
  skills: [
    {
      id: SYN,
      name: 'Decision brief synthesis',
      summary: 'Writes the brief',
      workflows: ['research_brief', 'metrics_explanation'],
      attachedTo: [T1],
      synthesizes: true,
    },
  ],
  sources: [
    {
      kind: 'drive_research',
      name: 'Drive research folder',
      capability: 'drive.read',
      workflows: ['research_brief'],
      unavailable: null,
    },
    {
      kind: 'drive_context',
      name: 'Drive business context folder',
      capability: 'drive.read',
      workflows: ['metrics_explanation'],
      unavailable: null,
    },
    {
      kind: 'bigquery_metrics',
      name: 'BigQuery metrics (read-only)',
      capability: 'bigquery.query',
      workflows: ['metrics_explanation'],
      unavailable: null,
    },
    {
      kind: 'member_file',
      name: 'Files you attached',
      capability: 'files.read',
      workflows: ['research_brief', 'metrics_explanation', 'engineering_proposal'],
      unavailable: null,
    },
  ],
  repositories: [],
  issue: null,
};

const file = (status: FileChip['status'], attachmentId: string | null = ATT): FileChip => ({
  kind: 'file',
  localId: 'f1',
  name: 'notes.md',
  mediaType: 'text/markdown',
  sizeBytes: 10,
  status,
  attachmentId,
  error: null,
  preview: null,
  lines: null,
  sha256: null,
});

const task = (extra: Partial<TargetTask>): TargetTask => ({
  taskId: 'task-1',
  title: 'Tool comparison',
  status: 'running',
  version: 1,
  latestRevision: 0,
  openQuestions: [],
  ...extra,
});

const question = (assignmentId: string, teammateName: string) => ({
  assignmentId,
  teammateName,
  question: 'Which?',
});

const send = (input: Partial<Parameters<typeof planSend>[0]>) =>
  planSend({
    text: 'hello',
    chips: [],
    target: null,
    candidates: [{ kind: 'teammate' }],
    sending: false,
    ...input,
  });

describe('planSend', () => {
  it('sends plain text as chat with the ready attachment ids', () => {
    expect(send({ chips: [file('ready')] })).toEqual({
      kind: 'chat',
      text: 'hello',
      attachmentIds: [ATT],
    });
  });

  it('does nothing while sending, uploading, or after a failed upload', () => {
    expect(send({ sending: true })).toEqual({ kind: 'nothing', reason: 'sending' });
    expect(send({ chips: [file('uploading', null)] })).toEqual({
      kind: 'nothing',
      reason: 'uploading',
    });
    expect(send({ chips: [file('failed', null)] })).toEqual({
      kind: 'nothing',
      reason: 'failed_upload',
    });
    expect(send({ text: '  ' })).toEqual({ kind: 'nothing', reason: 'empty' });
  });

  it('turns teammate, skill or source chips into a task draft, because chat cannot read sources', () => {
    const chips: ContextChip[] = [
      { kind: 'source', source: 'drive_research', name: 'Drive research folder' },
    ];
    expect(send({ chips })).toEqual({ kind: 'task_draft', mode: 'manual', objective: 'hello' });
  });

  it('reads a typed /task or /plan prefix', () => {
    expect(send({ text: '/task compare tools' })).toEqual({
      kind: 'task_draft',
      mode: 'manual',
      objective: 'compare tools',
    });
    expect(send({ text: '/plan compare tools' })).toEqual({
      kind: 'task_draft',
      mode: 'coordinated',
      objective: 'compare tools',
    });
    expect(commandPrefix('/taskforce')).toBeNull();
  });

  it('answers the one open question by default and asks when targets compete', () => {
    const one = targetCandidates([task({ openQuestions: [question('a1', 'Haru')] })]);
    expect(send({ candidates: one })).toEqual({
      kind: 'follow_up',
      taskId: 'task-1',
      followUp: 'answer',
      assignmentId: 'a1',
      text: 'hello',
    });
    const two = targetCandidates([
      task({ openQuestions: [question('a1', 'Haru'), question('a2', 'Mika')] }),
    ]);
    expect(send({ candidates: two })).toEqual({ kind: 'clarify', candidates: two });
    const mixed = targetCandidates([
      task({ openQuestions: [question('a1', 'Haru')] }),
      task({ taskId: 'task-2', status: 'ready', latestRevision: 1 }),
    ]);
    expect(send({ candidates: mixed }).kind).toBe('clarify');
  });

  it('follows an explicit target and refuses files on a follow-up instead of dropping them', () => {
    const revise = {
      kind: 'revise' as const,
      taskId: 'task-2',
      revision: 1,
      title: 'Tool comparison',
    };
    expect(send({ target: revise })).toEqual({
      kind: 'follow_up',
      taskId: 'task-2',
      followUp: 'revise',
      assignmentId: null,
      text: 'hello',
    });
    expect(send({ target: revise, chips: [file('ready')] })).toEqual({
      kind: 'nothing',
      reason: 'files_need_chat',
    });
    expect(send({ target: { kind: 'teammate' }, candidates: [] })).toEqual({
      kind: 'chat',
      text: 'hello',
      attachmentIds: [],
    });
  });
});

describe('targets', () => {
  it('lists chat, answers, revisions and questions, and only revisable results', () => {
    const candidates = targetCandidates([
      task({ openQuestions: [question('a1', 'Haru')] }),
      task({ taskId: 'task-2', status: 'completed', latestRevision: 3, title: 'Metrics' }),
      task({ taskId: 'task-3', status: 'synthesizing', latestRevision: 1 }),
    ]);
    expect(candidates.map((c) => targetLabel(c, 'Haru'))).toEqual([
      'Reply to Haru',
      "Answer Haru's question",
      'Revise Metrics rev 3',
      'Ask about Metrics',
    ]);
    expect(defaultTarget(candidates)).toBeNull();
    expect(defaultTarget([{ kind: 'teammate' }])).toEqual({ kind: 'teammate' });
  });
});

describe('liveTaskKeys', () => {
  it('keeps the newest five live tasks, in the conversation order (newest first)', () => {
    const tasks = Array.from({ length: 7 }, (_, i) => ({
      id: `t${i}`,
      version: i,
      status: i === 1 ? 'cancelled' : 'ready',
    }));
    expect(liveTaskKeys(tasks)).toEqual(['t0@0', 't2@2', 't3@3', 't4@4', 't5@5']);
  });
});

describe('completeMetrics', () => {
  it('holds the scope only once both months are complete', () => {
    const groupBy = 'region' as const;
    expect(completeMetrics({ baseline: '2026-09', current: '', groupBy })).toBeNull();
    expect(completeMetrics({ baseline: '2026-0', current: '2026-10', groupBy })).toBeNull();
    expect(completeMetrics({ baseline: '2026-09', current: '2026-10', groupBy })).toEqual({
      baseline: '2026-09',
      current: '2026-10',
      groupBy,
    });
  });
});

describe('draftFromChips', () => {
  const base = {
    conversationId: CONV,
    clientRequestId: REQ,
    objective: 'Compare tools',
    mode: 'manual' as const,
    context,
  };

  it('starts with the current teammate, infers the workflow, and pre-ticks usable sources', () => {
    const draft = draftFromChips({ ...base, chips: [], current: context.teammates[0] });
    expect(draft.workflow).toBe('research_brief');
    expect(draft.resultOwnerId).toBe(T1);
    expect(draft.specialists.map((s) => [s.name, s.sources])).toEqual([
      ['Haru', ['drive_research']],
    ]);
  });

  it('uses the mentioned teammates and leaves out sources they cannot use', () => {
    const chips: ContextChip[] = [
      { kind: 'teammate', id: T2, name: 'Mika', role: 'Metrics analyst' },
      file('ready'),
    ];
    const draft = draftFromChips({ ...base, chips, current: context.teammates[0] });
    expect(draft.specialists.map((s) => s.teammateId)).toEqual([T2]);
    expect(draft.attachments).toEqual([{ id: ATT, name: 'notes.md' }]);
    expect(draft.specialists[0].sources).toEqual(['member_file']);
    const options = sourceOptions('research_brief', context.teammates[1], context.sources, true);
    expect(options.find((o) => o.kind === 'drive_research')?.disabled).toBe(
      'Google is not connected in this segment',
    );
  });

  it('infers metrics from the teammate and names what a start still needs', () => {
    const draft = draftFromChips({ ...base, chips: [], current: context.teammates[1] });
    expect(draft.workflow).toBe('metrics_explanation');
    expect(draft.specialists[0].sources).toEqual(['bigquery_metrics']);
    expect(draft.specialists[0].teammateId).toBe(T2);
    expect(draft.resultOwnerId, 'Mika has no synthesis skill, so Haru owns the result').toBe(T1);
    expect(draftProblems(draft)).toEqual(['Choose the baseline and current months.']);
    expect(draftProblems({ ...draft, objective: ' ', specialists: [] })).toEqual([
      'Write what the task should find out.',
      'Add at least one specialist.',
      'Choose the baseline and current months.',
    ]);
  });

  it('leaves the owner empty and blocks Start when nobody can synthesize the workflow', () => {
    const chips: ContextChip[] = [
      { kind: 'teammate', id: T2, name: 'Mika', role: 'Metrics analyst' },
    ];
    const draft = draftFromChips({
      ...base,
      chips,
      current: context.teammates[1],
      context: { ...context, repositories: ['org/repo'], issue: 7 },
    });
    const engineering = { ...draft, workflow: 'engineering_proposal' as const };
    expect(synthesisOwners(context, 'engineering_proposal')).toEqual([]);
    expect(defaultOwner(context, 'engineering_proposal', T2)).toBe('');
    expect(draftProblems({ ...engineering, resultOwnerId: '' })).toContain(
      'No teammate can own the result: attach a synthesis skill for this workflow to a teammate under Details.',
    );
    expect(defaultOwner(context, 'research_brief', T2)).toBe(T1);
    expect(defaultOwner(context, 'research_brief', T1)).toBe(T1);
  });

  it('posts exactly the create body, with the objective as the brief when none was written', () => {
    const draft = draftFromChips({
      ...base,
      chips: [file('ready')],
      current: context.teammates[0],
    });
    expect(taskCreateBody(draft)).toEqual({
      clientRequestId: REQ,
      workflow: 'research_brief',
      mode: 'manual',
      scope: {
        question: 'Compare tools',
        metrics: null,
        repository: null,
        issueNumber: null,
        attachmentIds: [ATT],
      },
      resultOwner: T1,
      conversationId: CONV,
      assignments: [
        { teammateId: T1, brief: 'Compare tools', sources: ['drive_research', 'member_file'] },
      ],
    });
    expect(
      (taskCreateBody({ ...draft, mode: 'coordinated' }) as { assignments: unknown[] }).assignments,
    ).toEqual([]);
  });
});
