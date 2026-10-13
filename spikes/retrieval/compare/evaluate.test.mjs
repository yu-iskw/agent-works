import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { canonicalPayloadSha256 } from '../../../packages/domain/src/canonical-hash.ts';
import { compareArms, evaluateArm, percentile95, proposedThresholds } from './evaluate.mjs';
import { baseline, bindEvidence, readJson } from './fixture-tools.mjs';
import { matrix } from './matrix.mjs';
import { evidenceSchema, parseEvidence, sealEvidence } from './schema.mjs';
import { replayManaged } from '../managed/replay.mjs';
import { runComparison } from './run.mjs';

const approved = { ...proposedThresholds, status: 'approved', approvedBy: 'test-only-owner' };
const repository = fileURLToPath(new URL('../../../', import.meta.url));
const directory = new URL('../managed/fixtures/', import.meta.url);
const cases = () =>
  matrix.map((entry) => replayManaged(readJson(new URL(`${entry.id}.json`, directory))));

// In-memory contract test inputs only. They are never saved as observed cloud evidence.
function observed(arm = 'A', patch = {}) {
  const input = {
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
    cases: cases().map((entry) => ({
      ...entry,
      latencyMs: 100,
      checkedAt: '2026-10-13T00:00:30Z',
      changedAt: ['revoked-member', 'source-deletion'].includes(entry.id)
        ? '2026-10-13T00:00:00Z'
        : null,
      revocationLagMs: ['revoked-member', 'source-deletion'].includes(entry.id) ? 1000 : null,
      revocationChecks: ['revoked-member', 'source-deletion'].includes(entry.id)
        ? [
            {
              checkedAt: '2026-10-13T00:00:01Z',
              denied: true,
              sourceObjectId: entry.id === 'revoked-member' ? 'reviewer-shared' : 'alice-private',
            },
            {
              checkedAt: '2026-10-13T00:00:30Z',
              denied: true,
              sourceObjectId: entry.id === 'revoked-member' ? 'reviewer-shared' : 'alice-private',
            },
          ]
        : [],
    })),
    ...patch,
  };
  return bindEvidence(input);
}
function rebind(envelope, mutate) {
  const evidence = structuredClone(envelope.evidence);
  mutate(evidence);
  return bindEvidence(evidence);
}

for (const arm of ['A', 'B']) {
  for (const surface of ['title', 'snippet', 'content', 'identifier', 'response']) {
    test(`${arm}: any forbidden ${surface} disqualifies otherwise complete evidence`, () => {
      const input = rebind(observed(arm), (evidence) => {
        if (surface === 'response') evidence.cases[0].responseText = 'C04_BOB_TITLE';
        else if (surface === 'identifier') evidence.cases[0].hits[0].sourceObjectId = 'bob-private';
        else if (surface === 'title')
          evidence.cases[0].hits[0].title = 'prefix c04_bob_TITLE suffix';
        else if (surface === 'snippet')
          evidence.cases[0].hits[0].snippet = 'prefix c04_bob_SNIPPET suffix';
        else evidence.cases[0].hits[0].content = 'prefix c04_bob_CONTENT suffix';
      });
      const result = evaluateArm(input, approved);
      assert.equal(result.verdict, 'NO-GO');
      assert.equal(result.eligible, false);
      assert.ok(result.findings.some((finding) => finding.code === 'leak'));
    });
  }
  for (const id of ['outsider', 'revoked-member', 'source-deletion']) {
    test(`${arm}: ${id} exposure cannot be masked by other allowed results`, () => {
      const input = rebind(observed(arm), (evidence) => {
        const entry = evidence.cases.find((item) => item.id === id);
        entry.responseText = id === 'source-deletion' ? 'C04_ALICE_CONTENT' : 'C04_SHARED_SNIPPET';
      });
      assert.equal(evaluateArm(input, approved).verdict, 'NO-GO');
    });
  }
}

test('baseline saved reports deterministically defer and block downstream tasks', () => {
  const a = readJson(new URL('../../../docs/spikes/retrieval/managed.json', import.meta.url));
  const b = readJson(new URL('../../../docs/spikes/retrieval/drive.json', import.meta.url));
  const report = compareArms(a, b);
  assert.equal(report.outcome, 'DEFER');
  assert.deepEqual(report.blocksIssues, [23, 24]);
  assert.equal(report.relativeLatencyBOverA, null);
  assert.equal(report.observed, false);
  assert.deepEqual(compareArms(a, b), report);
  assert.deepEqual(
    report,
    readJson(new URL('../../../docs/spikes/retrieval-acl.json', import.meta.url)),
  );
});

