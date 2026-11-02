import { describe, expect, it } from 'vitest';

import { RECAP_ROWS, buildRecap } from './recap.js';

import type { InboxItem, ResultEntry, TaskSummary } from '@agent-works/domain/teamwork';

const id = (n: number) => `${String(n).padStart(8, '0')}-2222-4333-8444-555555555555`;

const item = (
  n: number,
  kind: InboxItem['kind'],
  state: InboxItem['state'] = 'open',
): InboxItem => ({
  id: id(n),
  kind,
  taskId: id(100 + n),
  taskTitle: `task ${n}`,
  ref: 'plan:1',
  summary: `summary ${n}`,
  state,
  createdAt: '2026-10-30T00:00:00.000Z',
  resolvedAt: null,
});

const task = (n: number, status: TaskSummary['status']): TaskSummary => ({
  id: id(n),
  title: `task ${n}`,
  workflow: 'research_brief',
  mode: 'manual',
  status,
  version: 1,
  resultOwner: id(1),
  conversationId: null,
  latestRevision: 0,
  errorCode: null,
  errorMessage: null,
  createdAt: '2026-10-30T00:00:00.000Z',
  updatedAt: '2026-10-30T00:00:00.000Z',
});

const result = (n: number, taskN: number, revision: number): ResultEntry => ({
  taskId: id(taskN),
  taskTitle: `task ${taskN}`,
  revision,
  latestRevision: revision,
  title: `result ${n}`,
  producedBy: { id: id(1), name: 'Haru' },
  conversationId: null,
  createdAt: '2026-10-30T00:00:00.000Z',
});

describe('buildRecap', () => {
  it('keeps only open decisions, caps every section, and reports the full counts', () => {
    const inbox = [
      ...Array.from({ length: 7 }, (_, i) => item(i, 'question')),
      item(20, 'completed'),
      item(21, 'approval', 'resolved'),
    ];
    const running = Array.from({ length: 6 }, (_, i) => task(30 + i, 'running'));
    const recap = buildRecap('alpha', { inbox, running, results: [] });
    expect(recap.segment).toBe('alpha');
    expect(recap.decisions).toHaveLength(RECAP_ROWS);
    expect(recap.decisions.every((d) => d.kind === 'question' && d.state === 'open')).toBe(true);
    expect(recap.counts).toEqual({ decisions: 7, running: 6 });
    expect(recap.running).toHaveLength(RECAP_ROWS);
  });

  it('shows one entry per task in recent results, the newest revision first', () => {
    const results = [result(1, 50, 3), result(2, 50, 2), result(3, 51, 1)];
    const recap = buildRecap('alpha', { inbox: [], running: [], results });
    expect(recap.results.map((r) => [r.taskId, r.revision])).toEqual([
      [id(50), 3],
      [id(51), 1],
    ]);
  });

  it('is empty when nothing is persisted', () => {
    expect(buildRecap('alpha', { inbox: [], running: [], results: [] })).toEqual({
      segment: 'alpha',
      decisions: [],
      running: [],
      results: [],
      counts: { decisions: 0, running: 0 },
    });
  });
});
