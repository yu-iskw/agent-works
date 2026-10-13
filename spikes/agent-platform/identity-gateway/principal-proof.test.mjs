import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { makeEvidence, validateEvidence } from './evidence.mjs';
import { componentVerdicts, gatewayPrincipal } from './principal-proof.mjs';

const fixtures = JSON.parse(readFileSync(new URL('./fixtures/scenarios.json', import.meta.url)));
const evaluate = (id, patch, response) =>
  validateEvidence(JSON.stringify(makeEvidence(id, { ...fixtures.baseline, ...patch }, response)));

test('Gateway consumes #112 principal proof as unverified read-only evidence', () => {
  const proof = gatewayPrincipal();
  assert.equal(proof.principal, 'agent-a');
  assert.equal(proof.authoritySeparated, true);
  assert.equal(proof.liveValidation, 'UNVERIFIED');
  assert.equal(proof.verdict, 'DEFER');
  assert.match(proof.evidenceDigest, /^[a-f0-9]{64}$/);
  assert.throws(() => gatewayPrincipal('{}'), /rejected/);
});

test('successful direct-egress bypass is NO-GO independently of Registry', () => {
  const direct = fixtures.cases.find((item) => item.id === 'direct-egress');
  const response = { ...direct.response, outcome: 'allowed', 'egress-enforced': false };
  const result = evaluate('direct-bypass', direct.patch, response);
  assert.equal(result.ok, true);
  assert.equal(result.assessment.verdict, 'no-go');
  assert.deepEqual(componentVerdicts([result]), {
    registry: 'DEFER',
    gateway: 'NO-GO',
    liveValidation: 'UNVERIFIED',
  });
});

test('Registry publication failure cannot be hidden in Gateway verdict', () => {
  const publication = fixtures.cases.find((item) => item.id === 'unapproved-publication');
  const result = evaluate('publication-bypass', publication.patch, {
    ...publication.response,
    outcome: 'allowed',
  });
  assert.deepEqual(componentVerdicts([result]), {
    registry: 'NO-GO',
    gateway: 'DEFER',
    liveValidation: 'UNVERIFIED',
  });
});
