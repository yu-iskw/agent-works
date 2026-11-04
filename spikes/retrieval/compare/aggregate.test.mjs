import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { AggregateRefused, aggregate } from './aggregate.mjs';
import { proposedThresholds } from './evaluate.mjs';
import { baseline, bindEvidence, readJson } from './fixture-tools.mjs';
import { matrix } from './matrix.mjs';
import { offlineStage } from './schema.mjs';
import { replayManaged } from '../managed/replay.mjs';

const approved = { ...proposedThresholds, status: 'approved', approvedBy: 'test-only-owner' };
const directory = new URL('../managed/fixtures/', import.meta.url);
const script = fileURLToPath(new URL('./aggregate.mjs', import.meta.url));
const changed = ['revoked-member', 'source-deletion'];

// In-memory contract inputs standing in for operator observations; never saved as live evidence.
function evidenceFor(arm, patch = {}, edit = () => {}) {
  const cases = matrix.map((entry) => ({
    ...replayManaged(readJson(new URL(`${entry.id}.json`, directory))),
    latencyMs: 100,
    checkedAt: '2026-10-13T00:00:30Z',
    changedAt: changed.includes(entry.id) ? '2026-10-13T00:00:00Z' : null,
    revocationLagMs: changed.includes(entry.id) ? 1000 : null,
    revocationChecks: changed.includes(entry.id)
      ? ['2026-10-13T00:00:01Z', '2026-10-13T00:00:30Z'].map((checkedAt) => ({
          checkedAt,
          denied: true,
          sourceObjectId: entry.id === 'revoked-member' ? 'reviewer-shared' : 'alice-private',
        }))
      : [],
  }));
  edit(cases);
  return {
    ...baseline(arm),
    provenance: 'observed',
    verdict: 'GO',
    availability: 'available',
    configuration: {
      sourceAclMode: 'test-only-source-acl',
      identityMapping: 'test-only-bound-idp',
      featureStage: 'test-only-stage',
    },
    costUsd: 0.01,
    capturedAt: '2026-10-13T00:01:00Z',
    cases,
    ...patch,
  };
}
const observed = (arm, patch, edit) => bindEvidence(evidenceFor(arm, patch, edit));
const arm = (result, name) => result.arms.find((item) => item.arm === name);

test('two complete safe arms select managed and record both revocation lags', () => {
  const result = aggregate({ managed: observed('A'), drive: observed('B'), thresholds: approved });
  assert.equal(result.verdict, 'A');
  assert.equal(result.anyLeak, false);
  assert.equal(arm(result, 'A').revocationLagMs, 1000);
  assert.equal(arm(result, 'A').deletionLagMs, 1000);
  assert.equal(arm(result, 'A').positiveControl, 'MET');
});

test('no trial or access evidence is UNTESTED and defers, never passes', () => {
  const result = aggregate({});
  assert.equal(result.verdict, 'DEFER');
  assert.deepEqual(
    result.arms.map((item) => [item.status, item.positiveControl, item.revocationLagMs]),
    [
      ['UNTESTED', 'UNTESTED', null],
      ['UNTESTED', 'UNTESTED', null],
    ],
  );
  assert.deepEqual(result.blocksIssues, [23, 24]);
});

test('a missing managed arm cannot hand the decision to a clean Drive arm', () => {
  const result = aggregate({ drive: observed('B'), thresholds: approved });
  assert.equal(result.verdict, 'DEFER');
  assert.equal(arm(result, 'A').status, 'UNTESTED');
  assert.equal(arm(result, 'B').status, 'OBSERVED');
});

test('a missing Drive arm leaves a clean managed arm eligible only by its own evidence', () => {
  const result = aggregate({ managed: observed('A'), thresholds: approved });
  assert.equal(result.verdict, 'A');
  assert.equal(arm(result, 'B').status, 'UNTESTED');
});

for (const surface of ['title', 'snippet', 'content']) {
  for (const name of ['A', 'B']) {
    test(`${name}: forbidden ${surface} leak yields NO-GO even when the other arm is clean`, () => {
      const leaky = observed(name, {}, (cases) => {
        cases[0].hits[0][surface] = `x C04_BOB_${surface.toUpperCase()} x`;
      });
      const clean = observed(name === 'A' ? 'B' : 'A');
      const result = aggregate({
        managed: name === 'A' ? leaky : clean,
        drive: name === 'A' ? clean : leaky,
        thresholds: approved,
      });
      assert.equal(result.verdict, 'NO-GO');
      assert.equal(result.anyLeak, true);
      assert.equal(arm(result, name).verdict, 'NO-GO');
      assert.ok(arm(result, name).leakFindings.some((item) => item.surface === surface));
    });
  }
}

test('a leak with the other arm absent is still NO-GO', () => {
  const leaky = observed('B', {}, (cases) => {
    cases[3].hits[0].title = 'C04_ALICE_TITLE';
  });
  const result = aggregate({ drive: leaky });
  assert.equal(result.verdict, 'NO-GO');
  assert.notEqual(result.comparisonOutcome, 'NO-GO');
});

