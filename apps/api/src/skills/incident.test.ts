import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { Unavailable } from '../auth/iap.js';
import { createMemoryTaskPorts } from '../ports/memory/task-ports.js';
import { createTaskRoutes } from '../routes/tasks.js';
import { authorizedCaller, taskAuthorization } from '../testing/task-authorization.js';

import { createIncidentSkill } from './incident.js';
import { createSkillRegistry } from './registry.js';
import { createTaskDispatcher } from './task-dispatcher.js';

import type { Caller } from '../auth/iap.js';
import type { DeliverInput, Delivery } from '@agent-works/incident-analysis';

const submission = {
  objective: 'Analyze incident',
  skillId: 'incident-analysis',
  input: { incidentId: 'inc-1' },
  sourceAllowlist: ['incidents'],
  requestedOutputs: ['ticket'],
  executionPolicy: { mode: 'interactive', budgetUsd: 1, deadlineSeconds: 1 },
};
const accepted = {
  taskId: 'task-1',
  status: 'QUEUED' as const,
  submittedAt: '2026-10-12T00:00:00.000Z',
  statusUrl: '/v1/tasks/task-1',
  traceId: 'trace-1',
};

function delayedReceipt(ticket: { id: string }, signal?: AbortSignal | null): Promise<Response> {
  return new Promise<Response>((resolve, reject) => {
    const timer = setTimeout(() => resolve(Response.json(ticket)), 1500);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        reject(new Error('aborted'));
      },
      { once: true },
    );
  });
}

