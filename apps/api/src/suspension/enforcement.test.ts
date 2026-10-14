import { describe, expect, test, vi } from 'vitest';

import { createMemorySuspensionLedger } from '../ports/memory/suspension-ledger.js';

import { createSuspensionEnforcer, InvocationStopped } from './enforcement.js';
import {
  publishPins,
  scopeTargets,
  suspendCommand,
  testAt,
  testContext,
  versionCommand,
} from './test-fixtures.js';

describe('per-invocation enforcement', () => {
  test.each(scopeTargets)(
    '$scope denies new tool and model calls with a preserved audit record; resume allows',
    async (target) => {
      const ledger = createMemorySuspensionLedger();
      await publishPins(ledger);
      const enforcer = createSuspensionEnforcer({ ledger, now: () => testAt });
      await ledger.change(suspendCommand(target), 'operator', testAt);
      for (const kind of ['tool', 'model'] as const) {
        await expect(enforcer.check(testContext, kind)).rejects.toMatchObject({
          code: 'INVOCATION_SUSPENDED',
        });
      }
      const history = await ledger.history();
      expect(history.filter((event) => event.eventType === 'invocation.denied')).toHaveLength(2);
      expect(history.at(-1)).toMatchObject({
        actorSub: 'alice',
        taskId: 'task-1',
        reason: 'INVOCATION_SUSPENDED',
      });
      const resume = suspendCommand(target, 1);
      if (resume.kind !== 'suspension') throw new Error('fixture');
      await ledger.change(
        { kind: 'suspension', command: { ...resume.command, action: 'resume' } },
        'operator',
        testAt,
      );
      await expect(enforcer.check(testContext, 'model')).resolves.toBeUndefined();
      await expect(enforcer.check(testContext, 'tool')).resolves.toBeUndefined();
      expect(history.find((event) => event.eventType === 'admin.suspend')).toBeDefined();
    },
  );
  test('unreachable snapshot fails closed and uses independent emergency audit', async () => {
    const ledger = createMemorySuspensionLedger();
    ledger.snapshot = () => Promise.reject(new Error('offline'));
    ledger.deny = () => Promise.reject(new Error('offline'));
    const emergencyAudit = vi.fn().mockResolvedValue(undefined);
    const enforcer = createSuspensionEnforcer({ ledger, emergencyAudit, now: () => testAt });
    await expect(enforcer.check(testContext, 'tool')).rejects.toMatchObject({
      code: 'SUSPENSION_STORE_UNAVAILABLE',
    });
    expect(emergencyAudit).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ reason: 'SUSPENSION_STORE_UNAVAILABLE' }),
    );
  });
  test('corrupt store data fails closed', async () => {
    const ledger = createMemorySuspensionLedger();
    ledger.snapshot = () =>
      Promise.resolve({ suspensions: [], versions: [{ pin: null }] } as never);
    await expect(
      createSuspensionEnforcer({ ledger }).check(testContext, 'model'),
    ).rejects.toBeInstanceOf(InvocationStopped);
  });
  test('expired suspension allows at the exact expiry boundary and preserves history', async () => {
    const ledger = createMemorySuspensionLedger();
    await publishPins(ledger);
    const input = suspendCommand(scopeTargets[0]);
    if (input.kind !== 'suspension') throw new Error('fixture');
    const expiry = new Date(testAt.getTime() + 1000);
    await ledger.change(
      { kind: 'suspension', command: { ...input.command, expiresAt: expiry.toISOString() } },
      'operator',
      testAt,
    );
    await expect(
      createSuspensionEnforcer({ ledger, now: () => testAt }).check(testContext, 'model'),
    ).rejects.toThrow('INVOCATION_SUSPENDED');
    await expect(
      createSuspensionEnforcer({ ledger, now: () => expiry }).check(testContext, 'model'),
    ).resolves.toBeUndefined();
    expect((await ledger.snapshot()).suspensions[0].suspended).toBe(true);
  });
  test.each(['agent', 'skill', 'tool'] as const)(
    'a pinned %s version revoked mid-task stops before the next side effect',
    async (kind) => {
      const ledger = createMemorySuspensionLedger();
      await publishPins(ledger);
      const enforcer = createSuspensionEnforcer({ ledger, now: () => testAt });
      const write = vi.fn();
      await enforcer.check(testContext, 'tool');
      write('completed receipt');
      const pin =
        kind === 'agent'
          ? testContext.agent
          : kind === 'skill'
            ? testContext.skill
            : testContext.tool;
      if (pin === undefined) throw new Error('fixture');
      await ledger.change(versionCommand(pin, 'revoked', 2), 'operator', testAt);
      await expect(enforcer.check(testContext, 'tool')).rejects.toThrow(
        'CAPABILITY_VERSION_REVOKED',
      );
      await expect(enforcer.check(testContext, 'model')).rejects.toThrow(
        'CAPABILITY_VERSION_REVOKED',
      );
      expect(write).toHaveBeenCalledExactlyOnceWith('completed receipt');
    },
  );
  test('unpublished versions and missing trusted context default deny', async () => {
    const ledger = createMemorySuspensionLedger();
    const enforcer = createSuspensionEnforcer({ ledger });
    await expect(enforcer.check(testContext, 'tool')).rejects.toThrow(
      'CAPABILITY_VERSION_UNPUBLISHED',
    );
    await expect(enforcer.check({ ...testContext, subject: '' }, 'tool')).rejects.toThrow(
      'SUSPENSION_CONTEXT_MISSING',
    );
  });
});

