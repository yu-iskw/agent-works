import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { Unavailable } from '../auth/iap.js';
import { createMemoryLedgerPort } from '../ports/memory/ledger-port.js';
import { createTaskRoutes } from '../routes/tasks.js';
import { authorizedCaller, taskAuthorization } from '../testing/task-authorization.js';

import { createIncidentSkill } from './incident.js';
import { createSkillRegistry } from './registry.js';

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

describe('incident adapter', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(accepted.submittedAt));
  });

  afterEach(() => vi.useRealTimers());

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

  it('allows retry after a delivery timeout using the same task id', async () => {
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
    const routes = createTaskRoutes(
      createMemoryLedgerPort(),
      () => Promise.resolve({ sub: 'alice' } as Caller),
      registry,
      taskAuthorization,
    );
    const request = {
      method: 'POST',
      path: '/v1/tasks',
      headers: { 'idempotency-key': 'key-1' },
      body: Buffer.from(JSON.stringify({ kind: 'submit', ...submission })),
    };
    expect(await routes.submit(request)).toEqual({ status: 503, body: { error: 'unavailable' } });
    expect((await routes.submit(request)).status).toBe(200);
    expect(deliver.mock.calls[0][0].deliveryId).toBe(deliver.mock.calls[1][0].deliveryId);
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
