import { describe, expect, it } from 'vitest';

import { inboxPanel } from './inbox-target.js';

const TASK = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const APPROVAL = '99999999-8888-4777-8666-555555555555';

describe('inboxPanel', () => {
  it('opens the plan at the version the item names', () => {
    expect(inboxPanel({ kind: 'plan_review', taskId: TASK, ref: 'plan:3' })).toEqual({
      kind: 'plan',
      taskId: TASK,
      version: 3,
    });
  });

  it('opens the exact approval and the exact result revision', () => {
    expect(inboxPanel({ kind: 'approval', taskId: TASK, ref: `approval:${APPROVAL}` })).toEqual({
      kind: 'approval',
      taskId: TASK,
      approvalId: APPROVAL,
    });
    expect(inboxPanel({ kind: 'completed', taskId: TASK, ref: 'revision:2' })).toMatchObject({
      kind: 'result',
      taskId: TASK,
      revision: 2,
      view: 'result',
    });
  });

  it('falls back to the task panel for questions, failures and malformed refs', () => {
    for (const item of [
      { kind: 'question' as const, ref: 'question:x:1' },
      { kind: 'failed' as const, ref: 'failed:4' },
      { kind: 'uncertain' as const, ref: 'uncertain:4' },
      { kind: 'plan_review' as const, ref: 'plan:nope' },
      { kind: 'approval' as const, ref: 'approval:not-a-uuid' },
    ])
      expect(inboxPanel({ ...item, taskId: TASK })).toEqual({ kind: 'task', taskId: TASK });
  });
});
