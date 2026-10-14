import { describe, expect, it } from 'vitest';

import { approvedDefault, defaultIdentity } from '../model-routing/fixtures.js';

import type { ModelRoutingPort } from './model-routing.js';
import type {
  InferenceRecord,
  ModelRoutingAudit,
} from '../../../../packages/domain/dist/model-policy.js';
export function modelRoutingContract(factory: () => ModelRoutingPort): void {
  describe('model routing port contract', () => {
    const record = (id: string): InferenceRecord => ({
      inferenceId: id,
      taskId: id,
      traceId: 'trace',
      model: defaultIdentity,
      costClass: approvedDefault.costClass,
      ruleId: null,
      attempt: 0,
      status: 'started',
      occurredAt: '2026-10-14T00:00:00.000Z',
      estimatedCostMicros: 1,
    });
    it('persists pinned coordinates and isolates task queries', async () => {
      const port = factory();
      await port.start(record('identity'));
      await port.finish('identity', 'succeeded');
      expect(await port.inferences('identity')).toMatchObject([
        { model: defaultIdentity, status: 'succeeded' },
      ]);
      expect(await port.inferences('unrelated')).toEqual([]);
    });
    it('is idempotent for equal starts and rejects conflicting identities', async () => {
      const port = factory();
      await Promise.all([port.start(record('replay')), port.start(record('replay'))]);
      expect(await port.inferences('replay')).toHaveLength(1);
      await expect(
        Promise.resolve().then(() => port.start({ ...record('replay'), traceId: 'other' })),
      ).rejects.toThrow('identity conflict');
    });
    it('cannot rewrite terminal inference outcomes', async () => {
      const port = factory();
      await port.start(record('terminal'));
      await port.finish('terminal', 'failed');
      await port.finish('terminal', 'failed');
      await expect(
        Promise.resolve().then(() => port.finish('terminal', 'succeeded')),
      ).rejects.toThrow('terminal conflict');
    });
    it('rejects completion of an unknown inference', async () => {
      await expect(
        Promise.resolve().then(() => factory().finish('unknown', 'succeeded')),
      ).rejects.toThrow('unknown inference');
    });
    it('persists denial evidence idempotently', async () => {
      const port = factory();
      const event: ModelRoutingAudit = {
        eventId: 'audit',
        taskId: 'audit-task',
        traceId: 'trace',
        occurredAt: '2026-10-14T00:00:00.000Z',
        reason: 'not_allowlisted',
        requested: defaultIdentity,
        ruleId: null,
      };
      await port.audit(event);
      await port.audit(event);
      expect(await port.audits('audit-task')).toEqual([event]);
      await expect(
        Promise.resolve().then(() => port.audit({ ...event, reason: 'cross_zone' })),
      ).rejects.toThrow('audit identity conflict');
    });
  });
}
