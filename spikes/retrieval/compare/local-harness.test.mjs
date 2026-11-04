import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { test } from 'node:test';

import { offlineLabel, runLocalHarness } from './local-harness.mjs';
import { readJson } from './fixture-tools.mjs';
import { matrix } from './matrix.mjs';

const directory = new URL('../managed/fixtures/', import.meta.url);
const built = existsSync(
  new URL('../../../apps/api/dist/retrieval/drive-adapter.js', import.meta.url),
);
const options = { skip: built ? false : 'apps/api/dist missing: run pnpm build first (UNTESTED)' };
const managedWith = (caseId, fixture) => (id) =>
  readJson(new URL(`${id === caseId ? fixture : id}.json`, directory));

test(
  'both arms run the same six cases: positive access and negative surfaces pass offline',
  options,
  async () => {
    const report = await runLocalHarness();
    for (const arm of ['A', 'B']) {
      assert.deepEqual(
        report[arm].checks.map((item) => item.id),
        matrix.map((entry) => entry.id),
      );
      assert.equal(report[arm].offlineChecks, 'passed');
      assert.ok(
        report[arm].checks.every((item) => item.positive.ok && item.unexpected.length === 0),
      );
      assert.deepEqual(report[arm].leakFindings, []);
      assert.equal(report[arm].live, false);
      assert.equal(report[arm].label, offlineLabel);
      assert.notEqual(report[arm].armVerdict, 'GO');
    }
  },
);

for (const surface of ['title', 'snippet', 'content']) {
  test(`harness detects a forbidden ${surface} next to an allowed object`, options, async () => {
    const report = await runLocalHarness({
      managedCase: managedWith('alice', `leak-${surface}`),
    });
    assert.equal(report.A.offlineChecks, 'failed');
    assert.ok(report.A.leakFindings.some((item) => item.surface === surface));
    assert.equal(report.A.armVerdict, 'NO-GO');
    assert.equal(report.B.offlineChecks, 'passed');
  });
}

test(
  'harness detects a leak of an existence-revealing object in an outsider case',
  options,
  async () => {
    const report = await runLocalHarness({
      managedCase: managedWith('outsider', 'leak-outsider'),
    });
    assert.equal(report.A.offlineChecks, 'failed');
    assert.equal(report.A.armVerdict, 'NO-GO');
  },
);

test(
  'harness fails the positive control when the owner loses their own object',
  options,
  async () => {
    const report = await runLocalHarness({
      managedCase: (id) => {
        const recording = readJson(new URL(`${id}.json`, directory));
        if (id === 'alice') recording.response = { results: [] };
        return recording;
      },
    });
    const alice = report.A.checks.find((item) => item.id === 'alice');
    assert.equal(alice.positive.ok, false);
    assert.ok(alice.positive.missing.includes('alice-private'));
    assert.equal(report.A.offlineChecks, 'failed');
  },
);
