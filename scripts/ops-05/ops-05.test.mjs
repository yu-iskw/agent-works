import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { beforeAll, describe, expect, it } from 'vitest';

import {
  BundleRefused,
  buildBundle,
  migrationEntries,
  verifyBundle,
  writeBundle,
} from './build-bundle.mjs';
import { resolveRuns } from './lib/ci-results.mjs';
import { formatMarkdown } from './lib/format.mjs';
import { gateTasks } from './lib/gates.mjs';
import {
  declaredStatus,
  localResult,
  planDir,
  resultCounts,
  scanTasks,
  sha256,
} from './lib/scan.mjs';
import { parseSecurity } from './lib/security.mjs';
import { renderGates } from './render-gates.mjs';
import { renderDecisionStatus, renderOperatorIndex } from './render-index.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '../..');
const opsDir = join(root, planDir, 'ops-05');
const input = JSON.parse(readFileSync(join(opsDir, 'inputs/release-input.json'), 'utf8'));
const securityRecord = JSON.parse(readFileSync(join(opsDir, 'inputs/lint-security.json'), 'utf8'));
const sha = input.sourceSha;
const digest = `sha256:${'a'.repeat(64)}`;
const knownId = 'osv-scanner/GHSA-g3hv-75wg-m249';
const base = { root, sourceSha: sha, generatedAt: '2026-11-04T00:00:00.000Z' };
const passing = { output: 'Checked 119 files\nNo issues', exitCode: 0 };
const liveRow = (overrides = {}) => ({
  id: 'SEC-01:live',
  kind: 'security',
  invariant: 'SEC-01',
  label: 'live',
  provenance: 'live-observed',
  status: 'PASS',
  ...overrides,
});

describe('security parsing', () => {
  it('parses the captured Trunk output and keeps the known advisory as FAIL', () => {
    const result = parseSecurity(securityRecord);
    expect(result.status).toBe('FAIL');
    expect(result.exitCode).toBe(1);
    expect(result.findings.map((item) => item.id)).toEqual(expect.arrayContaining([knownId]));
    expect(result.findings.every((item) => item.status === 'FAIL')).toBe(true);
  });

  it('parses Trivy findings from Trunk output by file and rule', () => {
    const output =
      'infra/terraform/modules/x/main.tf:41:0\n 41:0  high  Bucket not versioned.  trivy/GCP-0078\nChecked 1 files';
    const result = parseSecurity({ output, exitCode: 1 });
    expect(result.findings).toContainEqual(
      expect.objectContaining({
        id: 'trivy/GCP-0078',
        file: 'infra/terraform/modules/x/main.tf',
        status: 'FAIL',
      }),
    );
  });

  it('records the known minimatch advisory as FAIL even when the output omits it', () => {
    const result = parseSecurity({ output: 'something failed', exitCode: 1 });
    const known = result.findings.find((item) => item.id === knownId);
    expect(known).toMatchObject({ status: 'FAIL', source: 'known-baseline' });
    expect(result.status).toBe('FAIL');
  });

  it('is BLOCKED, not PASS, when no output was observed, and still lists the known FAIL', () => {
    const result = parseSecurity({});
    expect(result.status).toBe('BLOCKED');
    expect(result.findings.map((item) => item.id)).toContain(knownId);
  });

  it('passes only for exit 0 with no findings and does not invent the advisory', () => {
    const result = parseSecurity(passing);
    expect(result).toMatchObject({ status: 'PASS', findings: [] });
  });
});

