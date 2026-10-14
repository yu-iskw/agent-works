import { describe, expect, it } from 'vitest';

import {
  approvedModelSchema,
  inferenceRecordSchema,
  modelKey,
  sameBoundary,
} from './model-policy.js';
const model = {
  modelId: 'fixture-gemini',
  version: 'offline-1',
  region: 'asia-northeast1',
  governanceZone: 'test',
};
describe('model identity contract', () => {
  it('pins every governance and geography coordinate in the model key', () => {
    for (const key of ['modelId', 'version', 'region', 'governanceZone'] as const)
      expect(modelKey({ ...model, [key]: 'other' })).not.toBe(modelKey(model));
  });
  it('rejects missing model id, version or region on each inference', () => {
    const record = {
      inferenceId: 'i',
      taskId: 't',
      traceId: 'tr',
      model,
      costClass: 'economy',
      ruleId: null,
      attempt: 0,
      status: 'started',
      occurredAt: '2026-10-14T00:00:00.000Z',
      estimatedCostMicros: 0,
    };
    expect(inferenceRecordSchema.safeParse(record).success).toBe(true);
    for (const key of ['modelId', 'version', 'region'] as const)
      expect(
        inferenceRecordSchema.safeParse({ ...record, model: { ...model, [key]: '' } }).success,
      ).toBe(false);
  });
  it('requires an approval reference and known cost class', () => {
    expect(
      approvedModelSchema.safeParse({ ...model, costClass: 'economy', approvalRef: 'fixture-only' })
        .success,
    ).toBe(true);
    expect(approvedModelSchema.safeParse({ ...model, costClass: 'free' }).success).toBe(false);
  });
  it('preserves both region and governance zone during fallback', () => {
    expect(sameBoundary(model, { ...model, modelId: 'other' })).toBe(true);
    expect(sameBoundary(model, { ...model, region: 'global' })).toBe(false);
    expect(sameBoundary(model, { ...model, governanceZone: 'external' })).toBe(false);
  });
});
