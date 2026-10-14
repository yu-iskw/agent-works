import { randomUUID } from 'node:crypto';

import type { EventTrigger } from './event-trigger.js';
import type { ScheduleSpec } from './schedule.js';
export function scheduleFixture(overrides: Partial<ScheduleSpec> = {}): ScheduleSpec {
  const at = '2026-10-14T10:00:00.000Z';
  return {
    id: randomUUID(),
    sponsor: {
      kind: 'human',
      sub: 'alice',
      enterpriseId: 'company',
      email: 'alice@company.example',
      groups: ['team-a'],
      groupsObservedAt: at,
    },
    purpose: 'Review incidents each hour',
    consentRef: 'consent-1',
    maxPrivilege: {
      scopes: ['ticket.create'],
      sources: ['incidents'],
      skill: { id: 'incident-analysis', version: '1.0.0' },
      classification: 'INTERNAL',
      regions: ['asia-northeast1'],
      budgetUsd: 1,
      deadlineSeconds: 300,
    },
    task: {
      objective: 'Review the incident',
      skillId: 'incident-analysis',
      input: { incidentId: 'inc-1' },
      sourceAllowlist: ['incidents'],
      requestedOutputs: ['ticket'],
      executionPolicy: { mode: 'offline', budgetUsd: 0.01, deadlineSeconds: 300 },
    },
    timing: { kind: 'interval', everySeconds: 60, anchor: at },
    timezone: 'UTC',
    allowedWindow: { weekdays: [0, 1, 2, 3, 4, 5, 6], start: '00:00', end: '00:00' },
    expiresAt: '2026-10-16T00:00:00.000Z',
    misfire: 'catch-up-once',
    revocation: { onRevocation: 'cancel-in-flight' },
    ...overrides,
  };
}
export function eventTriggerFixture(
  scheduleId: string,
  overrides: Partial<EventTrigger> = {},
): EventTrigger {
  return {
    id: randomUUID(),
    scheduleId,
    source: 'offline-incidents',
    signingKeyId: 'key-1',
    algorithm: 'HS256',
    replayWindowSeconds: 300,
    payloadSchema: {
      type: 'object',
      additionalProperties: false,
      properties: { incidentId: { type: 'string', required: true, maxLength: 100 } },
    },
    ...overrides,
  };
}
