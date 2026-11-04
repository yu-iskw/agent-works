// @ts-check
/** @typedef {import('./schema.mjs').EvidenceCase} EvidenceCase */
/** @typedef {import('../../../apps/api/src/retrieval/drive-adapter.ts').DriveAdapterOptions} DriveAdapterOptions */
import { pathToFileURL } from 'node:url';
import { probeDrive } from '../drive/probe.mjs';
import { replayTransport } from '../drive/schema.mjs';
import { replayManaged } from '../managed/replay.mjs';
import { evaluateArm } from './evaluate.mjs';
import { baseline, bindEvidence, readJson } from './fixture-tools.mjs';
import { matrix, matrixCase } from './matrix.mjs';
import { offlineStage } from './schema.mjs';

/** Offline replay of the SAME six-case matrix through the existing arm adapters: managed
 * recording replay, and the real caller-delegated Drive adapter over a fake transport. The
 * output is synthetic evidence that the schema refuses to treat as observed. */
export const offlineLabel = 'OFFLINE-FIXTURE';
const managedDirectory = new URL('../managed/fixtures/', import.meta.url);
const driveDirectory = new URL('../drive/fixtures/', import.meta.url);
const replayInstant = '2026-10-13T00:00:00Z';
const aliases = ['alice-private', 'bob-private', 'reviewer-shared', 'public'];

/**
 * @param {string} scenario
 * @param {string} subjectAlias
 * @returns {Promise<EvidenceCase>}
 */
async function replayDriveCase(scenario, subjectAlias) {
  const replay = replayTransport(readJson(new URL(`${scenario}.json`, driveDirectory)));
  const at = Date.parse(replayInstant);
  const subject = replay.recording.caller;
  const options = {
    caller: { sub: subject, assertion: 'FAKE_REDACTED_IAP' },
    credentialFor: () =>
      Promise.resolve({
        kind: 'user-delegated',
        callerSubject: subject,
        googleSubject: subject,
        accessToken: 'FAKE_REDACTED_DELEGATED',
        expiresAt: at + 60_000,
        scopes: ['https://www.googleapis.com/auth/drive.readonly'],
        identityVerified: true,
        domainWideDelegation: false,
      }),
    policyFor: () =>
      Promise.resolve({
        enterpriseId: 'agent-works',
        classification: 'INTERNAL',
        region: 'asia-northeast1',
      }),
    now: () => at,
    fetch: replay.load,
  };
  const context = {
    userSubject: subject,
    enterpriseId: 'agent-works',
    authorizedGroups: ['reviewers'],
    groupsObservedAt: replayInstant,
    allowedSources: ['drive'],
    taskPurpose: 'ask',
    classificationCeiling: 'INTERNAL',
    allowedRegions: ['asia-northeast1'],
    resultCountLimit: 100,
  };
  const observed = await probeDrive(
    /** @type {DriveAdapterOptions} */ (/** @type {unknown} */ (options)),
    /** @type {never} */ (context),
    scenario,
    {
      callerSubject: subject,
      subjectAlias: /** @type {never} */ (subjectAlias),
      sourceAliases: Object.fromEntries(aliases.map((id) => [id, id])),
    },
  );
  // Replay timings are not measurements.
  return { ...observed, latencyMs: null, checkedAt: null };
}

/**
 * @param {EvidenceCase} entry
 */
function checkCase(entry) {
  const wanted = /** @type {readonly string[]} */ (matrixCase(entry.id).expected);
  const returned = entry.hits.map((hit) => hit.sourceObjectId);
  const missing = wanted.filter((id) => !returned.includes(id));
  return {
    id: entry.id,
    positive: { ok: missing.length === 0, missing },
    unexpected: returned.filter((id) => !wanted.includes(id)),
  };
}

/**
 * @param {'A' | 'B'} arm
 * @param {readonly EvidenceCase[]} cases
 */
function summarize(arm, cases) {
  const result = evaluateArm(
    bindEvidence({
      ...baseline(arm),
      verdict: 'UNVERIFIED',
      availability: 'not-probed',
      reason: `${offlineLabel}: local replay through existing adapters; not live evidence`,
      configuration: {
        sourceAclMode: 'offline-recorded-fixture',
        identityMapping: 'offline-synthetic-alias',
        featureStage: offlineStage,
      },
      cases: [...cases],
    }),
  );
  const checks = cases.map(checkCase);
  const leakFindings = result.findings.filter((item) =>
    ['leak', 'unknown-source', 'provenance'].includes(item.code),
  );
  const functional = checks.every((item) => item.positive.ok && item.unexpected.length === 0);
  return {
    arm,
    label: offlineLabel,
    live: false,
    checks,
    leakFindings,
    offlineChecks: leakFindings.length === 0 && functional ? 'passed' : 'failed',
    armVerdict: result.verdict,
  };
}

/**
 * @param {{ readonly managedCase?: (id: string) => unknown }} [overrides]
 */
export async function runLocalHarness(overrides = {}) {
  const loadManaged =
    overrides.managedCase ?? ((id) => readJson(new URL(`${id}.json`, managedDirectory)));
  const managed = matrix.map((entry) => replayManaged(loadManaged(entry.id)));
  const drive = [];
  for (const entry of matrix) drive.push(await replayDriveCase(entry.id, entry.subject));
  return { A: summarize('A', managed), B: summarize('B', drive) };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void runLocalHarness()
    .then((report) => {
      process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
      if (report.A.offlineChecks !== 'passed' || report.B.offlineChecks !== 'passed')
        process.exitCode = 1;
    })
    .catch(() => {
      process.stderr.write(
        'local harness failed; run pnpm build first (Drive arm needs apps/api/dist)\n',
      );
      process.exitCode = 1;
    });
}
