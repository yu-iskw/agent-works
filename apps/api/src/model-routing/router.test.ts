import { describe, expect, it, vi } from 'vitest';

import { createMemoryModelRoutingPort } from '../ports/memory/model-routing.js';

import { memoryBenchmarks } from './benchmark.js';
import { ModelRoutingDenied, RetryableModelFailure } from './errors.js';
import {
  approvedDefault,
  approvedFast,
  benchmarkFixture,
  defaultIdentity,
  fastIdentity,
  fixtureRule,
  inferenceContext,
} from './fixtures.js';
import { createModelRouter } from './router.js';

import type { ModelPolicy } from './policy.js';
function world(
  policy: ModelPolicy = {
    defaultModel: defaultIdentity,
    allowlist: [approvedDefault, approvedFast],
    rules: [fixtureRule],
  },
) {
  const records = createMemoryModelRoutingPort();
  const benchmarks = memoryBenchmarks(
    benchmarkFixture('baseline'),
    new Map([['routing-candidate.json', benchmarkFixture('candidate')]]),
  );
  return { records, router: createModelRouter({ policy, records, benchmarks }) };
}
describe('offline approved model routing', () => {
  it('denies a model outside the approved allowlist with durable audit before dispatch', async () => {
    const w = world({ defaultModel: fastIdentity, allowlist: [approvedDefault], rules: [] });
    const execute = vi.fn();
    await expect(w.router.run(inferenceContext, execute)).rejects.toBeInstanceOf(
      ModelRoutingDenied,
    );
    expect(execute).not.toHaveBeenCalled();
    expect(await w.records.inferences('routing-task')).toEqual([]);
    expect(await w.records.audits('routing-task')).toMatchObject([
      { reason: 'not_allowlisted', requested: fastIdentity },
    ]);
  });
  it.each(['governanceZone', 'region'] as const)(
    'denies cross-boundary fallback (%s) with audit',
    async (coordinate) => {
      const fallback = { ...defaultIdentity, [coordinate]: 'outside' };
      const w = world({
        defaultModel: defaultIdentity,
        allowlist: [approvedDefault, approvedFast, { ...approvedDefault, ...fallback }],
        rules: [{ ...fixtureRule, fallbacks: [fallback] }],
      });
      const execute = vi.fn();
      await expect(w.router.run(inferenceContext, execute)).rejects.toThrow('cross_');
      expect(execute).not.toHaveBeenCalled();
      expect(await w.records.audits('routing-task')).toHaveLength(1);
    },
  );
  it('records full pinned identity for every failed and successful inference attempt', async () => {
    const w = world();
    const execute = vi
      .fn()
      .mockRejectedValueOnce(new RetryableModelFailure())
      .mockResolvedValueOnce('result');
    await expect(w.router.run(inferenceContext, execute)).resolves.toBe('result');
    expect(await w.records.inferences('routing-task')).toMatchObject([
      { model: fastIdentity, status: 'failed', attempt: 0 },
      { model: defaultIdentity, status: 'succeeded', attempt: 1 },
    ]);
  });
  it('uses the single default model when a rule has no benchmark artifact', async () => {
    const w = world({
      defaultModel: defaultIdentity,
      allowlist: [approvedDefault, approvedFast],
      rules: [{ ...fixtureRule, benchmarkArtifact: undefined }],
    });
    const execute = vi.fn(() => Promise.resolve('result'));
    await w.router.run(inferenceContext, execute);
    expect(execute.mock.calls[0]).toBeDefined();
    expect(await w.records.inferences('routing-task')).toMatchObject([
      { model: defaultIdentity, ruleId: null },
    ]);
    expect(await w.records.audits('routing-task')).toMatchObject([
      { reason: 'benchmark_disabled' },
    ]);
  });
  it('does not fallback on policy, validation or suspension failures', async () => {
    const w = world();
    const execute = vi.fn(() => Promise.reject(new Error('suspended')));
    await expect(w.router.run(inferenceContext, execute)).rejects.toThrow('suspended');
    expect(execute).toHaveBeenCalledOnce();
  });
  it('fails closed if inference evidence cannot be persisted', async () => {
    const w = world();
    const execute = vi.fn();
    const records = { ...w.records, start: () => Promise.reject(new Error('audit unavailable')) };
    const router = createModelRouter({
      policy: { defaultModel: defaultIdentity, allowlist: [approvedDefault], rules: [] },
      records,
      benchmarks: { enabled: () => Promise.resolve(false) },
    });
    await expect(router.run(inferenceContext, execute)).rejects.toThrow('audit unavailable');
    expect(execute).not.toHaveBeenCalled();
  });
  it('audits fallback exhaustion without inventing another model', async () => {
    const w = world();
    const execute = vi.fn(() => Promise.reject(new RetryableModelFailure()));
    await expect(w.router.run(inferenceContext, execute)).rejects.toThrow('fallback_exhausted');
    expect(execute).toHaveBeenCalledTimes(2);
    expect(await w.records.audits('routing-task')).toMatchObject([
      { reason: 'fallback_exhausted' },
    ]);
  });
});

it('keeps an attached inferior benchmark disabled and records the default inference', async () => {
  const candidate = benchmarkFixture('candidate') as {
    metrics: { citationPrecision: { numerator: number; denominator: number; value: number } };
  };
  candidate.metrics.citationPrecision.numerator = 0;
  candidate.metrics.citationPrecision.value = 0;
  const records = createMemoryModelRoutingPort();
  const router = createModelRouter({
    policy: {
      defaultModel: defaultIdentity,
      allowlist: [approvedDefault, approvedFast],
      rules: [fixtureRule],
    },
    records,
    benchmarks: memoryBenchmarks(
      benchmarkFixture('baseline'),
      new Map([['routing-candidate.json', candidate]]),
    ),
  });
  const execute = vi.fn(() => Promise.resolve('default result'));
  await expect(router.run(inferenceContext, execute)).resolves.toBe('default result');
  expect(await records.inferences('routing-task')).toMatchObject([
    { model: defaultIdentity, ruleId: null },
  ]);
  expect(await records.audits('routing-task')).toMatchObject([{ reason: 'benchmark_disabled' }]);
  expect(execute).toHaveBeenCalledOnce();
});
