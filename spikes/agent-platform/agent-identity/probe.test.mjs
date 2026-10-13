import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { sealTranscript } from '../../common/verify.mjs';
import { makeEvidence, recordedBackend, runProbe, validateEvidence } from './evidence.mjs';
import { feature } from './probe.mjs';

const load = (name) =>
  JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url)));
const fixture = load('valid');
const scenarios = load('scenarios');
const negatives = load('negative');

function reseal(envelope) {
  const sealed = sealTranscript(envelope.transcript);
  // Invalid common-schema mutations retain the old digest, so the verifier must reject.
  return sealed.ok ? sealed.envelope : envelope;
}

function checked(envelope) {
  return validateEvidence(JSON.stringify(envelope));
}

for (const scenario of scenarios.cases) {
  test(`${feature}: synthetic ${scenario.id}`, async () => {
    assert.equal(scenarios.provenance, 'synthetic');
    const request = { ...scenarios.baseline, ...scenario.patch };
    const envelope = makeEvidence(scenario.id, request, scenario.response);
    const backend = recordedBackend([envelope]);
    const replayed = await runProbe(scenario.id, request, backend);
    const result = checked(replayed);
    assert.equal(result.ok, true);
    assert.deepEqual(result.response, scenario.response);
    assert.equal(result.assessment.verdict, scenario.expectedVerdict);
    assert.equal(result.liveValidation, 'UNVERIFIED');
    assert.equal(result.adoption, 'DEFER');
    if (scenario.id === 'successful-control-bypass') {
      assert.equal(result.assessment.verdict, 'no-go');
      assert.ok(result.assessment.violations.includes('outcome'));
      replayed.transcript.verdict = 'unverified';
      assert.equal(checked(reseal(replayed)).ok, false);
    }
  });
}

const mutations = {
  'remove-field': (envelope) => {
    delete envelope.transcript.capturedAt;
  },
  'alter-checksum': (envelope) => {
    envelope.digest = '0'.repeat(64);
  },
  'synthetic-go': (envelope) => {
    envelope.transcript.verdict = 'go';
  },
  'wrong-feature': (envelope) => {
    envelope.transcript.feature = 'other-probe';
  },
  'duplicate-observation': (envelope) => {
    envelope.transcript.request.observations.push(envelope.transcript.request.observations[0]);
  },
  'unknown-observation': (envelope) => {
    envelope.transcript.request.observations.push({ name: 'unknown', value: true });
  },
  email: (envelope) => {
    envelope.transcript.response.observations[0].value = ['test', 'example.invalid'].join('@');
  },
};

for (const recipe of negatives.cases) {
  test(`${feature}: rejects synthetic invalid ${recipe.id}`, () => {
    assert.equal(negatives.provenance, 'synthetic');
    const envelope = structuredClone(fixture);
    mutations[recipe.operation](envelope);
    const result = checked(recipe.operation === 'alter-checksum' ? envelope : reseal(envelope));
    assert.equal(result.ok, false);
    assert.ok(result.reasons.some(({ code }) => code === recipe.reason));
  });
}

test(`${feature}: rejects changed bytes, malformed JSON and oversized inputs`, () => {
  const changed = structuredClone(fixture);
  changed.transcript.capturedAt = '2000-01-02T00:00:00Z';
  assert.equal(checked(changed).ok, false);
  for (const bytes of ['{', '{}', 'null', ' '.repeat(65537), undefined, 17]) {
    assert.equal(validateEvidence(bytes).ok, false);
  }
});

test(`${feature}: rejects fabricated observed GO and wrong ID/API/region`, () => {
  for (const [key, value] of [
    ['id', 'c02.other.case'],
    ['region', 'us-central1'],
    ['verdict', 'go'],
  ]) {
    const changed = structuredClone(fixture);
    changed.transcript.provenance.kind = 'observed';
    changed.transcript[key] = value;
    assert.equal(checked(reseal(changed)).ok, false);
  }
  const changed = structuredClone(fixture);
  changed.transcript.response.api = 'other.evaluate';
  assert.equal(checked(reseal(changed)).ok, false);
});

