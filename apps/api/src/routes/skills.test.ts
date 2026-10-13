import { IAP_ASSERTION_HEADER, taskApiSchema } from '@agent-works/domain';
import { describe, expect, it, vi } from 'vitest';

import { Unauthenticated, Unavailable } from '../auth/iap.js';
import { createMemoryTaskPorts } from '../ports/memory/task-ports.js';
import { createIncidentSkill } from '../skills/incident.js';
import { createSkillRegistry } from '../skills/registry.js';
import { createTaskDispatcher } from '../skills/task-dispatcher.js';
import { taskAuthorization } from '../testing/task-authorization.js';

import { createSkillsListRoute } from './skills-list.js';
import { createTaskRoutes } from './tasks.js';

import { createRouteTable } from './index.js';

import type { Caller, VerifyAssertion } from '../auth/iap.js';
import type { Route } from '../http.js';
import type { AskDeps } from './ask.js';
import type { TaskAuthorization } from './tasks.js';
import type { DeliverInput, Delivery } from '@agent-works/incident-analysis';

const caller = { sub: 'alice', assertion: 'verified-assertion' } as Caller;
const verify: VerifyAssertion = () => Promise.resolve(caller);
const submit = {
  kind: 'submit',
  objective: 'Analyze incident',
  skillId: 'incident-analysis',
  input: { incidentId: 'inc-1' },
  sourceAllowlist: ['incidents'],
  requestedOutputs: ['ticket'],
  executionPolicy: { mode: 'interactive', budgetUsd: 1, deadlineSeconds: 30 },
};

function request(body: unknown = submit, assertion = 'valid') {
  return {
    method: 'POST',
    path: '/v1/tasks',
    headers: { [IAP_ASSERTION_HEADER]: assertion, 'idempotency-key': 'key-1' },
    body: Buffer.from(JSON.stringify(body)),
  };
}

function setup(
  auth: VerifyAssertion = verify,
  authorization: TaskAuthorization = taskAuthorization,
) {
  const deliver = vi
    .fn<(input: DeliverInput) => Promise<Delivery>>()
    .mockResolvedValue({ kind: 'written', ticketId: 'ticket-1' });
  const model = { answer: vi.fn().mockResolvedValue('summary') };
  const registry = createSkillRegistry([
    createIncidentSkill(
      () => ({
        incidentsUrl: 'https://incidents.test',
        ticketsUrl: 'https://tickets.test',
        model,
      }),
      deliver,
    ),
  ]);
  const policyInput =
    authorization.wire?.policyInput === undefined
      ? undefined
      : vi.fn(authorization.wire.policyInput);
  const wire =
    authorization.wire === undefined ? undefined : { ...authorization.wire, policyInput };
  const { ledger, dispatch } = createMemoryTaskPorts();
  const save = vi.spyOn(dispatch, 'accept');
  const worker = createTaskDispatcher({ ledger, dispatch, registry });
  return {
    deliver,
    policyInput,
    model,
    registry,
    ledger,
    save,
    worker,
    routes: createTaskRoutes(ledger, auth, registry, { ...authorization, wire }, dispatch),
  };
}