describe('incident adapter', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(accepted.submittedAt));
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it.each([true, false])(
    'reconciles an aborted write after expiry (committed: %s)',
    async (committed) => {
      const ticket = { id: 'ticket-1', idempotencyKey: accepted.taskId };
      const tickets: (typeof ticket)[] = [];
      const fetchMock = vi.fn<typeof fetch>().mockImplementation((url, options) => {
        if (options?.method === 'POST') {
          if (committed) tickets.push(ticket);
          return delayedReceipt(ticket, options.signal);
        }
        return Promise.resolve(
          Response.json(
            url instanceof URL && url.pathname === '/tickets'
              ? { tickets }
              : { id: 'inc-1', title: 'Latency', note: 'Deployment' },
          ),
        );
      });
      vi.stubGlobal('fetch', fetchMock);
      const model = { answer: vi.fn().mockResolvedValue('summary') };
      const skill = createIncidentSkill(() => ({
        incidentsUrl: 'https://incidents.test',
        ticketsUrl: 'https://tickets.test',
        model,
      }));
      const first = skill
        .dispatch(submission, accepted, authorizedCaller)
        .catch((error: unknown) => error);
      await vi.advanceTimersByTimeAsync(0);
      expect(tickets).toHaveLength(committed ? 1 : 0);
      await vi.advanceTimersByTimeAsync(1000);
      expect(await first).toBeInstanceOf(Unavailable);
      expect(fetchMock.mock.calls[1][1]?.signal?.aborted).toBe(true);
      expect(skill.result(accepted.taskId)).toEqual({ kind: 'timeout' });
      if (committed) {
        await skill.dispatch(submission, accepted, authorizedCaller);
        expect(skill.result(accepted.taskId)).toEqual({ kind: 'written', ticketId: ticket.id });
        await skill.dispatch(submission, accepted, authorizedCaller);
      } else {
        await expect(skill.dispatch(submission, accepted, authorizedCaller)).rejects.toBeInstanceOf(
          Unavailable,
        );
        expect(skill.result(accepted.taskId)).toEqual({ kind: 'timeout' });
      }
      expect(fetchMock).toHaveBeenCalledTimes(3);
      expect(fetchMock.mock.calls[1][1]).toMatchObject({
        method: 'POST',
        headers: { 'idempotency-key': accepted.taskId },
      });
      expect(fetchMock.mock.calls[2][0]).toEqual(new URL('https://tickets.test/tickets'));
      expect(fetchMock.mock.calls[2][1]?.method).toBeUndefined();
      expect(model.answer).toHaveBeenCalledOnce();
      expect(tickets).toHaveLength(committed ? 1 : 0);
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it('passes a fixed task deadline and cancellation signal', async () => {
    const deliver = vi
      .fn<(input: DeliverInput) => Promise<Delivery>>()
      .mockResolvedValue({ kind: 'written', ticketId: 'ticket-1' });
    const skill = createIncidentSkill(
      () => ({
        incidentsUrl: 'https://incidents.test',
        ticketsUrl: 'https://tickets.test',
        model: { answer: () => Promise.resolve('summary') },
      }),
      deliver,
    );
    const controller = new AbortController();
    await skill.dispatch(submission, accepted, authorizedCaller, {
      deadline: Date.now() + 500,
      signal: controller.signal,
    });
    expect(deliver.mock.calls[0][0]).toMatchObject({
      deadline: Date.now() + 500,
      signal: controller.signal,
    });
    expect(skill.result(accepted.taskId)).toEqual({ kind: 'written', ticketId: 'ticket-1' });
    await vi.advanceTimersByTimeAsync(1000);
    controller.abort();
    await skill.dispatch(submission, accepted, authorizedCaller);
    expect(deliver).toHaveBeenCalledOnce();
  });

  it('does not deliver an expired task', async () => {
    const deliver = vi.fn();
    const skill = createIncidentSkill(() => undefined, deliver);
    await vi.advanceTimersByTimeAsync(1000);
    await expect(skill.dispatch(submission, accepted, authorizedCaller)).rejects.toBeInstanceOf(
      Unavailable,
    );
    expect(deliver).not.toHaveBeenCalled();
    expect(skill.result(accepted.taskId)).toEqual({ kind: 'timeout' });
  });

  it('reports missing configuration without delivering', async () => {
    const deliver = vi.fn();
    const skill = createIncidentSkill(() => undefined, deliver);
    await expect(skill.dispatch(submission, accepted, authorizedCaller)).rejects.toBeInstanceOf(
      Unavailable,
    );
    expect(deliver).not.toHaveBeenCalled();
  });

  it('accepts independently of a delivery timeout', async () => {
    const deliver = vi
      .fn<(input: DeliverInput) => Promise<Delivery>>()
      .mockResolvedValueOnce({ kind: 'timeout' })
      .mockResolvedValueOnce({ kind: 'written', ticketId: 'ticket-1' });
    const registry = createSkillRegistry([
      createIncidentSkill(
        () => ({
          incidentsUrl: 'https://incidents.test',
          ticketsUrl: 'https://tickets.test',
          model: { answer: () => Promise.resolve('summary') },
        }),
        deliver,
      ),
    ]);
    const ports = createMemoryTaskPorts();
    const worker = createTaskDispatcher({ ...ports, registry, retryMs: 10 });
    const routes = createTaskRoutes(
      ports.ledger,
      () => Promise.resolve({ sub: 'alice' } as Caller),
      registry,
      taskAuthorization,
      ports.dispatch,
    );
    const request = {
      method: 'POST',
      path: '/v1/tasks',
      headers: { 'idempotency-key': 'key-1' },
      body: Buffer.from(JSON.stringify({ kind: 'submit', ...submission })),
    };
    const reply = await routes.submit(request);
    expect(reply.status).toBe(200);
    expect(deliver).not.toHaveBeenCalled();
    await worker.runOnce();
    expect((await routes.submit(request)).body).toEqual(reply.body);
    expect(deliver).toHaveBeenCalledOnce();
  });
  it('does not reset the deadline on retry', async () => {
    const deliver = vi
      .fn<(input: DeliverInput) => Promise<Delivery>>()
      .mockResolvedValue({ kind: 'timeout' });
    const skill = createIncidentSkill(
      () => ({
        incidentsUrl: 'https://incidents.test',
        ticketsUrl: 'https://tickets.test',
        model: { answer: () => Promise.resolve('summary') },
      }),
      deliver,
    );
    await expect(skill.dispatch(submission, accepted, authorizedCaller)).rejects.toBeInstanceOf(
      Unavailable,
    );
    await vi.advanceTimersByTimeAsync(1000);
    await expect(
      skill.dispatch(submission, accepted, authorizedCaller, { deadline: Date.now() + 1000 }),
    ).rejects.toBeInstanceOf(Unavailable);
    expect(deliver).toHaveBeenCalledOnce();
    expect(skill.result(accepted.taskId)).toEqual({ kind: 'timeout' });
  });
});
