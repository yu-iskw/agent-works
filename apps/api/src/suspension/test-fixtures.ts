import { randomUUID } from 'node:crypto';

import type { AdminCommand, SuspensionLedger } from '../ports/suspension-ledger.js';
import type { CapabilityPin, SuspensionTarget } from '@agent-works/domain';
import type { InvocationContext } from '@agent-works/policy';

export const testAt = new Date('2026-10-14T10:00:00.000Z');
export const testContext: InvocationContext = {
  subject: 'alice',
  teams: ['engineering'],
  agent: { kind: 'agent', id: 'api', version: '1' },
  skill: { kind: 'skill', id: 'incident', version: '1' },
  tool: { kind: 'tool', id: 'ticket.create', version: '1' },
  model: 'gemini',
  taskId: 'task-1',
  traceId: 'trace-1',
};
export const scopeTargets: readonly SuspensionTarget[] = [
  { scope: 'global', id: '*', version: null },
  { scope: 'team', id: 'engineering', version: null },
  { scope: 'user', id: 'alice', version: null },
  { scope: 'agent', id: 'api', version: '1' },
  { scope: 'skill', id: 'incident', version: '1' },
  { scope: 'model', id: 'gemini', version: null },
  { scope: 'tool', id: 'ticket.create', version: '1' },
];
export function suspendCommand(target: SuspensionTarget, expectedRevision = 0): AdminCommand {
  return {
    kind: 'suspension',
    command: {
      commandId: randomUUID(),
      action: 'suspend',
      target,
      reason: 'Local operator test',
      expiresAt: null,
      expectedRevision,
    },
  };
}
export function versionCommand(
  pin: CapabilityPin,
  state: 'draft' | 'published' | 'deprecated' | 'revoked',
  expectedRevision: number,
): AdminCommand {
  return {
    kind: 'version',
    command: { commandId: randomUUID(), pin, state, reason: 'Release test', expectedRevision },
  };
}
export async function publishPins(
  ledger: SuspensionLedger,
  pins: readonly CapabilityPin[] = [
    testContext.agent,
    testContext.skill,
    testContext.tool as CapabilityPin,
  ],
): Promise<void> {
  for (const pin of pins) {
    await ledger.change(versionCommand(pin, 'draft', 0), 'operator', testAt);
    await ledger.change(versionCommand(pin, 'published', 1), 'operator', testAt);
  }
}