test(`${feature}: rejects tokens, key material and escaped emails without echoing them`, () => {
  // Harmless generated canaries, never real credentials.
  const canaries = [
    'Bearer ' + 'synthetic-canary',
    'ya29.' + 'synthetic-canary',
    'ghp_' + 'SyntheticCanary',
    'sk-' + 'synthetic-canary',
    'access' + '_token=synthetic-canary',
    'password=' + 'synthetic-canary',
    '-----BEGIN ' + 'PRIVATE KEY-----',
    'eyJ' + 'synthetic.eyJsynthetic.synthetic',
    'AKIA' + 'A'.repeat(16),
    ['test', 'example.invalid'].join('@'),
  ];
  for (const canary of canaries) {
    const changed = structuredClone(fixture);
    changed.transcript.response.observations[0].value = canary;
    const bytes = JSON.stringify(changed);
    const result = validateEvidence(bytes);
    assert.equal(result.ok, false);
    assert.equal(JSON.stringify(result).includes(canary), false);
    assert.equal(validateEvidence(bytes.replaceAll('@', '\\u0040')).ok, false);
  }
});

test(`${feature}: rejects bad scalar types, missing fields and redaction mismatch`, () => {
  for (const value of [[], {}, null, 1.5]) {
    const changed = structuredClone(fixture);
    changed.transcript.request.observations[0].value = value;
    assert.equal(checked(reseal(changed)).ok, false);
  }
  const missing = structuredClone(fixture);
  missing.transcript.response.observations.pop();
  assert.equal(checked(reseal(missing)).ok, false);
  const redaction = structuredClone(fixture);
  redaction.transcript.response.observations[0].value = '[redacted]';
  assert.equal(checked(redaction).ok, false);
});

test(`${feature}: every altered control observation produces NO-GO`, () => {
  const original = checked(fixture);
  for (const [key, value] of Object.entries(original.response)) {
    const changed = { ...original.response, [key]: typeof value === 'boolean' ? !value : 'denied' };
    if (changed[key] === value) continue;
    const result = checked(makeEvidence('control-change', original.request, changed));
    assert.equal(result.ok, true);
    assert.equal(result.assessment.verdict, 'no-go');
    assert.ok(result.assessment.violations.includes(key));
  }
});

test(`${feature}: recorded adapter rejects duplicates, substitution and missing records`, async () => {
  const request = { ...scenarios.baseline };
  assert.throws(() => recordedBackend([fixture, fixture]), /Duplicate/);
  const corrupt = structuredClone(fixture);
  corrupt.digest = '0'.repeat(64);
  assert.throws(() => recordedBackend([corrupt]), /Invalid/);
  const backend = recordedBackend([fixture]);
  await assert.rejects(runProbe('missing', request, backend), /Missing/);
  await assert.rejects(
    runProbe('bounded-read', { ...request, injected: true }, backend),
    /Invalid/,
  );
  const substitution = scenarios.cases[1];
  await assert.rejects(
    runProbe('bounded-read', { ...request, ...substitution.patch }, backend),
    /mismatch/,
  );
  await assert.rejects(runProbe('bounded-read', request, null), /Missing/);
  await assert.rejects(
    runProbe('bounded-read', request, {
      async exchange() {
        return {};
      },
    }),
    /Invalid/,
  );
});

test(`${feature}: replay works with network entry disabled`, async () => {
  const original = globalThis.fetch;
  globalThis.fetch = () => {
    throw new Error('Network forbidden');
  };
  try {
    const result = await runProbe('bounded-read', scenarios.baseline, recordedBackend([fixture]));
    assert.equal(checked(result).ok, true);
  } finally {
    globalThis.fetch = original;
  }
});

test(`${feature}: unauthorized success on each denied or bounded challenge is NO-GO`, () => {
  for (const scenario of scenarios.cases) {
    if (scenario.response.outcome === 'allowed') continue;
    const request = { ...scenarios.baseline, ...scenario.patch };
    const response = { ...scenario.response, outcome: 'allowed' };
    const result = checked(makeEvidence(`bypass-${scenario.id}`, request, response));
    assert.equal(result.ok, true);
    assert.equal(result.assessment.verdict, 'no-go');
    assert.ok(result.assessment.violations.includes('outcome'));
  }
});

test(`${feature}: deeply nested malformed data fails without exposing payload`, () => {
  const raw = '{"extra":' + '['.repeat(8000) + '0' + ']'.repeat(8000) + '}';
  const result = validateEvidence(raw);
  assert.equal(result.ok, false);
  assert.equal(Object.hasOwn(result, 'transcript'), false);
});
