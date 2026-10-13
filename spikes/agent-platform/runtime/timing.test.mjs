import assert from 'node:assert/strict';
import test from 'node:test';

import { syntheticWarmP95 } from './timing.mjs';

test('warm p95 uses nearest-rank and remains synthetic', () => {
  const samples = Array.from({ length: 20 }, (_, i) => ({
    provenance: 'synthetic',
    warm: true,
    firstTokenMs: i + 1,
  })).reverse();
  assert.deepEqual(syntheticWarmP95(samples), {
    provenance: 'synthetic',
    count: 20,
    p95Ms: 19,
    liveValidation: 'UNVERIFIED',
  });
});

test('timing rejects cold, unlabelled, nonfinite and absent samples', () => {
  for (const samples of [
    [],
    null,
    [{ provenance: 'observed', warm: true, firstTokenMs: 1 }],
    [{ provenance: 'synthetic', warm: false, firstTokenMs: 1 }],
    [{ provenance: 'synthetic', warm: true, firstTokenMs: NaN }],
    [{ provenance: 'synthetic', warm: true, firstTokenMs: -1 }],
  ]) {
    assert.throws(() => syntheticWarmP95(samples), /sample/);
  }
});
