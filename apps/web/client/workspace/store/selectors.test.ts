import { describe, expect, it } from 'vitest';

import { taskTitle } from './selectors.js';

import type { WorkspaceState } from './state.js';

const detail = { task: { id: 't1', title: 'From the detail' } };
const state = {
  tasks: { t1: { detail, loading: false, error: null } },
  conversation: {
    tasks: [
      { id: 't1', version: 1, status: 'ready', title: 'From the link' },
      { id: 't2', version: 1, status: 'running', title: 'Only linked' },
    ],
  },
} as unknown as Pick<WorkspaceState, 'tasks' | 'conversation'>;

describe('taskTitle', () => {
  it('prefers the loaded detail, then the conversation link, then nothing', () => {
    expect(taskTitle(state, 't1')).toBe('From the detail');
    expect(taskTitle(state, 't2')).toBe('Only linked');
    expect(taskTitle(state, 't3')).toBeUndefined();
    expect(taskTitle({ ...state, conversation: null }, 't2')).toBeUndefined();
  });
});
