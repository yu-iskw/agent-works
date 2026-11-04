import { readFileSync } from 'node:fs';

import { describe, expect, test } from 'vitest';

import { loadDataset } from '../../tools/evals/dataset.mjs';
import { holdoutCoverage } from '../../tools/evals/holdout-classes.mjs';
import {
  checkInvariantMap,
  loadInvariantMap,
  requiredInvariants,
} from '../../tools/evals/invariant-check.mjs';
import {
  buildReport,
  invariantResultsFromRuns,
  ReportRefused,
} from '../../tools/evals/release-report.mjs';
import {
  evaluateStageGate,
  offlineEvalResults,
  renderStageGate,
} from '../../tools/evals/stage-gate.mjs';
import { deriveHoldoutRows } from './extend-holdout.mjs';
import { runStageGate } from './stage-gate.mjs';

const read = (path) => readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8');
const gateConfig = JSON.parse(read('evals/gate-config.json'));
const map = loadInvariantMap();
const dataset = { version: '1.1.0', fingerprints: { holdout: 'a'.repeat(64) } };
const sourceSha = 'b'.repeat(40);
const imageDigests = [`sha256:${'c'.repeat(64)}`];
const model = { name: 'offline-fakes', version: 'n/a' };
const judge = { kind: 'deterministic-scorer' };

const metric = { numerator: 10, denominator: 10, value: 1 };
const perfectScore = (leaks = 0) => ({
  evidence: 'offline-fakes-only',
  realServicesGatePassed: false,
  caseCount: 10,
  security: { leaks, unauthorizedExecutions: 0 },
  metrics: Object.fromEntries(Object.keys(gateConfig.scoreFloors).map((name) => [name, metric])),
  byAclGroup: {},
});

const allPass = (id, label) => ({
  id,
  kind: 'security',
  label,
  provenance: label === 'live' ? 'live-observed' : 'offline-fixture',
  status: 'PASS',
  ref: 'x',
});
const fullResults = () => [
  ...requiredInvariants.flatMap((id) => [
    allPass(`${id}:deterministic`, 'offline'),
    allPass(`${id}:live`, 'live'),
  ]),
  allPass('security:offline-eval', 'offline'),
  { ...allPass('quality:offline-eval', 'offline'), kind: 'quality' },
];
const report = (results) =>
  buildReport({ model, dataset, judge, sourceSha, imageDigests, results });

describe('holdout fixtures', () => {
  const cases = loadDataset({ splits: ['holdout'], includeHoldout: true }).cases;

  test('every release class has holdout cases', () => {
    const coverage = holdoutCoverage(cases);
    expect(Object.keys(coverage)).toHaveLength(6);
    for (const count of Object.values(coverage)) expect(count).toBeGreaterThan(0);
  });

  test('manifest records the extended dataset version and counts', () => {
    const manifest = JSON.parse(read('evals/v1/manifest.json'));
    expect(manifest.datasetVersion).toBe('1.1.0');
    expect(manifest.splits.holdout).toBe(cases.length);
  });

  test('derived rows are idempotent and share no secret text with adversarial', () => {
    const adversarial = read('evals/v1/adversarial.jsonl');
    const derived = deriveHoldoutRows(adversarial);
    expect(derived.length).toBeGreaterThan(0);
    const adversarialText = adversarial.toLowerCase();
    for (const row of derived) {
      expect(row.split).toBe('holdout');
      for (const marker of row.expected.forbiddenMarkers.filter((item) => /\d{4}/.test(item)))
        expect(adversarialText.includes(marker.toLowerCase())).toBe(false);
    }
    expect(new Set(cases.map((row) => row.id)).size).toBe(cases.length);
  });
});

