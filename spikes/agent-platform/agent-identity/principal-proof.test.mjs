import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { makeEvidence } from './evidence.mjs';
import { readPrincipalProof } from './principal-proof.mjs';

const fixtures = JSON.parse(readFileSync(new URL('./fixtures/scenarios.json', import.meta.url)));

test('principal proof separates workload scope from end-user authority', () => {
  const proof = readPrincipalProof();
  assert.equal(proof.principal, 'agent-a');
  assert.equal(proof.caller, 'user-a');
  assert.equal(proof.userAuthoritySeparate, true);
  assert.equal(proof.staticKey, false);
  assert.equal(proof.liveValidation, 'UNVERIFIED');
  assert.equal(proof.verdict, 'DEFER');
  assert.equal(Object.isFrozen(proof), true);
  assert.match(proof.digest, /^[a-f0-9]{64}$/);
});

for (const scenario of fixtures.cases.slice(1)) {
  test(`principal proof rejects ${scenario.id}`, () => {
    const envelope = makeEvidence(
      scenario.id,
      { ...fixtures.baseline, ...scenario.patch },
      scenario.response,
    );
    assert.throws(() => readPrincipalProof(JSON.stringify(envelope)), /rejected|not demonstrated/);
  });
}