test('synthetic GO and invented synthetic measurements are rejected', () => {
  assert.throws(() => evidenceSchema.parse({ ...baseline('B'), verdict: 'GO' }));
  assert.throws(() => evidenceSchema.parse({ ...baseline('B'), costUsd: 0.1 }));
  const entry = cases()[0];
  assert.throws(() =>
    evidenceSchema.parse({ ...baseline('B'), cases: [{ ...entry, latencyMs: 1 }] }),
  );
});

test('incomplete evidence defers, and duplicate or mismatched matrix identities are invalid', () => {
  const entry = cases()[0];
  assert.equal(evaluateArm(bindEvidence({ ...baseline('B'), cases: [entry] })).verdict, 'DEFER');
  assert.throws(() => evidenceSchema.parse({ ...baseline('B'), cases: [entry, entry] }));
  assert.throws(() =>
    evidenceSchema.parse({ ...baseline('B'), cases: [{ ...entry, subject: 'bob' }] }),
  );
  assert.throws(() =>
    evidenceSchema.parse({ ...baseline('B'), cases: [{ ...entry, query: 'other-corpus' }] }),
  );
});

test('observed payload requires checksum-bound valid transcript, not just a provenance label', () => {
  const valid = observed();
  assert.throws(() => parseEvidence({ ...valid, transcript: null }), /sealed C-04/);
  const tampered = structuredClone(valid);
  tampered.evidence.reason = 'altered';
  assert.throws(() => parseEvidence(tampered), /checksum/);
  tampered.digest = canonicalPayloadSha256(tampered.evidence);
  assert.throws(() => parseEvidence(tampered), /does not bind/);
  const alteredTranscript = structuredClone(valid);
  alteredTranscript.transcript.transcript.verdict = 'no-go';
  assert.throws(() => parseEvidence(alteredTranscript), /invalid C-04/);
});

test('secret-bearing evidence is rejected without echoing it', () => {
  const raw = { ...baseline('B'), reason: 'Bearer FAKE_SECRET_12345' };
  assert.throws(() => sealEvidence(raw), /^Error: evidence contains prohibited credentials$/);
});

test('absent source provenance and wrong access principal disqualify', () => {
  for (const patch of [
    null,
    { subject: 'bob' },
    { sourceAccessChecked: false },
    { sourceUri: 'https://drive.google.com/file/d/public/view' },
  ]) {
    const input = rebind(observed(), (evidence) => {
      const hit = evidence.cases[0].hits[0];
      hit.provenance = patch === null ? null : { ...hit.provenance, ...patch };
    });
    assert.equal(evaluateArm(input, approved).verdict, 'NO-GO');
  }
});

test('unknown returned object fails closed even without a known canary', () => {
  const input = rebind(observed(), (evidence) => {
    evidence.cases[0].hits[0].sourceObjectId = 'unknown-source';
  });
  assert.equal(evaluateArm(input, approved).verdict, 'NO-GO');
});

test('owner thresholds remain proposed and prevent selection', () => {
  const result = compareArms(observed('A'), observed('B'));
  assert.equal(result.outcome, 'DEFER');
  assert.equal(result.arms[0].measurements.recall, 1);
  assert.equal(result.arms[0].measurements.p95LatencyMs, 100);
});

test('approved complete evidence selects managed first; unavailable managed permits B', () => {
  assert.equal(compareArms(observed('A'), observed('B'), approved).outcome, 'A');
  assert.equal(compareArms(bindEvidence(baseline('A')), observed('B'), approved).outcome, 'B');
  assert.throws(() => compareArms(observed('B'), observed('A'), approved), /requires A then B/);
});

test('available managed authorization failure produces NO-GO regardless of Drive evidence', () => {
  const leaking = (arm) =>
    rebind(observed(arm), (evidence) => {
      evidence.cases[0].responseText = 'C04_BOB_CONTENT';
    });
  assert.equal(compareArms(leaking('A'), leaking('B'), approved).outcome, 'NO-GO');
  assert.equal(compareArms(leaking('A'), bindEvidence(baseline('B')), approved).outcome, 'NO-GO');
});

