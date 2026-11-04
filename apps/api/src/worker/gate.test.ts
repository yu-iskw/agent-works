import { describe, expect, test } from 'vitest';

import { trustedTestResolver } from '../broker/test-authority.js';
import { createMemorySuspensionLedger } from '../ports/memory/suspension-ledger.js';
import { createSuspensionEnforcer } from '../suspension/enforcement.js';
import {
  publishPins,
  scopeTargets,
  suspendCommand,
  testAt,
  testContext,
} from '../suspension/test-fixtures.js';

import { createAuthorityEffectGate } from './gate.js';

import type { AuthorityResolver } from '../broker/authority.js';

const effect = { key: 'eff-1', payloadDigest: 'a'.repeat(64), target: 'ticket.create' };
const identity = () =>
  Promise.resolve({
    authority: {
      claimedActor: 'alice',
      taskId: 'task-1',
      stepId: 'step-1',
      toolRef: 'ticket.create@1',
      targetResource: 'queue/support',
      approvalId: 'apr-1',
    },
    invocation: testContext,
  });

async function gateWith(resolver: AuthorityResolver) {
  const ledger = createMemorySuspensionLedger();
  await publishPins(ledger);
  const enforcer = createSuspensionEnforcer({ ledger, now: () => testAt });
  return {
    ledger,
    gate: createAuthorityEffectGate({ resolver, enforcer, identify: identity, now: () => testAt }),
  };
}

describe('per-effect authority gate', () => {
  test('allows when authority and suspension both allow', async () => {
    const { gate } = await gateWith(trustedTestResolver());
    await expect(gate.check('exec-1', effect)).resolves.toBeUndefined();
  });

  test('revoked authority is a denial', async () => {
    const { gate } = await gateWith(() => Promise.resolve({ kind: 'denied', reason: 'revoked' }));
    await expect(gate.check('exec-1', effect)).rejects.toMatchObject({
      failureClass: 'denied',
      errorClass: 'authority-denied',
    });
  });

  test('an unreadable authority store is retryable, not a denial', async () => {
    const { gate } = await gateWith(() => Promise.reject(new Error('down')));
    await expect(gate.check('exec-1', effect)).rejects.toMatchObject({
      failureClass: 'retryable',
      errorClass: 'authority-unavailable',
    });
  });

  test('a suspension between enqueue and effect denies', async () => {
    const { gate, ledger } = await gateWith(trustedTestResolver());
    await ledger.change(suspendCommand(scopeTargets[0]), 'operator', testAt);
    await expect(gate.check('exec-1', effect)).rejects.toMatchObject({
      failureClass: 'denied',
      errorClass: 'invocation-suspended',
    });
  });

  test('an unavailable suspension store is retryable', async () => {
    const { gate, ledger } = await gateWith(trustedTestResolver());
    ledger.snapshot = () => Promise.reject(new Error('offline'));
    await expect(gate.check('exec-1', effect)).rejects.toMatchObject({
      failureClass: 'retryable',
      errorClass: 'suspension-unavailable',
    });
  });
});
