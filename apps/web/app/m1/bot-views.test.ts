import { describe, expect, it } from 'vitest';

import { BotPage, Preview, RunPage } from './bot-views.js';
import { InboxPage } from './views.js';

import type { BotPreview, BotRun } from './api.js';
import type { PageCtx } from './views.js';
import type { InboxItem } from '@agent-works/domain/teamwork';

const ctx: PageCtx = {
  session: {
    sub: 'alice',
    email: 'alice@local.test',
    name: 'Alice',
    idp: 'local-test',
    csrf: 'token',
    expiresAt: new Date('2099-01-01'),
  },
  segment: { id: 'alpha', name: 'Alpha', url: 'http://alpha' },
  segments: [],
  readiness: undefined,
  nav: 'teammates',
};
const preview: BotPreview = {
  revision: 2,
  digest: 'a'.repeat(64),
  name: 'Brief',
  purpose: 'Summarize',
  planning: 'Fixed',
  steps: [
    {
      id: 'read',
      kind: 'connector_read',
      title: 'Read',
      dependsOn: [],
      capability: 'files.read',
      query: 'Files',
    },
    { id: 'result', kind: 'result', title: 'Result', dependsOn: ['read'], from: 'read' },
  ],
  skills: [
    {
      stepId: 'summarize',
      packageId: 'brief-writer',
      version: '1.0.0',
      digest: 'b'.repeat(64),
      name: 'summarize-findings',
    },
  ],
  externalAgents: [
    {
      stepId: 'delegate',
      agentId: 'reference',
      displayName: 'Researcher',
      instruction: 'Review',
      dataSentExternally: [{ stepId: 'read', title: 'Read' }],
    },
  ],
  triggers: [
    {
      kind: 'schedule',
      timezone: 'Asia/Tokyo',
      timing: { kind: 'cron', expression: '0 9 * * *' },
      missedRun: 'skip',
      description: 'Daily in Asia/Tokyo. Skip missed runs.',
    },
  ],
  approvals: { mode: 'checkpoints_only', checkpoints: [{ stepId: 'approve', prompt: 'Approve?' }] },
  limits: {
    maxConcurrentRunsPerBot: 1,
    maxConcurrentRunsPerUser: 2,
    runTimeoutMinutes: 60,
    maxCostMicros: null,
  },
  result: { destination: 'inbox' },
  capabilities: ['files.read'],
};
const run = (status: string): BotRun => ({
  taskId: 'run-id',
  teammateId: 'bot-id',
  revision: 2,
  status,
  createdAt: '2026-01-01',
  steps: [
    {
      stepId: 'read',
      title: 'Read',
      kind: 'connector_read',
      status,
      attempt: 1,
      errorCode: null,
      terminalReason: null,
      outputSummary: null,
      external: null,
    },
  ],
  approvals: [{ id: 'approval-id', state: 'pending', prompt: 'Approve?', actionDigest: 'digest' }],
  lastError: null,
  cost: {
    completeness: 'partial',
    estimatedMicros: null,
    reportedMicros: 20,
    unknownItems: ['external'],
  },
  result: { text: 'Finished' },
  actions: {
    canCancel: true,
    canRetry: ['read'],
    canResolve: ['read'],
    canApprove: ['approval-id'],
  },
});

describe('bot views', () => {
  it('renders preview details and pins the reviewed revision and digest', () => {
    const html = Preview({ ctx, id: 'bot-id', preview }).html;
    for (const value of [
      'Depends on',
      'brief-writer',
      '1.0.0',
      'b'.repeat(64),
      'Data sent externally',
      'Researcher',
      'Asia/Tokyo',
      'Skip missed runs',
      'Approve?',
      'inbox',
      'name="revision" value="2"',
      `name="digest" value="${preview.digest}"`,
      '/revisions/2/export',
    ])
      expect(html).toContain(value);
  });
  it('shows diagnostics and stale confirmation recovery', () => {
    const html = BotPage({
      ctx,
      id: 'bot-id',
      name: 'A',
      runs: [],
      error: 'stale_confirmation',
      design: {
        outcome: 'needs_changes',
        diagnostics: [{ code: 'invalid_schema', path: ['workflow'], message: 'Invalid step' }],
        reply: 'Fix it',
        messageId: 'msg',
      },
    }).html;
    expect(html).toContain('This draft changed since you reviewed it');
    expect(html).toContain('Invalid step');
    expect(html).toContain('Reload');
  });
  it.each([
    'queued',
    'waiting_approval',
    'waiting_external',
    'outcome_uncertain',
    'cancelled',
    'completed',
  ])('shows run state and available actions for %s', (status) => {
    const html = RunPage({ ctx, run: run(status) }).html;
    for (const value of [
      status,
      'Approve?',
      'name="actionDigest" value="digest"',
      'Retry Read',
      'Resolve as succeeded',
      'Cancel run',
      'Finished',
      'partial — some costs unknown',
      'Estimated: unknown',
    ])
      expect(html).toContain(value);
  });
  it('links bot inbox items to their run page and teamwork items to their task (T7-04)', () => {
    const item = (
      taskKind: InboxItem['taskKind'],
      taskId: string,
      state: InboxItem['state'],
    ): InboxItem => ({
      id: `${taskId.slice(0, -1)}9`,
      kind: 'approval',
      taskId,
      taskKind,
      taskTitle: `${taskKind} work`,
      ref: 'ref',
      summary: 'Needs a decision',
      state,
      createdAt: '2026-11-05T00:00:00.000Z',
      resolvedAt: state === 'open' ? null : '2026-11-05T01:00:00.000Z',
    });
    const bot = '11111111-1111-4111-8111-111111111111';
    const task = '22222222-2222-4222-8222-222222222222';
    const { html } = InboxPage({
      ctx,
      items: [
        item('bot', bot, 'open'),
        item('teamwork', task, 'open'),
        item('bot', bot, 'resolved'),
      ],
    });
    expect(html).toContain(`/s/alpha/bot-runs/${bot}`);
    expect(html).not.toContain(`/s/alpha/tasks/${bot}`);
    expect(html).toContain(`/s/alpha/tasks/${task}#decision`);
  });
});