test('revoked-member access that stays allowed in a recheck is a leak', () => {
  const result = aggregate({
    managed: observed('A', {}, (cases) => {
      cases[4].revocationChecks.unshift({
        checkedAt: '2026-10-13T00:00:00Z',
        denied: false,
        sourceObjectId: 'reviewer-shared',
      });
    }),
    thresholds: approved,
  });
  assert.equal(result.verdict, 'NO-GO');
});

test('revocation lag over the approved budget disqualifies and the lag stays recorded', () => {
  const result = aggregate({
    managed: observed('A', {}, (cases) => {
      cases[4].revocationLagMs = 29_000;
      cases[4].changedAt = '2026-10-13T00:00:01Z';
      cases[4].revocationChecks = [
        { checkedAt: '2026-10-13T00:00:30Z', denied: true, sourceObjectId: 'reviewer-shared' },
        { checkedAt: '2026-10-13T00:00:31Z', denied: true, sourceObjectId: 'reviewer-shared' },
      ];
      cases[4].checkedAt = '2026-10-13T00:00:31Z';
    }),
    thresholds: { ...approved, maximumRevocationLagMs: 1000 },
  });
  assert.equal(result.verdict, 'NO-GO');
  assert.equal(arm(result, 'A').revocationLagMs, 29_000);
});

test('an offline fixture labeled live is refused, not scored', () => {
  const real = observed('A');
  const asOfflineId = structuredClone(real);
  asOfflineId.transcript.transcript.id = 'c04.managed.offline';
  const notLiveProbed = structuredClone(real);
  for (const item of notLiveProbed.transcript.transcript.response.observations)
    if (item.name === 'live-probed') item.value = false;
  const syntheticKind = structuredClone(real);
  syntheticKind.transcript.transcript.provenance.kind = 'synthetic';
  const harnessStage = structuredClone(real);
  harnessStage.evidence.configuration.featureStage = offlineStage;
  for (const forged of [asOfflineId, notLiveProbed, syntheticKind, harnessStage]) {
    assert.throws(
      () => aggregate({ managed: forged, thresholds: approved }),
      (error) => error instanceof AggregateRefused && error.code === 'offline-labeled-live',
    );
  }
});

test('the schema itself refuses harness output labeled observed', () => {
  assert.throws(() =>
    bindEvidence(
      evidenceFor('A', {
        configuration: {
          sourceAclMode: 'x',
          identityMapping: 'x',
          featureStage: offlineStage,
        },
      }),
    ),
  );
});

test('tampered, mismatched-arm and malformed inputs are refused with a reason code', () => {
  const tampered = structuredClone(observed('A'));
  tampered.evidence.costUsd = 99;
  assert.throws(() => aggregate({ managed: tampered }), { code: 'invalid-evidence' });
  assert.throws(() => aggregate({ managed: observed('B') }), { code: 'arm-mismatch' });
  assert.throws(() => aggregate({ drive: { nonsense: true } }), { code: 'invalid-evidence' });
});

test('positive control is required: a deny-everything arm is never GO', () => {
  const denyAll = observed('A', {}, (cases) => {
    for (const entry of cases) entry.hits = [];
  });
  const strict = aggregate({ managed: denyAll, thresholds: approved });
  assert.equal(arm(strict, 'A').positiveControl, 'FAILED');
  assert.equal(strict.verdict, 'neither');
  const proposed = aggregate({ managed: denyAll });
  assert.equal(proposed.verdict, 'DEFER');
  assert.equal(arm(proposed, 'A').positiveControl, 'FAILED');
});

test('missing only the owner control fails even when recall would otherwise pass', () => {
  const result = aggregate({
    managed: observed('A', {}, (cases) => {
      cases[0].hits = cases[0].hits.filter((hit) => hit.sourceObjectId !== 'alice-private');
    }),
    thresholds: { ...approved, minimumRecall: 0 },
  });
  assert.equal(arm(result, 'A').positiveControl, 'FAILED');
  assert.notEqual(result.verdict, 'A');
});

test('CLI is read-only, deterministic and exits nonzero on refusal', () => {
  const folder = mkdtempSync(join(tmpdir(), 'acl-01-'));
  try {
    const good = join(folder, 'a.json');
    const forged = join(folder, 'forged.json');
    writeFileSync(good, JSON.stringify(observed('A')));
    const bad = structuredClone(observed('A'));
    bad.transcript.transcript.id = 'c04.managed.offline';
    writeFileSync(forged, JSON.stringify(bad));
    const run = (...args) =>
      execFileSync(process.execPath, [script, ...args], { encoding: 'utf8' });
    assert.equal(JSON.parse(run('--managed', good)).arms[0].status, 'OBSERVED');
    assert.equal(run('--managed', good), run('--managed', good));
    assert.equal(JSON.parse(run()).verdict, 'DEFER');
    assert.throws(() =>
      execFileSync(process.execPath, [script, '--managed', forged], { stdio: 'pipe' }),
    );
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
});
