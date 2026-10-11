import { describe, expect, it } from 'vitest';

import type { ExporterPort } from './exporter-port.js';
import type { OutboxEvent } from '@agent-works/domain';

const event: OutboxEvent = {
  destination: 'audit',
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

export function exporterPortContract(create: () => ExporterPort): void {
  describe('ExporterPort', () => {
    it('exports an event once and dedupes by event id', async () => {
      const port = create();
      expect(await port.exportEvent(event)).toBe('exported');
      expect(await port.exportEvent(event)).toBe('duplicate');
      expect(
        await port.exportEvent({ ...event, event: { ...event.event, outcome: 'CHANGED' } }),
      ).toBe('duplicate');
    });
  });
}
