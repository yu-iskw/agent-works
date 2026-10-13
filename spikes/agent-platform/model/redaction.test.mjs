import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { sealTranscript } from '../../common/verify.mjs';
import { makeEvidence, validateEvidence } from './evidence.mjs';

const fixture = JSON.parse(readFileSync(new URL('./fixtures/valid.json', import.meta.url)));
const scenarios = JSON.parse(readFileSync(new URL('./fixtures/scenarios.json', import.meta.url)));

test('model fixture retains only the declared prompt redaction mark', () => {
  const promptIndex = fixture.transcript.request.observations.findIndex(
    (item) => item.name === 'prompt',
  );
  assert.equal(fixture.transcript.request.observations[promptIndex].value, '[redacted]');
  assert.ok(
    fixture.transcript.redacted.some(
      (item) => item.path === `/request/observations/${promptIndex}/value`,
    ),
  );
  const changed = structuredClone(fixture);
  changed.transcript.redacted = [];
  assert.equal(validateEvidence(JSON.stringify(changed)).ok, false);
});

test('raw sensitive prompt and prompt token cannot be sealed by the probe', () => {
  for (const prompt of [
    'synthetic private prompt',
    'Bearer ' + 'synthetic-canary',
    ['test', 'example.invalid'].join('@'),
  ]) {
    assert.throws(
      () =>
        makeEvidence('raw-prompt', { ...scenarios.baseline, prompt }, scenarios.cases[0].response),
      /Invalid/,
    );
    const changed = structuredClone(fixture);
    const observation = changed.transcript.request.observations.find(
      (item) => item.name === 'prompt',
    );
    observation.value = prompt;
    changed.transcript.redacted = [];
    const sealed = sealTranscript(changed.transcript);
    const result = validateEvidence(JSON.stringify(sealed.ok ? sealed.envelope : changed));
    assert.equal(result.ok, false);
    assert.equal(JSON.stringify(result).includes(prompt), false);
  }
});

test('endpoint failure followed by disallowed fallback is NO-GO', () => {
  const scenario = scenarios.cases.find((item) => item.id === 'endpoint-failure');
  const request = { ...scenarios.baseline, ...scenario.patch };
  const response = {
    ...scenario.response,
    outcome: 'allowed',
    'policy-bypassed': true,
    'regional-processing': false,
  };
  const envelope = makeEvidence('unsafe-endpoint-fallback', request, response);
  const checked = validateEvidence(JSON.stringify(envelope));
  assert.equal(checked.ok, true);
  assert.equal(checked.assessment.verdict, 'no-go');
  assert.deepEqual(checked.assessment.violations, [
    'outcome',
    'policy-bypassed',
    'regional-processing',
  ]);
});
