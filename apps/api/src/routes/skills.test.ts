import { IAP_ASSERTION_HEADER, taskApiSchema } from '@agent-works/domain';
import { describe, expect, it, vi } from 'vitest';

import { Unauthenticated, Unavailable } from '../auth/iap.js';
import { createMemoryLedgerPort } from '../ports/memory/ledger-port.js';
import { createIncidentSkill } from '../skills/incident.js';
import { createSkillRegistry } from '../skills/registry.js';

import { createSkillsListRoute } from './skills-list.js';
import { createTaskRoutes } from './tasks.js';

import { createRouteTable } from './index.js';

import type { Caller, VerifyAssertion } from '../auth/iap.js';
import type { Route } from '../http.js';
import type { AskDeps } from './ask.js';
import type { DeliverInput, Delivery } from '@agent-works/incident-analysis';

const caller = { sub: 'alice' } as Caller;
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

function setup(auth: VerifyAssertion = verify) {
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
  const ledger = createMemoryLedgerPort();
  const save = vi.spyOn(ledger, 'submit');
  return {
    deliver,
    model,
    registry,
    ledger,
    save,
    routes: createTaskRoutes(ledger, auth, registry),
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
    const { registry, routes, deliver } = setup();
    const deps = { verify, skills: registry, tasks: routes } as AskDeps & {
      skills: typeof registry;
      tasks: typeof routes;
    };
    const stub = createRouteTable(deps, {})['POST /v1/tasks'];
    expect((await stub(request())).status).toBe(501);
    expect(deliver).not.toHaveBeenCalled();
    const real = createRouteTable(deps, { AW_TASKS: 'real' })['POST /v1/tasks'];
    expect((await real(request())).status).toBe(200);
    expect(deliver).toHaveBeenCalledOnce();
  });

  it('dispatches the selected skill with server config and the accepted task id', async () => {
    const { routes, deliver, model, save, ledger } = setup();
    const reply = await routes.submit(request());
    expect(reply.status).toBe(200);
    expect(taskApiSchema.safeParse(reply.body).success).toBe(true);
    expect(save).toHaveBeenCalledWith(
      'alice',
      expect.objectContaining({ input: submit.input }),
      'key-1',
    );
    expect(deliver).toHaveBeenCalledOnce();
    const input = deliver.mock.calls[0][0];
    expect(input).toMatchObject({
      incidentId: 'inc-1',
      incidentsUrl: 'https://incidents.test',
      ticketsUrl: 'https://tickets.test',
      timeoutMs: 30_000,
    });
    expect(input.model).toBe(model);
    expect(input.ledger).toBeInstanceOf(Map);
    expect(input.skill.manifest.id).toBe(submit.skillId);
    expect(reply.body).toMatchObject({ taskId: input.deliveryId });
    expect(await ledger.readOutbox(`submit:${input.deliveryId}`)).toMatchObject({
      event: { initiatorSubject: 'alice', taskId: input.deliveryId },
    });
    expect(await routes.submit(request())).toEqual(reply);
    expect(deliver.mock.calls[1][0].deliveryId).toBe(input.deliveryId);
    expect(
      (await routes.submit(request({ ...submit, input: { incidentId: 'inc-2' } }))).status,
    ).toBe(409);
    expect(deliver).toHaveBeenCalledTimes(2);
  });

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
    const ledger = createMemoryLedgerPort();
    const { registry } = setup();
    const alice = createTaskRoutes(ledger, verify, registry);
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
