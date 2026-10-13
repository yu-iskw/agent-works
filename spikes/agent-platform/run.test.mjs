import assert from 'node:assert/strict';
import test from 'node:test';

import { replayBundle } from './run.mjs';

test('offline bundle replay keeps every probe at DEFER', async () => {
  const reports = await replayBundle();
  assert.equal(reports.length, 6);
  for (const report of reports) assert.equal(report.verdict, 'DEFER');
});

test('runProbe seals the request snapshot taken before the backend await', async () => {
  for (const name of [
    'agent-identity',
    'runtime',
    'identity-gateway',
    'memory',
    'model',
    'sandbox',
  ]) {
    const { makeEvidence, recordedBackend, runProbe, validateEvidence } = await import(
      `./${name}/evidence.mjs`
    );
    const { default: fixtures } = await import(`./${name}/fixtures/scenarios.json`, {
      with: { type: 'json' },
    });
    const scenario = fixtures.cases.find((item) => item.expectedVerdict === 'no-go');
    const request = { ...fixtures.baseline, ...scenario.patch };
    const backend = recordedBackend([makeEvidence(scenario.id, request, scenario.response)]);
    const pending = runProbe(scenario.id, request, backend);
    for (const key of Object.keys(request)) request[key] = fixtures.baseline[key];
    const result = validateEvidence(JSON.stringify(await pending));
    assert.equal(result.ok, true, name);
    assert.equal(result.assessment.verdict, 'no-go', name);
  }
});
