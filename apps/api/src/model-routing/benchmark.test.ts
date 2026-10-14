import { expect, it } from 'vitest';

import { benchmarkPasses } from '../../../../packages/domain/dist/model-policy-benchmark.js';

import { fileBenchmarks, memoryBenchmarks } from './benchmark.js';
import { benchmarkFixture, fastIdentity, fixtureRule } from './fixtures.js';
it('accepts a non-inferior harness-shaped report for the exact model and task class', () => {
  expect(
    benchmarkPasses(
      benchmarkFixture('baseline'),
      benchmarkFixture('candidate'),
      fastIdentity,
      'research',
    ),
  ).toBe(true);
});
it.each([null, {}, { passed: true }])('keeps unmeasured artifact %# disabled', async (artifact) => {
  expect(
    await memoryBenchmarks(
      benchmarkFixture('baseline'),
      new Map([['routing-candidate.json', artifact]]),
    ).enabled(fixtureRule),
  ).toBe(false);
});
it('denies missing artifacts and filesystem traversal', async () => {
  const files = fileBenchmarks('/tmp/issue141-benchmarks', 'baseline.json');
  expect(await files.enabled({ ...fixtureRule, benchmarkArtifact: '../../routing.json' })).toBe(
    false,
  );
  expect(await files.enabled(fixtureRule)).toBe(false);
});
it('binds artifacts to exact version, region and task class', () => {
  const baseline = benchmarkFixture('baseline');
  const candidate = benchmarkFixture('candidate');
  expect(
    benchmarkPasses(baseline, candidate, { ...fastIdentity, version: 'another' }, 'research'),
  ).toBe(false);
  expect(benchmarkPasses(baseline, candidate, fastIdentity, 'write')).toBe(false);
});
