import { createIncidents, createTicket, listen } from '@agent-works/fakes';
import { describe, expect, it, vi } from 'vitest';

import { Unavailable } from '../auth/iap.js';
import { createMemoryLedgerPort } from '../ports/memory/ledger-port.js';
import { createTaskRoutes } from '../routes/tasks.js';

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
  it('runs S1 delivery and replays without creating a second ticket', async () => {
    const incidents = await listen(createIncidents(), 0);
    const tickets = await listen(createTicket(), 0);
    const answer = vi.fn().mockResolvedValue('Incident summary');
    try {
      const skill = createIncidentSkill(() => ({
        incidentsUrl: incidents.url,
        ticketsUrl: tickets.url,
        model: { answer },
      }));
      await skill.dispatch(submission, accepted);
      await skill.dispatch(submission, accepted);
      expect(answer).toHaveBeenCalledExactlyOnceWith(expect.stringContaining('inc-1'));
      const response = await fetch(`${tickets.url}/tickets`);
      expect(await response.json()).toEqual({
        tickets: [
          {
            id: 'FAKE-1',
            summary: 'Incident summary',
            project: 'incidents',
            idempotencyKey: 'task-1',
          },
        ],
      });
    } finally {
      await Promise.all([incidents.close(), tickets.close()]);
    }
  });

  it('reports missing configuration without delivering', async () => {
    const deliver = vi.fn();
    const skill = createIncidentSkill(() => undefined, deliver);
    await expect(skill.dispatch(submission, accepted)).rejects.toBeInstanceOf(Unavailable);
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
});
