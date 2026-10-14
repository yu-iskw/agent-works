import { describe, expect, it, vi } from 'vitest';

import { runApiCommand } from './explain.js';
const task = {
  id: 'task-1',
  createdBySub: 'alice',
  status: 'QUEUED',
  objectiveDigest: 'a'.repeat(64),
  skillVersion: '1',
  agentVersion: '1',
  policyVersion: '1',
  budget: 1,
  version: 1,
  createdAt: '2026-10-14T00:00:00.000Z',
  updatedAt: '2026-10-14T00:00:00.000Z',
};
describe('CLI commands on generated client', () => {
  it('reads tasks using the generated schema and client transport', async () => {
    const write = vi.fn();
    const load = vi.fn(() => Promise.resolve(new Response(JSON.stringify(task))));
    expect(
      await runApiCommand(
        ['node', 'aw', 'tasks', 'read', 'task-1'],
        { write },
        { baseUrl: 'http://127.0.0.1:8084', fetch: load },
      ),
    ).toBe(0);
    expect(write).toHaveBeenCalledWith(JSON.stringify(task) + '\n');
    expect(load).toHaveBeenCalledOnce();
  });
  it('decides approvals with exact payload and CSRF through the generated client', async () => {
    const write = vi.fn();
    const load = vi.fn(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            kind: 'decided',
            id: 'approval-1',
            state: 'approved',
            executionsUsed: 0,
          }),
        ),
      ),
    );
    expect(
      await runApiCommand(
        ['node', 'aw', 'approvals', 'decide', 'approval-1', 'approve', 'a'.repeat(64), 'csrf'],
        { write },
        { baseUrl: 'https://api.fake.test', fetch: load },
      ),
    ).toBe(0);
    expect(load).toHaveBeenCalledOnce();
  });
  it('reports malformed success as a validation error', async () => {
    const write = vi.fn();
    const load = () => Promise.resolve(new Response(JSON.stringify({ id: 'task-1' })));
    expect(
      await runApiCommand(
        ['node', 'aw', 'tasks', 'read', 'task-1'],
        { write },
        { baseUrl: 'https://api.fake.test', fetch: load },
      ),
    ).toBe(1);
    expect(write).toHaveBeenCalledWith('ERROR 200 invalid_response\n');
  });
  it('does not send an invalid decision or digest', async () => {
    const load = vi.fn();
    expect(
      await runApiCommand(
        ['node', 'aw', 'approvals', 'decide', 'approval-1', 'approve', 'changed', 'csrf'],
        { write: vi.fn() },
        { baseUrl: 'https://api.fake.test', fetch: load },
      ),
    ).toBe(1);
    expect(load).not.toHaveBeenCalled();
  });
});