describe('invariant map checker', () => {
  test('the committed map covers every invariant with existing files', () => {
    expect(checkInvariantMap(map)).toEqual([]);
  });

  test('fails when an invariant is unmapped or has no deterministic test', () => {
    const missing = { invariants: map.invariants.filter((item) => item.id !== 'SEC-03') };
    expect(checkInvariantMap(missing)).toContain('SEC-03: invariant is not mapped');
    const empty = structuredClone(map);
    empty.invariants.find((item) => item.id === 'DUR-01').deterministic = [];
    expect(checkInvariantMap(empty)).toContain('DUR-01: no deterministic test mapped');
  });

  test('fails when a mapped file does not exist or escapes the repository', () => {
    const broken = structuredClone(map);
    broken.invariants[0].deterministic.push({ file: 'nope/missing.test.ts' }, { file: '../x.ts' });
    const problems = checkInvariantMap(broken);
    expect(problems).toContain(
      `${broken.invariants[0].id}: mapped test file does not exist: nope/missing.test.ts`,
    );
    expect(problems.some((item) => item.includes('escapes the repository'))).toBe(true);
  });

  test('fails when no live test or operator evidence is named', () => {
    const broken = structuredClone(map);
    broken.invariants[0].live = { files: [] };
    expect(checkInvariantMap(broken)).toContain(
      `${broken.invariants[0].id}: no live test or operator evidence named`,
    );
  });
});

describe('digest-bound report', () => {
  test('refuses an offline fixture labeled live', () => {
    const bad = { ...allPass('SEC-01:live', 'live'), provenance: 'offline-fixture' };
    expect(() => report([bad])).toThrow(ReportRefused);
    expect(() => report([bad])).toThrow('offline-labeled-live');
  });

  test('refuses a label that disagrees with provenance', () => {
    const bad = { ...allPass('SEC-01:deterministic', 'offline'), provenance: 'live-observed' };
    expect(() => report([bad])).toThrow('label-provenance-mismatch');
  });

  test.each([
    { sourceSha: 'abc' },
    { imageDigests: ['sha256:short'] },
    { dataset: { version: '1.1.0' } },
  ])('refuses invalid bindings %j', (override) => {
    expect(() =>
      buildReport({ model, dataset, judge, sourceSha, imageDigests, results: [], ...override }),
    ).toThrow('invalid-binding');
  });

  test('states UNTESTED for absent invariants and records bindings', () => {
    const built = report([]);
    expect(built.sourceSha).toBe(sourceSha);
    expect(built.imageDigests).toEqual(imageDigests);
    expect(built.dataset.version).toBe('1.1.0');
    expect(built.results).toHaveLength(requiredInvariants.length * 2);
    expect(built.results.every((item) => item.status === 'UNTESTED')).toBe(true);
  });

  test('DEFER needs an optional marker and a reason', () => {
    const defer = { ...allPass('memory', 'offline'), status: 'DEFER' };
    expect(() => report([defer])).toThrow('invalid-result');
    expect(() =>
      report([{ ...defer, optional: true, deferReason: 'memory disabled' }]),
    ).not.toThrow();
  });

  test('deterministic status derives from per-file runs', () => {
    const files = map.invariants.flatMap((item) => item.deterministic.map(({ file }) => file));
    const passing = Object.fromEntries(files.map((file) => [file, 'PASS']));
    const results = (runs) => invariantResultsFromRuns(map, runs);
    expect(results(passing).every((item) => item.status === 'PASS')).toBe(true);
    const failing = { ...passing, 'apps/api/src/auth/iap.test.ts': 'FAIL' };
    expect(results(failing).find((item) => item.invariant === 'SEC-01').status).toBe('FAIL');
    const partial = { ...passing };
    delete partial['apps/api/src/broker/approvals.test.ts'];
    expect(results(partial).find((item) => item.invariant === 'SEC-03').status).toBe('UNTESTED');
  });
});