test('observed recall is distinct-object recall; duplicates cannot inflate it', () => {
  const input = rebind(observed(), (evidence) => {
    evidence.cases[0].hits = [evidence.cases[0].hits[0], evidence.cases[0].hits[0]];
  });
  const result = evaluateArm(input, approved);
  assert.equal(result.measurements.recall, 9 / 11);
  assert.equal(result.verdict, 'neither');
});

test('both safe but insufficient-quality arms result in neither', () => {
  const slow = (arm) =>
    rebind(observed(arm), (evidence) => {
      evidence.cases[0].latencyMs = 5001;
    });
  assert.equal(compareArms(slow('A'), slow('B'), approved).outcome, 'neither');
});

test('revocation and deletion budgets are evaluated independently', () => {
  for (const caseId of ['revoked-member', 'source-deletion']) {
    const input = rebind(observed(), (evidence) => {
      evidence.capturedAt = '2026-10-13T00:05:00Z';
      const entry = evidence.cases.find((item) => item.id === caseId);
      entry.checkedAt = '2026-10-13T00:02:00Z';
      entry.revocationLagMs = 61_000;
      entry.revocationChecks = [
        {
          checkedAt: '2026-10-13T00:01:01Z',
          denied: true,
          sourceObjectId: caseId === 'revoked-member' ? 'reviewer-shared' : 'alice-private',
        },
        {
          checkedAt: entry.checkedAt,
          denied: true,
          sourceObjectId: caseId === 'revoked-member' ? 'reviewer-shared' : 'alice-private',
        },
      ];
    });
    assert.equal(evaluateArm(input, approved).verdict, 'NO-GO');
  }
});

test('missing timing or latency defers instead of inventing a measurement', () => {
  const noTiming = rebind(observed(), (evidence) => {
    evidence.cases[4].revocationLagMs = null;
  });
  assert.equal(evaluateArm(noTiming, approved).verdict, 'DEFER');
  const noLatency = rebind(observed(), (evidence) => {
    evidence.cases[0].latencyMs = null;
  });
  assert.equal(evaluateArm(noLatency, approved).verdict, 'DEFER');
});

test('impossible timing and capture order are refused', () => {
  const raw = observed().evidence;
  const impossible = structuredClone(raw);
  impossible.cases[4].changedAt = '2026-10-14T00:00:00Z';
  assert.throws(() => evidenceSchema.parse(impossible));
  const future = structuredClone(raw);
  future.cases[0].checkedAt = '2026-10-14T00:00:00Z';
  assert.throws(() => evidenceSchema.parse(future));
});

test('percentile uses nearest rank and relative latency uses real paired measurements', () => {
  assert.equal(percentile95([]), null);
  assert.equal(percentile95([1, 2, 3, 4, 100]), 100);
  const b = rebind(observed('B'), (evidence) => {
    for (const entry of evidence.cases) entry.latencyMs = 200;
  });
  const result = compareArms(observed('A'), b, approved);
  assert.equal(result.relativeLatencyBOverA, 2);
});

test('threshold validation rejects unsigned approval and invalid budgets', () => {
  for (const patch of [
    { approvedBy: '' },
    { minimumRecall: 2 },
    { maximumP95LatencyMs: -1 },
    { maximumRevocationLagMs: Infinity },
  ]) {
    assert.throws(() => evaluateArm(observed(), { ...approved, ...patch }), /thresholds/);
  }
});

test('CLI replay is deterministic, read-only, and refuses malformed inputs', () => {
  const args = [
    'spikes/retrieval/compare/run.mjs',
    'docs/spikes/retrieval/managed.json',
    'docs/spikes/retrieval/drive.json',
  ];
  const first = execFileSync(process.execPath, args, { encoding: 'utf8', cwd: repository });
  const second = execFileSync(process.execPath, args, { encoding: 'utf8', cwd: repository });
  assert.equal(first, second);
  assert.equal(JSON.parse(first).outcome, 'DEFER');
  assert.deepEqual(
    runComparison(
      new URL('docs/spikes/retrieval/managed.json', `file://${repository}`).pathname,
      new URL('docs/spikes/retrieval/drive.json', `file://${repository}`).pathname,
    ),
    JSON.parse(first),
  );
  assert.throws(() =>
    execFileSync(process.execPath, ['spikes/retrieval/compare/run.mjs'], {
      stdio: 'pipe',
      cwd: repository,
    }),
  );
});

