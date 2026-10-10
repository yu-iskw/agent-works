import { describe, expect, it } from 'vitest';

import { LedgerConflict } from './ledger-port.js';

import type { LedgerPort } from './ledger-port.js';
import type { OutboxEvent, TaskSubmit } from '@agent-works/domain';

const request: TaskSubmit = {
  objective: 'Summarize the runbook',
  skillId: 'ask',
  sourceAllowlist: ['drive'],
  requestedOutputs: ['answer'],
  executionPolicy: { mode: 'interactive', budgetUsd: 0.1, deadlineSeconds: 30 },
};

const event: OutboxEvent = {
  destination: 'work',
  event: {
    eventId: 'evt-1',
    eventType: 'task',
    schemaVersion: '1',
    occurredAt: '2026-10-10T10:00:00.000Z',
    taskId: 'task-1',
    stepId: 'submit',
    traceId: 'trace',
    initiatorSubject: 'alice',
    agentPrincipal: 'agent:memory',
    tool: null,
    policyDecisionId: null,
    approvalId: null,
    requestDigestSha256: null,
    outcome: 'SUCCESS',
    externalObjectRef: null,
    prevDigest: null,
  },
};

export function ledgerPortContract(create: () => LedgerPort): void {
  describe('LedgerPort', () => {
    it('returns the same accepted task for the same idempotency key', async () => {
      const port = create();
      const first = await port.submit(request, 'key-1');
      expect(await port.submit(request, 'key-1')).toEqual(first);
      expect(await port.read(first.taskId)).toMatchObject({
        id: first.taskId,
        status: 'QUEUED',
        version: 1,
      });
    });

    it('rejects a second body for the same idempotency key', async () => {
      const port = create();
      await port.submit(request, 'key-1');
      await expect(
        port.submit({ ...request, objective: 'A different objective' }, 'key-1'),
      ).rejects.toBeInstanceOf(LedgerConflict);
    });

    it('records an outbox event once and replays the same body', async () => {
      const port = create();
      expect(await port.append(event)).toBe('recorded');
      expect(await port.append(event)).toBe('replay');
      await expect(
        port.append({ ...event, event: { ...event.event, outcome: 'CHANGED' } }),
      ).rejects.toBeInstanceOf(LedgerConflict);
    });
  });
}
