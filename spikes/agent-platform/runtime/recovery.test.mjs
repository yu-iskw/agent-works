import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { makeEvidence } from './evidence.mjs';
import { verifyRecovery } from './recovery.mjs';

const fixtures = JSON.parse(readFileSync(new URL('./fixtures/scenarios.json', import.meta.url)));
function recovery() {
  return ['bounded-read', 'bounded-abort', 'restart-recovery'].map((id) => {
    const item = fixtures.cases.find((scenario) => scenario.id === id);
    return makeEvidence(id, { ...fixtures.baseline, ...item.patch }, item.response);
  });
}

test('runtime abort/restart preserves owner and keeps live recovery unverified', () => {
  assert.deepEqual(verifyRecovery(recovery()), {
    verdict: 'DEFER',
    reason: 'synthetic-recovery-only',
    liveValidation: 'UNVERIFIED',
  });
});

test('cross-user restart is a recovery NO-GO', () => {
  const records = recovery();
  records[2] = makeEvidence(
    'restart-substitution',
    { ...fixtures.baseline, operation: 'restart', caller: 'user-b' },
    { outcome: 'denied', 'session-isolated': true, bounded: true, recovered: false },
  );
  assert.equal(verifyRecovery(records).verdict, 'NO-GO');
});

test('abort failure and unexpected continued execution are NO-GO', () => {
  const records = recovery();
  records[1] = makeEvidence(
    'failed-abort',
    { ...fixtures.baseline, operation: 'abort' },
    { outcome: 'allowed', 'session-isolated': true, bounded: false, recovered: false },
  );
  assert.equal(verifyRecovery(records).reason, 'recovery-control-failure');
});

test('missing checkpoint, wrong order and incomplete recordings defer', () => {
  const records = recovery();
  records[2] = makeEvidence(
    'no-checkpoint',
    { ...fixtures.baseline, operation: 'restart', checkpoint: false },
    { outcome: 'denied', 'session-isolated': true, bounded: true, recovered: false },
  );
  assert.equal(verifyRecovery(records).reason, 'recovery-not-demonstrated');
  assert.equal(verifyRecovery([records[1], records[0], records[2]]).reason, 'recovery-order');
  assert.equal(verifyRecovery([]).reason, 'missing-recovery');
  records[0].digest = '0'.repeat(64);
  assert.equal(verifyRecovery(records).reason, 'invalid-evidence');
});