describe('status scanning', () => {
  it('treats "not VALIDATED" as a denial and never infers upward', () => {
    expect(declaredStatus('Status READY_FOR_REVIEW (not VALIDATED)')).toBe('READY_FOR_REVIEW');
    expect(declaredStatus('nothing declared, Not VALIDATED')).toBe('UNSTATED');
  });

  it('keeps pending live rows out of the local result', () => {
    const table = [
      '| Criterion | Result | Local or live |',
      '| a | PASS | local |',
      '| b | UNTESTED | live |',
      '| c | AWAITING_OPERATOR | live |',
    ].join('\n');
    const counts = resultCounts(table);
    expect(counts).toMatchObject({ PASS: 1, UNTESTED: 0, LIVE_ROWS: 2 });
    expect(localResult({ status: 'READY_FOR_REVIEW', counts })).toBe('PASS');
  });

  it('fails on a FAIL row and is UNTESTED on a BLOCKED row or a missing file', () => {
    const status = 'READY_FOR_REVIEW';
    expect(localResult({ status, counts: resultCounts('| x | FAIL |') })).toBe('FAIL');
    expect(localResult({ status, counts: resultCounts('| x | BLOCKED |') })).toBe('UNTESTED');
    const [missing] = scanTasks(root, ['NO-SUCH-TASK']);
    expect(missing).toMatchObject({
      evidence: null,
      local: 'UNTESTED',
      declaredStatus: 'NO_EVIDENCE',
    });
  });
});