test('polling summary resets after stale access and requires two denials', async () => {
  const { summarizeRevocation } = await import('./revocation.mjs');
  const changedAt = '2026-10-13T00:00:00Z';
  const checks = [
    { checkedAt: '2026-10-13T00:00:01Z', denied: true },
    { checkedAt: '2026-10-13T00:00:02Z', denied: false },
    { checkedAt: '2026-10-13T00:00:03Z', denied: true },
  ];
  assert.equal(summarizeRevocation(changedAt, checks).revocationLagMs, null);
  const stable = summarizeRevocation(changedAt, [
    ...checks,
    { checkedAt: '2026-10-13T00:00:04Z', denied: true },
  ]);
  assert.equal(stable.revocationLagMs, 3000);
  assert.throws(() => summarizeRevocation(changedAt, [...checks].reverse()), /polling order/);
});

test('a claimed lag without polling proof cannot be sealed as evidence', () => {
  const evidence = observed().evidence;
  evidence.cases[4].revocationChecks = [];
  assert.throws(() => bindEvidence(evidence), /revocation timing/);
});

test('stale access seen during polling disqualifies the arm even after denial stabilizes', () => {
  const input = rebind(observed(), (evidence) => {
    evidence.cases[4].revocationChecks.unshift({
      checkedAt: '2026-10-13T00:00:00Z',
      denied: false,
      sourceObjectId: 'reviewer-shared',
    });
  });
  assert.equal(evaluateArm(input, approved).verdict, 'NO-GO');
});

test('whitespace changes inside a checksummed string are tampering, not normalization', () => {
  const input = bindEvidence(baseline('B'));
  input.evidence.reason = ` ${input.evidence.reason} `;
  assert.throws(() => parseEvidence(input), /checksum/);
});

test('denial samples for an unrelated object cannot establish revocation', () => {
  const evidence = observed().evidence;
  evidence.cases[4].revocationChecks[0].sourceObjectId = 'public';
  assert.throws(() => bindEvidence(evidence), /revocation timing/);
});

test('GO requires a specified source ACL mode, identity binding and feature stage', () => {
  const evidence = observed().evidence;
  evidence.configuration = baseline('A').configuration;
  assert.throws(() => bindEvidence(evidence), /complete observed evidence/);
});

for (const failure of ['leak', 'recall', 'latency', 'explicit-no-go', 'incomplete']) {
  test(`available managed ${failure} cannot select an eligible Drive arm`, () => {
    const a = rebind(observed('A'), (evidence) => {
      if (failure === 'leak') evidence.cases[0].responseText = 'C04_BOB_CONTENT';
      if (failure === 'recall') evidence.cases[0].hits = [];
      if (failure === 'latency') evidence.cases[0].latencyMs = 5001;
      if (failure === 'explicit-no-go') evidence.verdict = 'NO-GO';
      if (failure === 'incomplete') evidence.cases[0].latencyMs = null;
    });
    const report = compareArms(a, observed('B'), approved);
    assert.equal(report.arms[1].eligible, true);
    assert.equal(
      report.outcome,
      failure === 'leak' || failure === 'explicit-no-go'
        ? 'NO-GO'
        : failure === 'incomplete'
          ? 'DEFER'
          : 'neither',
    );
    assert.deepEqual(report.blocksIssues, [23, 24]);
  });
}

test('not-probed managed evidence cannot authorize Drive fallback', () => {
  const a = bindEvidence({ ...baseline('A'), availability: 'not-probed' });
  assert.equal(compareArms(a, observed('B'), approved).outcome, 'DEFER');
});

for (const arm of ['A', 'B']) {
  test(`${arm}: comparison evaluates nested extension canaries in responseText`, () => {
    const input = rebind(observed(arm), (evidence) => {
      evidence.cases[0].responseText = JSON.stringify({
        results: [{ document: { structData: { extra: { content: 'C04_BOB_CONTENT' } } } }],
      });
    });
    assert.equal(evaluateArm(input, approved).verdict, 'NO-GO');
  });
}

test('comparison rejects unknown nested evidence fields instead of stripping disclosures', () => {
  for (const target of ['hit', 'provenance', 'check']) {
    const evidence = structuredClone(observed().evidence);
    if (target === 'hit') evidence.cases[0].hits[0].extra = { content: 'C04_BOB_CONTENT' };
    if (target === 'provenance')
      evidence.cases[0].hits[0].provenance.extra = { content: 'C04_BOB_CONTENT' };
    if (target === 'check')
      evidence.cases[4].revocationChecks[0].extra = { content: 'C04_BOB_CONTENT' };
    assert.throws(() => bindEvidence(evidence), /Unrecognized key/);
  }
});
