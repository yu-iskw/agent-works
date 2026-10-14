import { randomUUID } from 'node:crypto';

import { capabilityVersionHash, suspensionHash } from '@agent-works/domain';
import { describe, expect, test } from 'vitest';

import {
  scopeTargets,
  suspendCommand,
  testAt,
  testContext,
  versionCommand,
} from '../suspension/test-fixtures.js';

import { SuspensionConflict } from './suspension-ledger.js';

import type { SuspensionLedger } from './suspension-ledger.js';

export function suspensionLedgerContract(make: () => SuspensionLedger): void {
  describe('suspension ledger shared contract', () => {
    test.each(scopeTargets)(
      '$scope suspend and resume preserve immutable history',
      async (target) => {
        const ledger = make();
        const suspended = await ledger.change(suspendCommand(target), 'operator', testAt);
        expect(suspended.record).toMatchObject({
          target,
          suspended: true,
          actorSub: 'operator',
          revision: 1,
        });
        const resume = suspendCommand(target, 1);
        if (resume.kind !== 'suspension') throw new Error('fixture');
        const resumed = await ledger.change(
          { kind: 'suspension', command: { ...resume.command, action: 'resume' } },
          'operator-2',
          testAt,
        );
        expect(resumed.record).toMatchObject({ target, suspended: false, revision: 2 });
        const snapshot = await ledger.snapshot();
        expect(snapshot.suspensions).toEqual([resumed.record]);
        const history = await ledger.history();
        expect(history).toHaveLength(2);
        expect(history.map((event) => event.eventType)).toEqual(['admin.suspend', 'admin.resume']);
        if (!('target' in suspended.record)) throw new Error('fixture');
        expect(history[0].digest).toBe(suspensionHash(suspended.record));
      },
    );
    test('retry of the same command returns original result and exactly one audit event', async () => {
      const ledger = make();
      const command = suspendCommand(scopeTargets[0]);
      const result = await ledger.change(command, 'operator', testAt);
      expect(await ledger.change(command, 'operator', new Date(testAt.getTime() + 1000))).toEqual({
        ...result,
        replay: true,
      });
      expect(await ledger.history()).toHaveLength(1);
    });
    test('reused command ID cannot change target, payload or actor', async () => {
      const ledger = make();
      const command = suspendCommand(scopeTargets[0]);
      await ledger.change(command, 'operator', testAt);
      await expect(ledger.change(command, 'other', testAt)).rejects.toBeInstanceOf(
        SuspensionConflict,
      );
      if (command.kind !== 'suspension') throw new Error('fixture');
      await expect(
        ledger.change(
          { kind: 'suspension', command: { ...command.command, reason: 'changed' } },
          'operator',
          testAt,
        ),
      ).rejects.toBeInstanceOf(SuspensionConflict);
      expect(await ledger.history()).toHaveLength(1);
    });
    test('optimistic revision prevents a stale resume undoing a new suspension', async () => {
      const ledger = make();
      await ledger.change(suspendCommand(scopeTargets[0]), 'operator', testAt);
      await expect(
        ledger.change(suspendCommand(scopeTargets[0]), 'operator', testAt),
      ).rejects.toBeInstanceOf(SuspensionConflict);
      expect(await ledger.history()).toHaveLength(1);
    });
    test('concurrent mutations produce one state revision and one audit event', async () => {
      const ledger = make();
      const results = await Promise.allSettled([
        ledger.change(suspendCommand(scopeTargets[0]), 'operator', testAt),
        ledger.change(suspendCommand(scopeTargets[0]), 'operator', testAt),
      ]);
      expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
      expect(await ledger.history()).toHaveLength(1);
    });
    test.each(['draft', 'published', 'deprecated', 'revoked'] as const)(
      'cannot create an initial %s except draft',
      async (state) => {
        const ledger = make();
        const pending = ledger.change(
          versionCommand(testContext.skill, state, 0),
          'operator',
          testAt,
        );
        if (state === 'draft') await expect(pending).resolves.toMatchObject({ record: { state } });
        else await expect(pending).rejects.toBeInstanceOf(SuspensionConflict);
        expect(await ledger.history()).toHaveLength(state === 'draft' ? 1 : 0);
      },
    );
    test('capability lifecycle is monotonic and revoked versions are permanent', async () => {
      const ledger = make();
      for (const [index, state] of (
        ['draft', 'published', 'deprecated', 'revoked'] as const
      ).entries()) {
        await ledger.change(versionCommand(testContext.skill, state, index), 'operator', testAt);
      }
      const snapshot = await ledger.snapshot();
      expect(snapshot.versions[0]).toMatchObject({ state: 'revoked', revision: 4 });
      expect((await ledger.history())[3].digest).toBe(capabilityVersionHash(snapshot.versions[0]));
      await expect(
        ledger.change(versionCommand(testContext.skill, 'published', 4), 'operator', testAt),
      ).rejects.toBeInstanceOf(SuspensionConflict);
      expect(await ledger.history()).toHaveLength(4);
    });
    test('past expiry and missing resume target leave no partial audit or state', async () => {
      const ledger = make();
      const command = suspendCommand(scopeTargets[0]);
      if (command.kind !== 'suspension') throw new Error('fixture');
      await expect(
        ledger.change(
          { kind: 'suspension', command: { ...command.command, expiresAt: testAt.toISOString() } },
          'operator',
          testAt,
        ),
      ).rejects.toBeInstanceOf(SuspensionConflict);
      await expect(
        ledger.change(
          { kind: 'suspension', command: { ...command.command, action: 'resume' } },
          'operator',
          testAt,
        ),
      ).rejects.toBeInstanceOf(SuspensionConflict);
      expect(await ledger.snapshot()).toEqual({ suspensions: [], versions: [] });
      expect(await ledger.history()).toEqual([]);
    });
    test('denial event writes once, is immutable and cannot collide with a command', async () => {
      const ledger = make();
      const event = {
        eventId: randomUUID(),
        eventType: 'invocation.denied' as const,
        actorSub: 'alice',
        occurredAt: testAt.toISOString(),
        reason: 'INVOCATION_SUSPENDED',
        digest: 'a'.repeat(64),
        taskId: 'task',
        traceId: 'trace',
        details: {},
      };
      await ledger.deny(event);
      await ledger.deny(event);
      await expect(ledger.deny({ ...event, actorSub: 'bob' })).rejects.toBeInstanceOf(
        SuspensionConflict,
      );
      expect(await ledger.history()).toEqual([event]);
      const command = suspendCommand(scopeTargets[0]);
      await expect(
        ledger.change(
          {
            ...command,
            command: { ...command.command, commandId: event.eventId },
          } as typeof command,
          'operator',
          testAt,
        ),
      ).rejects.toBeInstanceOf(SuspensionConflict);
    });
    test('returned records cannot mutate persistent state or history', async () => {
      const ledger = make();
      const result = await ledger.change(suspendCommand(scopeTargets[0]), 'operator', testAt);
      result.record.reason = 'mutated';
      const snapshot = await ledger.snapshot();
      snapshot.suspensions[0].target.id = 'mutated';
      const history = await ledger.history();
      (history as unknown as { reason: string }[])[0].reason = 'mutated';
      expect((await ledger.snapshot()).suspensions[0]).toMatchObject({
        reason: 'Local operator test',
        target: { id: '*' },
      });
      expect((await ledger.history())[0].reason).toBe('Local operator test');
    });
    test('invalid denial records cannot fabricate admin events or corrupt audit history', async () => {
      const ledger = make();
      const event = {
        eventId: randomUUID(),
        eventType: 'invocation.denied' as const,
        actorSub: 'alice',
        occurredAt: testAt.toISOString(),
        reason: 'INVOCATION_SUSPENDED',
        digest: 'a'.repeat(64),
        taskId: 'task',
        traceId: 'trace',
        details: { kind: 'tool' },
      };
      await expect(ledger.deny({ ...event, eventType: 'admin.suspend' })).rejects.toBeInstanceOf(
        SuspensionConflict,
      );
      await expect(ledger.deny({ ...event, digest: 'invalid' })).rejects.toThrow();
      await expect(ledger.deny({ ...event, occurredAt: 'invalid' })).rejects.toThrow();
      await expect(ledger.deny({ ...event, details: { invalid: undefined } })).rejects.toThrow();
      expect(await ledger.history()).toEqual([]);
      expect(await ledger.snapshot()).toEqual({ suspensions: [], versions: [] });
      await ledger.deny(event);
      expect(await ledger.history()).toEqual([event]);
    });
  });
}
