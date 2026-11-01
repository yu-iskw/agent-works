import { TEAMWORK_STATUSES, TEAMWORK_TRANSITIONS } from '@agent-works/domain/teamwork';
import { describe, expect, it } from 'vitest';

import {
  CANCELLABLE,
  canCancel,
  missingAssignments,
  planDecisionBlocker,
} from './task-commands.js';

import type { TaskDetailPage } from '../../../shared/contract.js';
import type { AssignmentView, PlanView } from '@agent-works/domain/teamwork';

const detail = (over: Partial<TaskDetailPage> = {}): TaskDetailPage => ({
  segment: 'alpha',
  task: {
    id: 'task-1',
    title: 'T',
    workflow: 'research_brief',
    mode: 'coordinated',
    status: 'plan_review',
    version: 2,
    resultOwner: 'tm-1',
    conversationId: null,
    latestRevision: 0,
    errorCode: null,
    errorMessage: null,
    createdAt: '2026-10-30T00:00:00.000Z',
    updatedAt: '2026-10-30T00:00:00.000Z',
  },
  scope: { question: 'q', metrics: null, repository: null, issueNumber: null },
  plans: [],
  assignments: [],
  evidence: [],
  revisions: [],
  approvals: [],
  messages: [],
  events: [],
  ...over,
});

const plan = (version: number, state: PlanView['state']): PlanView => ({
  version,
  state,
  author: 'coordinator',
  content: {
    summary: 's',
    assignments: [
      {
        key: 'a',
        teammateId: 'tm-2',
        brief: 'b',
        deliverable: 'd',
        sources: ['drive_research'],
        dependsOn: [],
      },
    ],
    synthesisOwner: 'tm-1',
    expectedEffects: [],
  },
  capabilities: [],
  digest: 'a'.repeat(64),
  createdAt: '2026-10-30T00:00:00.000Z',
  decidedAt: null,
});

const assignment = (id: string, status: AssignmentView['status']): AssignmentView => ({
  id,
  key: id,
  teammateId: 'tm-2',
  teammateName: 'Analyst',
  skills: [],
  brief: 'b',
  deliverable: 'd',
  sources: [],
  status,
  attempt: 1,
  planVersion: 1,
  question: null,
  errorCode: null,
  errorMessage: null,
  startedAt: null,
  finishedAt: null,
  deadlineAt: '2026-10-30T01:00:00.000Z',
  output: null,
  model: null,
});

describe('task commands', () => {
  it('cancels exactly from the statuses the domain lets cancel', () => {
    for (const status of TEAMWORK_STATUSES) {
      // A task already in cancel_requested finishes cancelling on its own; the member cannot re-cancel.
      // `status` ranges over the closed TEAMWORK_STATUSES enum.
      // eslint-disable-next-line security/detect-object-injection
      const transitions = TEAMWORK_TRANSITIONS[status];
      const allowed =
        status !== 'cancel_requested' &&
        transitions.some((to) => to === 'cancel_requested' || to === 'cancelled');
      expect({ status, allowed: canCancel(status) }).toEqual({ status, allowed });
    }
    expect(CANCELLABLE.size).toBe(8);
  });

  it('lists unfinished assignments only while the task waits for input', () => {
    const waiting = detail({
      task: { ...detail().task, status: 'needs_input' },
      assignments: [
        assignment('a', 'failed'),
        assignment('b', 'succeeded'),
        assignment('c', 'timed_out'),
      ],
    });
    expect(missingAssignments(waiting).map((a) => a.id)).toEqual(['a', 'c']);
    expect(missingAssignments(detail({ assignments: waiting.assignments }))).toEqual([]);
  });

  it('allows a plan decision only on the live proposal of a task in review', () => {
    expect(planDecisionBlocker(detail({ plans: [plan(1, 'proposed')] }), 1)).toBeNull();
    expect(planDecisionBlocker(detail({ plans: [plan(1, 'proposed')] }), 2)).toMatch(
      /no longer exists/,
    );
    expect(planDecisionBlocker(detail({ plans: [plan(1, 'approved')] }), 1)).toMatch(
      /already approved/,
    );
    expect(
      planDecisionBlocker(detail({ plans: [plan(1, 'proposed'), plan(2, 'proposed')] }), 1),
    ).toMatch(/Version 2 replaced/);
    expect(
      planDecisionBlocker(
        detail({ plans: [plan(1, 'proposed')], task: { ...detail().task, status: 'running' } }),
        1,
      ),
    ).toMatch(/no longer waiting/);
  });
});