describe('stage gate CLI core', () => {
  test('with no test runs or live evidence the verdict is AWAITING_EVIDENCE', async () => {
    const result = await runStageGate({ sourceSha, imageDigests }, perfectScore());
    expect(result.verdict).toBe('AWAITING_EVIDENCE');
    expect(result.text).toContain('- Verdict: AWAITING_EVIDENCE');
  }, 30000);

  test('a live label on offline provenance is refused', async () => {
    const bad = { ...allPass('SEC-01:live', 'live'), provenance: 'offline-fixture' };
    await expect(
      runStageGate({ sourceSha, imageDigests, liveResults: [bad] }, perfectScore()),
    ).rejects.toThrow('offline-labeled-live');
  }, 30000);
});

describe('stage gate', () => {
  const approvers = ['owner'];

  test('all evidence present and approved is GO', () => {
    expect(evaluateStageGate(report(fullResults()), { approvers }).verdict).toBe('GO');
  });

  test('high quality with one leak is NO-GO', () => {
    const offline = offlineEvalResults(perfectScore(1), { ...gateConfig });
    expect(offline.find((item) => item.id === 'security:offline-eval').status).toBe('FAIL');
    const results = [
      ...fullResults().filter((item) => !item.id.endsWith('offline-eval')),
      ...offline,
    ];
    const decision = evaluateStageGate(report(results), { approvers });
    expect(decision.verdict).toBe('NO-GO');
    expect(decision.reasons).toContain('security failure: security:offline-eval');
  });

  test('a perfect score without a leak passes the offline security result', () => {
    const offline = offlineEvalResults(perfectScore(0), gateConfig);
    expect(offline.find((item) => item.id === 'security:offline-eval').status).toBe('PASS');
    expect(offline.find((item) => item.id === 'quality:offline-eval').status).toBe('UNTESTED');
  });

  test('a failed invariant is NO-GO even when other evidence is missing', () => {
    const results = [{ ...allPass('SEC-02:deterministic', 'offline'), status: 'FAIL' }];
    expect(evaluateStageGate(report(results), { approvers }).verdict).toBe('NO-GO');
  });

  test('missing evidence is AWAITING_EVIDENCE', () => {
    const results = fullResults().filter((item) => item.id !== 'SEC-04:live');
    const decision = evaluateStageGate(report(results), { approvers });
    expect(decision.verdict).toBe('AWAITING_EVIDENCE');
    expect(decision.reasons).toContain('missing evidence: SEC-04:live');
  });

  test('missing owner approval or bindings is AWAITING_EVIDENCE', () => {
    expect(evaluateStageGate(report(fullResults()), { approvers: [] }).verdict).toBe(
      'AWAITING_EVIDENCE',
    );
    const unbound = buildReport({
      dataset,
      sourceSha,
      imageDigests: [],
      results: fullResults(),
    });
    expect(evaluateStageGate(unbound, { approvers }).verdict).toBe('AWAITING_EVIDENCE');
  });

  test('a mandatory invariant cannot be DEFERred', () => {
    const results = fullResults().map((item) =>
      item.id === 'GOV-01:live' ? { ...item, status: 'DEFER', optional: false } : item,
    );
    expect(() => report(results)).toThrow('invalid-result');
  });

  test('an approved-threshold quality failure is NO-GO', () => {
    const results = fullResults().map((item) =>
      item.id === 'quality:offline-eval' ? { ...item, status: 'FAIL' } : item,
    );
    expect(evaluateStageGate(report(results), { approvers }).verdict).toBe('NO-GO');
  });

  test('output follows templates/stage-gate.md and prints the verdict', () => {
    const built = report([]);
    const text = renderStageGate(built, evaluateStageGate(built, { approvers: [] }));
    for (const heading of [
      '# Stage release gate',
      '- Gate G1/G2/G3/G4:',
      '| Requirement | Evidence | Status | Owner |',
      '- Security negative results and positive controls:',
      '- Optional deferred capabilities and proof disabled:',
      '- Residual risks, owner and expiry:',
      '- Recovery/rollback evidence:',
      '- Approvers and date:',
      '- Verdict: AWAITING_EVIDENCE',
    ])
      expect(text).toContain(heading);
    expect(text).toContain('SEC-01:live (live) | none | UNTESTED');
  });
});