test('both audit transports unavailable still produces the controlled fail-closed error', async () => {
  const ledger = createMemorySuspensionLedger();
  ledger.snapshot = () => Promise.reject(new Error('offline'));
  ledger.deny = () => Promise.reject(new Error('audit offline'));
  const enforcer = createSuspensionEnforcer({
    ledger,
    emergencyAudit: () => Promise.reject(new Error('outbox offline')),
  });
  await expect(enforcer.check(testContext, 'model')).rejects.toMatchObject({
    code: 'SUSPENSION_STORE_UNAVAILABLE',
  });
});

test('suspensions for unrelated teams, users, models and immutable versions preserve active calls', async () => {
  const ledger = createMemorySuspensionLedger();
  await publishPins(ledger);
  for (const target of [
    { scope: 'team', id: 'sales', version: null },
    { scope: 'user', id: 'bob', version: null },
    { scope: 'model', id: 'other-model', version: null },
    { scope: 'skill', id: 'incident', version: '2' },
    { scope: 'tool', id: 'ticket.create', version: '2' },
  ] as const)
    await ledger.change(suspendCommand(target), 'operator', testAt);
  const enforcer = createSuspensionEnforcer({ ledger, now: () => testAt });
  await expect(enforcer.check(testContext, 'tool')).resolves.toBeUndefined();
  await expect(enforcer.check(testContext, 'model')).resolves.toBeUndefined();
  expect(
    (await ledger.history()).filter((event) => event.eventType === 'invocation.denied'),
  ).toEqual([]);
});

test('revoking an unpinned version does not migrate or stop a pinned published task', async () => {
  const ledger = createMemorySuspensionLedger();
  await publishPins(ledger);
  const other = { ...testContext.skill, version: '2' };
  await ledger.change(versionCommand(other, 'draft', 0), 'operator', testAt);
  await ledger.change(versionCommand(other, 'revoked', 1), 'operator', testAt);
  const enforcer = createSuspensionEnforcer({ ledger, now: () => testAt });
  await expect(enforcer.check(testContext, 'model')).resolves.toBeUndefined();
  await expect(enforcer.check({ ...testContext, skill: other }, 'model')).rejects.toThrow(
    'CAPABILITY_VERSION_REVOKED',
  );
  expect(testContext.skill.version).toBe('1');
});

test('a corrupt suspension record is denied even when it claims to be inactive', async () => {
  const ledger = createMemorySuspensionLedger();
  await publishPins(ledger);
  const valid = await ledger.snapshot();
  ledger.snapshot = () =>
    Promise.resolve({ ...valid, suspensions: [{ suspended: false }] } as never);
  await expect(createSuspensionEnforcer({ ledger }).check(testContext, 'tool')).rejects.toThrow(
    'SUSPENSION_STORE_UNAVAILABLE',
  );
});
