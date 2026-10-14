import type { AcceptTask } from '../ports/dispatch-port.js';
import type { AuditEvent } from '@agent-works/domain';

export const fixtureInstant = '2026-10-10T10:00:00.000Z';
export const fixtureRequest: AcceptTask = {
  subject: 'alice',
  idempotencyKey: 'fixture-accept',
  request: {
    objective: 'Non-sensitive fixture',
    skillId: 'ask',
    sourceAllowlist: ['drive'],
    requestedOutputs: ['answer'],
    executionPolicy: { mode: 'interactive', budgetUsd: 0.1, deadlineSeconds: 300 },
  },
  policy: {
    effect: 'allow',
    decisionId: '6f1e2d3c-4b5a-4968-8c7d-6e5f4a3b2c1d',
    policyVersion: '1',
  },
  agent: { kind: 'agent', agentId: 'fixture-agent', version: '1', identityRef: 'agent://fixture' },
  deadline: '2026-10-10T10:05:00.000Z',
  context: {
    userSubject: 'alice',
    enterpriseId: 'fixture',
    authorizedGroups: ['employees'],
    groupsObservedAt: fixtureInstant,
    allowedSources: ['drive'],
    taskPurpose: 'ask',
    classificationCeiling: 'INTERNAL',
    allowedRegions: ['us'],
    resultCountLimit: 3,
  },
};
export function auditFixture(index = 0): AuditEvent {
  return {
    eventId: `fixture-event-${index}`,
    eventType: 'tool.completed',
    schemaVersion: '1',
    occurredAt: fixtureInstant,
    taskId: `fixture-task-${index}`,
    stepId: 'write',
    traceId: `fixture-trace-${index}`,
    initiatorSubject: 'alice',
    agentPrincipal: 'agent://fixture',
    tool: 'ticket.create',
    policyDecisionId: 'fixture-policy',
    approvalId: 'fixture-approval',
    requestDigestSha256: 'a'.repeat(64),
    outcome: 'SUCCESS',
    externalObjectRef: `FAKE-${index}`,
    prevDigest: null,
  };
}
