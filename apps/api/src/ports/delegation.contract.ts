import { describe, expect, it } from 'vitest';

import { fixtureLimits } from '../delegation/fixtures.js';

import type { DelegationPort } from './delegation.js';
import type {
  DelegationEdge,
  DelegationAudit,
} from '../../../../packages/domain/dist/delegation.js';
export function delegationContract(factory: () => DelegationPort): void {
  describe('delegation port contract', () => {
    const edge = (id: string): DelegationEdge => ({
      childTaskId: id,
      parentTaskId: `parent-${id}`,
      rootTaskId: 'root',
      traceId: 'trace',
      depth: 1,
      delegatedAuthorityHash: 'a'.repeat(64),
      budgetShare: fixtureLimits,
      state: 'pending',
      resultDigest: null,
      verifierRef: null,
      occurredAt: '2026-10-14T00:00:00.000Z',
    });
    it('persists lineage, authority hash and budget share', async () => {
      const port = factory();
      await port.create(edge('lineage'));
      expect(await port.read('lineage')).toEqual(edge('lineage'));
      expect(await port.children('parent-lineage')).toHaveLength(1);
      expect(await port.children('unrelated')).toEqual([]);
    });
    it('atomically rejects competing parent identities', async () => {
      const port = factory();
      const outcomes = await Promise.allSettled([
        port.create(edge('race')),
        Promise.resolve().then(() => port.create({ ...edge('race'), parentTaskId: 'other' })),
      ]);
      expect(outcomes.filter((row) => row.status === 'fulfilled')).toHaveLength(1);
      expect(outcomes.filter((row) => row.status === 'rejected')).toHaveLength(1);
    });
    it('requires verifier and digest before verified state', async () => {
      const port = factory();
      await port.create(edge('verify'));
      await expect(
        Promise.resolve().then(() => port.settle('verify', 'verified', null, null)),
      ).rejects.toThrow('verification evidence');
      await port.settle('verify', 'verified', 'b'.repeat(64), 'independent');
      expect(await port.read('verify')).toMatchObject({
        state: 'verified',
        verifierRef: 'independent',
      });
    });
    it('cannot rehabilitate a rejected child or change its digest', async () => {
      const port = factory();
      await port.create(edge('reject'));
      await port.settle('reject', 'rejected', 'b'.repeat(64), 'verifier');
      await port.settle('reject', 'rejected', 'b'.repeat(64), 'verifier');
      await expect(
        Promise.resolve().then(() => port.settle('reject', 'verified', 'b'.repeat(64), 'verifier')),
      ).rejects.toThrow('terminal conflict');
    });
    it('rejects settlement of unknown child', async () => {
      await expect(
        Promise.resolve().then(() => factory().settle('missing', 'failed', null, null)),
      ).rejects.toThrow('unknown delegation');
    });
    it('records denial evidence without result content', async () => {
      const port = factory();
      const event: DelegationAudit = {
        eventId: 'denied',
        parentTaskId: 'parent-audit',
        childTaskId: 'disabled-child',
        traceId: 'trace',
        occurredAt: '2026-10-14T00:00:00.000Z',
        reason: 'disabled',
      };
      await port.audit(event);
      await port.audit(event);
      expect(await port.audits('parent-audit')).toEqual([event]);
      await expect(
        Promise.resolve().then(() => port.audit({ ...event, reason: 'depth' })),
      ).rejects.toThrow('identity conflict');
    });
  });
}
