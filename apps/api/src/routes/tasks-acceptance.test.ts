import { describe, expect, it, vi } from 'vitest';

import { createMemoryTaskPorts } from '../ports/memory/task-ports.js';
import { createSkillRegistry } from '../skills/registry.js';
import { taskAuthorization } from '../testing/task-authorization.js';

import { createTaskRoutes } from './tasks.js';

import type { Caller } from '../auth/iap.js';
import type { DispatchPort } from '../ports/dispatch-port.js';

const submit = {
  kind: 'submit',
  objective: 'Analyze incident',
  skillId: 'incident-analysis',
  input: { incidentId: 'inc-1' },
  sourceAllowlist: ['incidents'],
  requestedOutputs: ['ticket'],
  executionPolicy: { mode: 'interactive', budgetUsd: 1, deadlineSeconds: 30 },
};
const request = {
  method: 'POST',
  path: '/v1/tasks',
  headers: { 'idempotency-key': 'key' },
  body: Buffer.from(JSON.stringify(submit)),
};
const verify = () =>
  Promise.resolve({ sub: 'alice', assertion: 'assertion-not-persisted' } as Caller);

function setup(override?: (dispatch: DispatchPort) => DispatchPort) {
  const ports = createMemoryTaskPorts();
  const dispatchSkill = vi.fn().mockImplementation(() => new Promise<void>(() => {}));
  const skills = createSkillRegistry([
    {
      manifest: { id: submit.skillId, version: '1', state: 'PUBLISHED', tools: ['ticket.create'] },
      validate: () => true,
      dispatch: dispatchSkill,
    },
  ]);
  const dispatch = override?.(ports.dispatch) ?? ports.dispatch;
  return {
    ...ports,
    skills,
    dispatchSkill,
    routes: createTaskRoutes(ports.ledger, verify, skills, taskAuthorization, dispatch),
  };
}

describe('asynchronous task acceptance', () => {
  it('returns the atomically persisted ID without invoking a slow skill', async () => {
    const { routes, dispatchSkill, ledger, dispatch } = setup();
    const reply = await routes.submit(request);
    expect(reply.status).toBe(200);
    expect(dispatchSkill).not.toHaveBeenCalled();
    const claimed = await dispatch.claim('inspect', 60_000);
    if (claimed === undefined) throw new Error('delivery');
    expect(reply.body).toMatchObject({ taskId: claimed.taskId, kind: 'accepted' });
    expect(await ledger.read('alice', claimed.taskId)).toMatchObject({ status: 'QUEUED' });
    expect(await ledger.events('alice', claimed.taskId)).toHaveLength(1);
    expect(claimed.payload).toMatchObject({
      subject: 'alice',
      request: {
        input: submit.input,
        executionPolicy: submit.executionPolicy,
        sourceAllowlist: submit.sourceAllowlist,
      },
      context: { userSubject: 'alice', allowedSources: ['incidents'] },
      agent: { agentId: submit.skillId, version: '1' },
    });
    expect(JSON.stringify(claimed.payload)).not.toContain('assertion-not-persisted');
  });

  it('waits for acceptance to commit, while no delivery starts', async () => {
    let complete: (() => void) | undefined;
    const commit = new Promise<void>((resolve) => {
      complete = resolve;
    });
    const { routes, dispatchSkill } = setup((dispatch) => ({
      ...dispatch,
      accept: async (input) => {
        await commit;
        return dispatch.accept(input);
      },
    }));
    let replied = false;
    const pending = routes.submit(request).then((reply) => {
      replied = true;
      return reply;
    });
    await vi.waitFor(() => expect(complete).toBeDefined());
    expect(replied).toBe(false);
    expect(dispatchSkill).not.toHaveBeenCalled();
    complete?.();
    expect((await pending).status).toBe(200);
  });

  it('replays across fresh policy evaluations and deadlines without duplicate rows', async () => {
    const { ledger, dispatch, skills } = setup();
    let instant = new Date('2026-10-10T10:00:00.000Z');
    const authorization = {
      ...taskAuthorization,
      now: () => instant,
      wire: {
        ...taskAuthorization.wire,
        groups: () =>
          Promise.resolve({
            groups: ['agent-users@company.example'],
            observedAt: instant.toISOString(),
          }),
      },
    };
    const firstRoutes = createTaskRoutes(ledger, verify, skills, authorization, dispatch);
    const first = await firstRoutes.submit(request);
    instant = new Date('2026-10-10T10:00:01.000Z');
    const restarted = createTaskRoutes(ledger, verify, skills, authorization, dispatch);
    expect(await restarted.submit(request)).toEqual(first);
    const delivery = await dispatch.claim('reader', 1000);
    expect(delivery?.payload.deadline).toBe('2026-10-10T10:00:30.000Z');
    if (delivery === undefined) throw new Error('delivery');
    expect(await ledger.events('alice', delivery.taskId)).toHaveLength(1);
    expect(await dispatch.claim('duplicate', 1000)).toBeUndefined();
    const events = await restarted.events({
      ...request,
      method: 'GET',
      path: `/v1/tasks/${delivery.taskId}/events`,
    });
    expect(events.body).toMatchObject({
      events: [
        expect.objectContaining({
          event: expect.objectContaining({ eventType: 'task.submitted' }) as unknown,
        }),
      ],
    });
  });

  it('does not return an ID when acceptance fails', async () => {
    const { routes, dispatchSkill } = setup((dispatch) => ({
      ...dispatch,
      accept: () => Promise.reject(new Error('database offline')),
    }));
    await expect(routes.submit(request)).rejects.toThrow('database offline');
    expect(dispatchSkill).not.toHaveBeenCalled();
  });
});