describe('evidence bundle', () => {
  let bundle;
  beforeAll(() => {
    bundle = buildBundle({ ...base, imageDigests: [digest], securityInput: securityRecord });
  });

  it('binds sha, digests, all 34 migrations, configs, corpus and invariant map', () => {
    expect(bundle).toMatchObject({ sourceSha: sha, imageDigests: [digest], missingBindings: [] });
    expect(bundle.label).toBe('offline');
    expect(bundle.notAReleaseApproval).toBe(true);
    expect(bundle.migrations).toMatchObject({
      count: 34,
      first: '0001',
      last: '0034',
      contiguous: true,
    });
    const gateConfig = bundle.configRevisions.find((c) => c.path === 'evals/gate-config.json');
    expect(gateConfig.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(bundle.testCorpus.datasetVersion).toMatch(/^\d+\.\d+\.\d+$/);
    expect(bundle.testCorpus.thresholdStatus).toBe('UNAPPROVED_PLACEHOLDER');
    expect(bundle.invariantMap.ok).toBe(true);
    expect(bundle.security.status).toBe('FAIL');
  });

  it('hashes every file of every task folder, evidence.md included', () => {
    const acl = bundle.evidence.tasks.find((task) => task.id === 'ACL-01');
    expect(acl.files.map((f) => f.path)).toContain(`${planDir}/acl-01/evidence.md`);
    expect(bundle.evidence.fileCount).toBeGreaterThan(40);
    expect(verifyBundle(bundle, root)).toEqual([]);
  });

  it('marks absent bindings instead of inventing them', () => {
    const empty = buildBundle({ ...base, securityInput: securityRecord });
    expect(empty.missingBindings).toEqual(['imageDigests']);
  });

  it('lists AGT-05 and AGT-06 as DEFER with guard tests', () => {
    expect(bundle.deferredCapabilities.map((c) => [c.task, c.verdict, c.optional])).toEqual([
      ['AGT-05', 'DEFER', true],
      ['AGT-06', 'DEFER', true],
    ]);
    for (const capability of bundle.deferredCapabilities)
      for (const test of capability.disabledProof.guardTests)
        expect(existsSync(join(root, test))).toBe(true);
  });

  it('is deterministic and its digest covers the content', () => {
    const again = buildBundle({ ...base, imageDigests: [digest], securityInput: securityRecord });
    expect(again.bundleDigest).toBe(bundle.bundleDigest);
    const other = buildBundle({ ...base, imageDigests: [digest], securityInput: passing });
    expect(other.bundleDigest).not.toBe(bundle.bundleDigest);
  });

  it('detects a tampered digest, a changed file and a removed file', () => {
    expect(verifyBundle({ ...bundle, sourceSha: 'b'.repeat(40) }, root)).toContain(
      'bundle digest mismatch',
    );
    const temp = mkdtempSync(join(tmpdir(), 'ops05-verify-'));
    const acl = bundle.evidence.tasks.find((task) => task.id === 'ACL-01').files[0].path;
    const other = bundle.evidence.tasks.find((task) => task.id === 'SCH-01').files[0].path;
    mkdirSync(dirname(join(temp, acl)), { recursive: true });
    writeFileSync(join(temp, acl), 'edited');
    const problems = verifyBundle(bundle, temp);
    expect(problems).toContain(`evidence file changed: ${acl}`);
    expect(problems).toContain(`missing evidence file: ${other}`);
  });

  it('never overwrites an existing bundle', () => {
    const out = mkdtempSync(join(tmpdir(), 'ops05-out-'));
    const path = writeBundle(bundle, out);
    expect(path).toContain(bundle.bundleDigest.slice(0, 12));
    expect(() => writeBundle(bundle, out)).toThrow(BundleRefused);
    expect(JSON.parse(readFileSync(path, 'utf8')).bundleDigest).toBe(bundle.bundleDigest);
  });
});

describe('live labeling', () => {
  it('refuses an offline-provenance result labeled live', () => {
    const bad = liveRow({ provenance: 'offline-fixture' });
    expect(() => buildBundle({ ...base, securityInput: passing, liveResults: [bad] })).toThrow(
      expect.objectContaining({ code: 'offline-labeled-live' }),
    );
  });

  it('refuses a live label with no live-observed evidence', () => {
    expect(() => buildBundle({ ...base, securityInput: passing, label: 'live' })).toThrow(
      expect.objectContaining({ code: 'live-label-without-live-evidence' }),
    );
    const offlineOnly = liveRow({ label: 'offline', provenance: 'offline-fixture' });
    expect(() =>
      buildBundle({ ...base, securityInput: passing, label: 'live', liveResults: [offlineOnly] }),
    ).toThrow(BundleRefused);
  });

  it('labels the bundle live only when live-observed results exist', () => {
    const live = buildBundle({
      ...base,
      securityInput: passing,
      label: 'live',
      liveResults: [liveRow()],
    });
    expect(live.label).toBe('live');
    expect(live.live.results.map((r) => r.id)).toEqual(['SEC-01:live']);
  });

  it('refuses invalid bindings', () => {
    expect(() => buildBundle({ ...base, sourceSha: 'abc', securityInput: passing })).toThrow(
      BundleRefused,
    );
    expect(() =>
      buildBundle({ ...base, imageDigests: ['latest'], securityInput: passing }),
    ).toThrow(BundleRefused);
  });
});

describe('migration completeness', () => {
  it('flags a gap in the version sequence', () => {
    const temp = mkdtempSync(join(tmpdir(), 'ops05-mig-'));
    const dir = join(temp, 'apps/api/migrations');
    mkdirSync(dir, { recursive: true });
    for (const name of ['0001_a.sql', '0003_c.sql']) writeFileSync(join(dir, name), '-- x');
    const result = migrationEntries(temp);
    expect(result.contiguous).toBe(false);
    expect(result.problems).toHaveLength(1);
  });

  it('matches the real directory: 0001 to 0034', () => {
    expect(migrationEntries(root)).toMatchObject({ count: 34, contiguous: true, last: '0034' });
  });
});

const gateConfig = JSON.parse(readFileSync(join(root, 'evals/gate-config.json'), 'utf8'));
const metric = { numerator: 10, denominator: 10, value: 1 };
const score = {
  evidence: 'offline-fakes-only',
  realServicesGatePassed: false,
  caseCount: 10,
  security: { leaks: 0, unauthorizedExecutions: 0 },
  metrics: Object.fromEntries(Object.keys(gateConfig.scoreFloors).map((name) => [name, metric])),
  byAclGroup: {},
};

describe('stage gate records', () => {
  it('G1..G4 verdicts on the real tree are NO-GO or AWAITING_EVIDENCE, never GO', async () => {
    const gates = await renderGates({ root, input, score });
    for (const gate of ['G1', 'G2', 'G3', 'G4']) {
      expect(['NO-GO', 'AWAITING_EVIDENCE']).toContain(gates[gate].verdict);
      expect(gates[gate].text).toContain(`Verdict: ${gates[gate].verdict}`);
      expect(gates[gate].text).toContain('missing owner approval');
      expect(gates[gate].text).not.toContain('Verdict: GO');
    }
    expect(gates.G1.verdict).toBe('NO-GO');
    expect(gates.G4.text).toContain('G1:gate-record');
  });

  it('without the security failure the gates wait for evidence, still never GO', async () => {
    const quiet = { ...input, securityFile: undefined, security: passing };
    const gates = await renderGates({ root, input: quiet, score });
    for (const gate of Object.values(gates)) expect(gate.verdict).toBe('AWAITING_EVIDENCE');
  });

  it('G3 carries AGT-05 and AGT-06 as DEFER and every live row as UNTESTED', async () => {
    const { G3 } = await renderGates({ root, input, score });
    expect(G3.text).toMatch(/AGT-05:capability[^\n]*\| DEFER \|/);
    expect(G3.text).toMatch(/AGT-06:capability[^\n]*\| DEFER \|/);
    expect(G3.text).toMatch(/G3:live:dag-recovery[^\n]*\| UNTESTED \|/);
    expect(G3.text).not.toMatch(/:live[^\n]*\| PASS \|/);
  });

  it('committed gate files equal the regenerated ones', async () => {
    const gates = await renderGates({ root, input, score });
    for (const gate of Object.keys(gates))
      expect(readFileSync(join(opsDir, 'gates', `${gate}.md`), 'utf8')).toBe(
        await formatMarkdown(gates[gate].text, join(opsDir, 'gates', `${gate}.md`)),
      );
  });
});

describe('CI test results', () => {
  const at = Date.parse(base.generatedAt);
  const invariants = JSON.parse(readFileSync(join(root, 'tools/evals/invariant-map.json'), 'utf8'));
  const sec04 = invariants.invariants
    .find((item) => item.id === 'SEC-04')
    .deterministic.map((item) => item.file);
  const vitestReport = (statuses, startTime = at - 60_000) => ({
    startTime,
    testResults: Object.entries(statuses).map(([file, status]) => {
      const tests = [status].flat();
      return {
        name: join(root, file),
        status: tests.includes('failed') ? 'failed' : 'passed',
        assertionResults: tests.map((test) => ({ title: 'case', status: test })),
      };
    }),
  });
  const playwrightReport = (statuses, { startTime = at - 60_000, errors = [] } = {}) => ({
    config: { rootDir: join(root, 'e2e') },
    suites: Object.entries(statuses).map(([file, status]) => ({
      title: file,
      file,
      specs: [{ title: 'case', file, tests: [{ status }] }],
    })),
    errors,
    stats: { startTime: new Date(startTime).toISOString() },
  });
  const writeReports = (...bodies) => {
    const dir = mkdtempSync(join(tmpdir(), 'ops05-ci-'));
    return bodies.map((body, index) => {
      const path = join(dir, `report-${index}.json`);
      writeFileSync(path, typeof body === 'string' ? body : JSON.stringify(body));
      return path;
    });
  };
  const resolve = (reports, ciSha = sha) =>
    resolveRuns(root, { ...base, ciResults: { sourceSha: ciSha, reports } });
  const allPass = (files) => Object.fromEntries(files.map((file) => [file, 'passed']));

  it('keeps explicit runs and records no CI provenance without ciResults', () => {
    const explicit = { runs: { 'a.test.ts': 'PASS' }, ciResults: null };
    expect(resolveRuns(root, { ...base, runs: explicit.runs })).toEqual(explicit);
    expect(resolveRuns(root, { ...base, runs: explicit.runs, ciResults: null })).toEqual(explicit);
    expect(() => resolve(undefined)).toThrow('ciResults.reports must be an array');
  });

  it('reads Vitest and Playwright reports: FAIL wins, flaky fails, any skip leaves a file untested', () => {
    const reports = writeReports(
      vitestReport({
        'tools/evals/gate.test.mjs': 'passed',
        'scripts/release-gate.test.mjs': 'passed',
        'scripts/acl-01/acl-01.test.mjs': ['passed', 'skipped'],
      }),
      vitestReport({
        'scripts/release-gate.test.mjs': 'failed',
        'tools/evals/scorer.test.mjs': 'skipped',
      }),
      {
        startTime: at - 60_000,
        testResults: [
          {
            name: join(root, 'scripts/reconcile-audit.test.mjs'),
            status: 'failed',
            assertionResults: [],
          },
        ],
      },
      playwrightReport({
        'security/approval.spec.ts': 'expected',
        'adversarial/duplicate-delivery.spec.ts': 'flaky',
        'security/retrieval.spec.ts': 'skipped',
      }),
      vitestReport({ '../outside/escape.test.ts': 'passed' }),
    );
    const { runs, ciResults } = resolve(reports);
    expect(runs).toEqual({
      'tools/evals/gate.test.mjs': 'PASS',
      'scripts/release-gate.test.mjs': 'FAIL',
      'scripts/reconcile-audit.test.mjs': 'FAIL',
      'e2e/security/approval.spec.ts': 'PASS',
      'e2e/adversarial/duplicate-delivery.spec.ts': 'FAIL',
    });
    expect(ciResults.reports.map((r) => [r.format, r.status, r.files])).toEqual([
      ['vitest', 'INGESTED', 3],
      ['vitest', 'INGESTED', 2],
      ['vitest', 'INGESTED', 1],
      ['playwright', 'INGESTED', 3],
      ['vitest', 'EMPTY', 0],
    ]);
    expect(ciResults.reports[0].sha256).toBe(sha256(readFileSync(reports[0])));
  });

  it('adds nothing from a missing, unreadable, stale or errored report', () => {
    const [fresh, unreadable, old, future, errored] = writeReports(
      vitestReport(allPass(sec04)),
      '{ not json',
      vitestReport(allPass(sec04), at - 2 * 86_400_000),
      vitestReport(allPass(sec04), at + 60_000),
      playwrightReport(
        { 'security/approval.spec.ts': 'expected' },
        { errors: [{ message: 'SyntaxError in security/identity.forged.spec.ts' }] },
      ),
    );
    const missing = join(dirname(fresh), 'absent.json');
    const statuses = (result) => result.ciResults.reports.map((r) => r.status);
    const local = resolve([missing, unreadable, old, future, errored]);
    expect(local.runs).toEqual({});
    expect(statuses(local)).toEqual(['MISSING', 'UNREADABLE', 'STALE', 'STALE', 'ERRORED']);
    const otherCommit = resolve([fresh], 'c'.repeat(40));
    expect(otherCommit.runs).toEqual({});
    expect(statuses(otherCommit)).toEqual(['STALE']);
  });

  it('turns passing CI files into a PASS row while live rows stay UNTESTED and the gate NO-GO', async () => {
    const [report] = writeReports(vitestReport(allPass(sec04)));
    const ciResults = { sourceSha: sha, reports: [report] };
    const { G1 } = await renderGates({ root, input: { ...input, ciResults }, score });
    expect(G1.text).toMatch(/SEC-04:deterministic[^\n]*\| PASS \|/);
    expect(G1.text).toMatch(/SEC-01:deterministic[^\n]*\| UNTESTED \|/);
    expect(G1.text).toMatch(/SEC-04:live[^\n]*\| UNTESTED \|/);
    expect(G1.text).toMatch(/G1:live:private-ingress[^\n]*AWAITING_OPERATOR/);
    expect(G1.text).not.toContain('missing evidence: SEC-04:deterministic');
    expect(G1.text).toContain(`${report}\`: INGESTED (vitest`);
    expect(G1.verdict).toBe('NO-GO');
  });

  it('a failing CI file fails its invariant row and blocks the gate', async () => {
    const [report] = writeReports(vitestReport({ ...allPass(sec04), [sec04[0]]: 'failed' }));
    const ciResults = { sourceSha: sha, reports: [report] };
    const { G1 } = await renderGates({ root, input: { ...input, ciResults }, score });
    expect(G1.text).toMatch(/SEC-04:deterministic[^\n]*\| FAIL \|/);
    expect(G1.text).toContain('security failure: SEC-04:deterministic');
  });

  it('binds the ingested runs and their provenance into the bundle digest', () => {
    const [report] = writeReports(vitestReport(allPass(sec04)));
    const withCi = buildBundle({
      ...base,
      securityInput: passing,
      ciResults: { sourceSha: sha, reports: [report] },
    });
    expect(withCi.invariantMap.deterministicRuns).toEqual(
      Object.fromEntries(sec04.map((file) => [file, 'PASS'])),
    );
    expect(withCi.ciResults.reports).toMatchObject([{ status: 'INGESTED', files: sec04.length }]);
    expect(verifyBundle(withCi, root)).toEqual([]);
    const without = buildBundle({ ...base, securityInput: passing });
    expect(without.ciResults).toBeNull();
    expect(without.bundleDigest).not.toBe(withCi.bundleDigest);
  });
});

describe('operator index and decisions', () => {
  const committed = (name) => readFileSync(join(opsDir, name), 'utf8');
  const formatted = (text, name) => formatMarkdown(text, join(opsDir, name));

  it('lists every AWAITING_OPERATOR line once and matches the committed file', async () => {
    const rendered = renderOperatorIndex(root);
    expect(committed('operator-action-index.md')).toBe(
      await formatted(rendered, 'operator-action-index.md'),
    );
    const ids = [...new Set(Object.values(gateTasks).flat())];
    const tasks = scanTasks(root, ids, { skipDirs: ['ops-05'] });
    const total = tasks.reduce((n, task) => n + task.operatorItems.length, 0);
    expect(rendered).toContain(`each task counted once): ${total}`);
    expect(total).toBeGreaterThan(30);
    for (const task of tasks)
      for (const item of task.operatorItems)
        expect(rendered).toContain(`${item.file.split('/').slice(-2).join('/')}:${item.line}`);
  });

  it('decision status matches the FND-01 matrix: 12 decisions and 8 items, none accepted', async () => {
    const rendered = renderDecisionStatus(root);
    expect(committed('decisions-status.md')).toBe(await formatted(rendered, 'decisions-status.md'));
    for (let n = 1; n <= 12; n += 1) expect(rendered).toContain(`D-${String(n).padStart(2, '0')}`);
    for (let n = 1; n <= 8; n += 1) expect(rendered).toContain(`O0${n}`);
    expect(rendered).toContain('Open: 12 of 12 decisions, 8 of 8 open items.');
  });
});

describe('documentation links', () => {
  it('every relative markdown link in the ops-05 docs and the plan index resolves', () => {
    const docs = [
      'rollout-rollback.md',
      'go-no-go-form.md',
      'residual-risk-register.md',
      'evidence.md',
      'operator-action-index.md',
      'decisions-status.md',
      'gates/G1.md',
      'gates/G4.md',
    ];
    const files = [join(root, planDir, 'README.md'), ...docs.map((f) => join(opsDir, f))];
    const missing = [];
    for (const file of files)
      for (const [, target] of readFileSync(file, 'utf8').matchAll(/\]\(([^)#\s]+)(?:#[^)]*)?\)/g))
        if (!/^(https?:|mailto:)/.test(target) && !existsSync(join(dirname(file), target)))
          missing.push(`${file.replace(root, '')} -> ${target}`);
    expect(missing).toEqual([]);
  });
});
