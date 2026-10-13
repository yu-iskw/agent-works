import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { makeEvidence } from './evidence.mjs';
import { verifyDeletionLifecycle } from './lifecycle.mjs';

const fixtures = JSON.parse(readFileSync(new URL('./fixtures/scenarios.json', import.meta.url)));
function lifecycle() {
  return ['bounded-read', 'delete-request', 'read-after-deletion'].map((id) => {
    const item = fixtures.cases.find((scenario) => scenario.id === id);
    return makeEvidence(id, { ...fixtures.baseline, ...item.patch }, item.response);
  });
}

test('read/delete/read replay defers adoption even with synthetic retention evidence', () => {
  assert.deepEqual(verifyDeletionLifecycle(lifecycle()), {
    verdict: 'DEFER',
    reason: 'synthetic-lifecycle-only',
    liveValidation: 'UNVERIFIED',
  });
});

test('visible memory after deletion is NO-GO', () => {
  const records = lifecycle();
  const request = { ...fixtures.baseline, deleted: true };
  const response = {
    outcome: 'allowed',
    'memory-visible': true,
    'deletion-confirmed': true,
    'retention-demonstrated': true,
  };
  records[2] = makeEvidence('deletion-bypass', request, response);
  assert.equal(verifyDeletionLifecycle(records).verdict, 'NO-GO');
});

test('missing retention or deletion acknowledgement defers', () => {
  const records = lifecycle();
  records[1] = makeEvidence(
    'unsupported-delete',
    {
      ...fixtures.baseline,
      operation: 'delete',
      'deletion-supported': false,
      'retention-evidence': false,
    },
    {
      outcome: 'unavailable',
      'memory-visible': false,
      'deletion-confirmed': false,
      'retention-demonstrated': false,
    },
  );
  assert.equal(verifyDeletionLifecycle(records).reason, 'incomplete-deletion-retention');
  assert.equal(verifyDeletionLifecycle([]).verdict, 'DEFER');
});

test('lifecycle rejects substituted ownership and corrupted evidence', () => {
  const records = lifecycle();
  records[2] = makeEvidence(
    'substituted-after',
    { ...fixtures.baseline, caller: 'user-b', deleted: true },
    {
      outcome: 'denied',
      'memory-visible': false,
      'deletion-confirmed': true,
      'retention-demonstrated': true,
    },
  );
  assert.equal(verifyDeletionLifecycle(records).reason, 'lifecycle-binding');
  records[2].digest = '0'.repeat(64);
  assert.equal(verifyDeletionLifecycle(records).reason, 'invalid-evidence');
});

test('unauthorized post-deletion read stays NO-GO despite broken lifecycle binding', () => {
  const records = lifecycle();
  const bypass = fixtures.cases.find((scenario) => scenario.expectedVerdict === 'no-go');
  records[2] = makeEvidence(bypass.id, { ...fixtures.baseline, ...bypass.patch }, bypass.response);
  assert.equal(verifyDeletionLifecycle(records).verdict, 'NO-GO');
});