describe('registered skills', () => {
  it('lists registered manifests behind the skills flag', async () => {
    const { registry } = setup();
    const deps = { verify, skills: registry } as AskDeps & { skills: typeof registry };
    const stub = createRouteTable(deps, {})['GET /v1/skills'];
    expect((await stub(request())).status).toBe(501);
    const real = createRouteTable(deps, { AW_SKILLS: 'real' })['GET /v1/skills'];
    expect(await real(request())).toEqual({
      status: 200,
      body: {
        skills: [
          {
            id: 'incident-analysis',
            version: '1.0.0',
            tools: ['ticket.create'],
            state: 'PUBLISHED',
          },
        ],
      },
    });
  });

  it('dispatches task submissions only when the task slot is enabled', async () => {
    const { registry, routes, deliver, worker } = setup();
    const deps = { verify, skills: registry, tasks: routes } as AskDeps & {
      skills: typeof registry;
      tasks: typeof routes;
    };
    const stub = createRouteTable(deps, {})['POST /v1/tasks'];
    expect((await stub(request())).status).toBe(501);
    expect(deliver).not.toHaveBeenCalled();
    const real = createRouteTable(deps, { AW_TASKS: 'real' })['POST /v1/tasks'];
    expect((await real(request())).status).toBe(200);
    expect(deliver).not.toHaveBeenCalled();
    await worker.runOnce();
    expect(deliver).toHaveBeenCalledOnce();
  });

  it('dispatches the selected skill with server config and the accepted task id', async () => {
    const { routes, deliver, model, save, ledger, policyInput, worker } = setup();
    const reply = await routes.submit(request());
    expect(reply.status).toBe(200);
    expect(policyInput).toHaveBeenCalledWith(
      caller,
      expect.objectContaining({
        userSubject: 'alice',
        taskPurpose: 'incident-analysis',
        allowedSources: ['incidents'],
      }),
      expect.any(Object),
    );
    expect(policyInput?.mock.calls[0]?.[2]).toMatchObject({
      request: { input: submit.input },
      manifest: { id: 'incident-analysis', tools: ['ticket.create'] },
    });
    expect(taskApiSchema.safeParse(reply.body).success).toBe(true);
    expect(save).toHaveBeenCalledWith(
      expect.objectContaining({
        subject: 'alice',
        request: expect.objectContaining({ input: submit.input }) as unknown,
        idempotencyKey: 'key-1',
      }),
    );
    expect(deliver).not.toHaveBeenCalled();
    await worker.runOnce();
    expect(deliver).toHaveBeenCalledOnce();
    const input = deliver.mock.calls[0][0];
    expect(input).toMatchObject({
      incidentId: 'inc-1',
      incidentsUrl: 'https://incidents.test',
      ticketsUrl: 'https://tickets.test',
      timeoutMs: 30_000,
      callerContext: {
        userSubject: 'alice',
        authorizedGroups: ['agent-users@company.example'],
        taskPurpose: 'incident-analysis',
        allowedSources: ['incidents'],
      },
    });
    expect(input.model).toBe(model);
    expect(input.ledger).toBeInstanceOf(Map);
    expect(input.skill.manifest.id).toBe(submit.skillId);
    expect(reply.body).toMatchObject({ taskId: input.deliveryId });
    expect(await ledger.readOutbox(`submit:${input.deliveryId}`)).toMatchObject({
      event: { initiatorSubject: 'alice', taskId: input.deliveryId },
    });
    expect(await routes.submit(request())).toEqual(reply);
    expect(await worker.runOnce()).toBe(false);
    expect(
      (await routes.submit(request({ ...submit, input: { incidentId: 'inc-2' } }))).status,
    ).toBe(409);
    expect(deliver).toHaveBeenCalledOnce();
  });

  it('denies a caller removed from the group before ledger writes or delivery', async () => {
    let groups = ['agent-users@company.example'];
    const { routes, save, ledger, deliver } = setup(verify, {
      ...taskAuthorization,
      wire: {
        ...taskAuthorization.wire,
        groups: () => Promise.resolve({ groups, observedAt: new Date().toISOString() }),
      },
    });
    const append = vi.spyOn(ledger, 'append');
    expect((await routes.submit(request())).status).toBe(200);
    groups = [];
    save.mockClear();
    append.mockClear();
    deliver.mockClear();
    expect(await routes.submit(request())).toEqual({ status: 403, body: { error: 'denied' } });
    expect(save).not.toHaveBeenCalled();
    expect(append).not.toHaveBeenCalled();
    expect(deliver).not.toHaveBeenCalled();
  });

  it.each([
    { wire: undefined },
    {
      wire: {
        ...taskAuthorization.wire,
        policyInput: async () => ({
          facts: {
            ...(await taskAuthorization.wire.policyInput()).facts,
            user_or_service_has_resource_authority: false,
          },
        }),
      },
    },
  ])(
    'denies missing or denied policy authority before ledger writes or delivery',
    async (patch) => {
      const { routes, save, ledger, deliver } = setup(verify, { ...taskAuthorization, ...patch });
      const append = vi.spyOn(ledger, 'append');
      expect(await routes.submit(request())).toEqual({ status: 403, body: { error: 'denied' } });
      expect(save).not.toHaveBeenCalled();
      expect(append).not.toHaveBeenCalled();
      expect(deliver).not.toHaveBeenCalled();
    },
  );

  it('rejects unknown skills before any ledger write or delivery', async () => {
    const { routes, deliver, save } = setup();
    const reply = await routes.submit(request({ ...submit, skillId: 'unknown' }));
    expect(reply).toEqual({ status: 400, body: { error: 'unknown_skill' } });
    expect(taskApiSchema.safeParse(reply.body).success).toBe(true);
    expect(save).not.toHaveBeenCalled();
    expect(deliver).not.toHaveBeenCalled();
  });

  it('rejects missing skill input and trusted client fields', async () => {
    const { routes, deliver, save } = setup();
    const legacy = { ...submit, input: undefined };
    expect(taskApiSchema.safeParse(legacy).success).toBe(true);
    expect((await routes.submit(request(legacy))).status).toBe(400);
    expect((await routes.submit(request({ ...submit, input: { incidentId: '' } }))).status).toBe(
      400,
    );
    expect((await routes.submit(request({ ...submit, userId: 'bob' }))).status).toBe(422);
    expect(save).not.toHaveBeenCalled();
    expect(deliver).not.toHaveBeenCalled();
  });

  it.each([Unauthenticated, Unavailable])(
    'preserves authorization failures for listing and dispatch (%s)',
    async (ErrorType) => {
      const auth = vi.fn().mockRejectedValue(new ErrorType('test'));
      const { routes, registry, deliver, save } = setup(auth);
      const list = createSkillsListRoute(auth, registry);
      const status = ErrorType === Unauthenticated ? 401 : 503;
      for (const route of [list, routes.submit] as Route[]) {
        expect((await route(request({ ...submit, skillId: 'unknown' }, 'invalid'))).status).toBe(
          status,
        );
      }
      expect(auth).toHaveBeenCalledWith('invalid');
      expect(deliver).not.toHaveBeenCalled();
      expect(save).not.toHaveBeenCalled();
    },
  );

  it('hides tasks and events from another subject', async () => {
    const { ledger, dispatch } = createMemoryTaskPorts();
    const { registry } = setup();
    const alice = createTaskRoutes(ledger, verify, registry, taskAuthorization, dispatch);
    const reply = await alice.submit(request());
    const accepted = taskApiSchema.parse(reply.body);
    if (!('taskId' in accepted)) throw new Error('accepted');
    const bob = createTaskRoutes(
      ledger,
      () => Promise.resolve({ ...caller, sub: 'bob' }),
      registry,
    );
    for (const [route, suffix] of [
      [bob.read, ''],
      [bob.events, '/events'],
    ] as const) {
      expect(await route({ ...request(), path: `/v1/tasks/${accepted.taskId}${suffix}` })).toEqual({
        status: 404,
        body: { error: 'not_found' },
      });
    }
  });
});
