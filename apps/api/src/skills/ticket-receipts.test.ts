import { createIncidents, createTicket, listen } from '@agent-works/fakes';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { acceptInput } from '../ports/dispatch-port.contract.js';
import { createMemoryTaskPorts } from '../ports/memory/task-ports.js';

import { createIncidentSkill } from './incident.js';
import { createSkillRegistry } from './registry.js';
import { createTaskDispatcher, receiptFor } from './task-dispatcher.js';
import { createTicketReconciler } from './ticket-receipts.js';

const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of closers.splice(0).reverse()) await close();
  vi.unstubAllGlobals();
});

async function delivery() {
  const ports = createMemoryTaskPorts();
  await ports.dispatch.accept({
    ...acceptInput,
    request: { ...acceptInput.request, skillId: 'incident-analysis' },
  });
  const claimed = await ports.dispatch.claim('worker', 60_000);
  if (claimed === undefined) throw new Error('delivery');
  return claimed;
}

describe('ticket receipt reconciliation', () => {
  it('finds the original receipt by task idempotency key', async () => {
    const tickets = await listen(createTicket(), 0);
    closers.push(tickets.close);
    const claimed = await delivery();
    const response = await fetch(`${tickets.url}/tickets`, {
      method: 'POST',
      headers: { 'idempotency-key': claimed.taskId },
      body: JSON.stringify({ summary: 'original', project: 'incidents' }),
    });
    expect(response.status).toBe(200);
    const recovered = await createTicketReconciler(tickets.url)(
      claimed,
      new AbortController().signal,
    );
    expect(recovered).toEqual(receiptFor(claimed.taskId, 'FAKE-1'));
  });

  it('returns absence only for a valid, available receipt store', async () => {
    const tickets = await listen(createTicket(), 0);
    closers.push(tickets.close);
    expect(
      await createTicketReconciler(tickets.url)(await delivery(), new AbortController().signal),
    ).toBeUndefined();
  });

  it.each([
    { status: 503, body: { tickets: [] } },
    { status: 200, body: { wrong: [] } },
    { status: 200, body: { tickets: [{ idempotencyKey: 'replace-task', id: '' }] } },
  ])('fails closed for unavailable or invalid receipts: $status', async ({ status, body }) => {
    const claimed = await delivery();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json(body, { status })));
    const candidate = { ...claimed, taskId: 'replace-task' };
    await expect(
      createTicketReconciler('https://tickets.test')(candidate, new AbortController().signal),
    ).rejects.toThrow();
  });

  it('recovers a real incident write using a fresh skill and worker after completion failure', async () => {
    const incidents = await listen(createIncidents(), 0);
    const tickets = await listen(createTicket(), 0);
    closers.push(incidents.close, tickets.close);
    const ports = createMemoryTaskPorts();
    const input = {
      ...acceptInput,
      agent: {
        kind: 'agent' as const,
        agentId: 'incident-analysis',
        version: '1.0.0',
        identityRef: 'agent://incident-analysis',
      },
      deadline: new Date(Date.now() + 30_000).toISOString(),
      request: { ...acceptInput.request, skillId: 'incident-analysis' },
    };
    const accepted = await ports.dispatch.accept(input);
    const answer = vi.fn().mockResolvedValue('summary');
    const config = () => ({
      incidentsUrl: incidents.url,
      ticketsUrl: tickets.url,
      model: { answer },
    });
    const transition = ports.ledger.transition.bind(ports.ledger);
    const faultyLedger = {
      ...ports.ledger,
      transition: vi
        .fn<typeof transition>()
        .mockImplementation((command) =>
          command.to === 'COMPLETED'
            ? Promise.reject(new Error('crash after external write'))
            : transition(command),
        ),
    };
    const reconcile = createTicketReconciler(tickets.url);
    await createTaskDispatcher({
      dispatch: ports.dispatch,
      ledger: faultyLedger,
      registry: createSkillRegistry([createIncidentSkill(config)]),
      reconcile,
      retryMs: 1,
    }).runOnce();
    expect(await ports.ledger.read('alice', accepted.taskId)).toMatchObject({ status: 'RUNNING' });
    expect(answer).toHaveBeenCalledOnce();
    await vi.waitFor(async () => {
      await createTaskDispatcher({
        ...ports,
        registry: createSkillRegistry([createIncidentSkill(config)]),
        reconcile,
      }).runOnce();
      expect(await ports.ledger.read('alice', accepted.taskId)).toMatchObject({
        status: 'COMPLETED',
      });
    });
    expect(answer).toHaveBeenCalledOnce();
    expect(await ports.ledger.readReceipt('alice', accepted.taskId)).toEqual(
      receiptFor(accepted.taskId, 'FAKE-1'),
    );
    const body: unknown = await (await fetch(`${tickets.url}/tickets`)).json();
    expect(body).toMatchObject({
      tickets: [expect.objectContaining({ id: 'FAKE-1', idempotencyKey: accepted.taskId })],
    });
  });
});
