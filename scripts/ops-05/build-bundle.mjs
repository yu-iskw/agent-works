import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { loadDataset } from '../../tools/evals/dataset.mjs';
import { checkInvariantMap, loadInvariantMap } from '../../tools/evals/invariant-check.mjs';
import { buildReport, ReportRefused } from '../../tools/evals/release-report.mjs';
import { gateTasks, optionalCapabilities } from './lib/gates.mjs';
import { canonicalJson, planDir, readJson, scanTasks, sha256 } from './lib/scan.mjs';
import { parseSecurity } from './lib/security.mjs';

export class BundleRefused extends Error {
  /** @param {'offline-labeled-live' | 'live-label-without-live-evidence' | 'invalid-binding' | 'invalid-result' | 'migrations-incomplete' | 'output-exists'} code */
  constructor(code) {
    super(`evidence bundle refused: ${code}`);
    this.name = 'BundleRefused';
    this.code = code;
  }
}

const configFiles = [
  'evals/gate-config.json',
  'evals/v1/manifest.json',
  'tools/evals/invariant-map.json',
  'pnpm-workspace.yaml',
  'pnpm-lock.yaml',
  '.trunk/trunk.yaml',
  'docs/security/controls.yaml',
  `${planDir}/fnd-01/readiness-matrix.json`,
];

const allTasks = [...new Set(Object.values(gateTasks).flat())];

export function migrationEntries(root) {
  const dir = join(root, 'apps/api/migrations');
  const files = readdirSync(dir)
    .filter((name) => /^\d{4}_.+\.sql$/.test(name))
    .sort();
  const versions = files.map((file) => ({
    version: file.slice(0, 4),
    file: `apps/api/migrations/${file}`,
    sha256: sha256(readFileSync(join(dir, file))),
  }));
  const problems = [];
  versions.forEach((entry, index) => {
    if (Number(entry.version) !== index + 1)
      problems.push(`gap or duplicate at ${entry.version} (expected ${index + 1})`);
  });
  return {
    count: versions.length,
    first: versions[0]?.version ?? null,
    last: versions.at(-1)?.version ?? null,
    contiguous: problems.length === 0,
    problems,
    versions,
  };
}

function configRevisions(root) {
  return configFiles.map((path) => {
    const file = join(root, path);
    return existsSync(file)
      ? { path, sha256: sha256(readFileSync(file)), status: 'PRESENT' }
      : { path, sha256: null, status: 'UNTESTED' };
  });
}

function deferredCapabilities(root) {
  return optionalCapabilities.map((item) => {
    const record = existsSync(join(root, item.record))
      ? readFileSync(join(root, item.record), 'utf8')
      : null;
    const testsPresent = item.tests.every((test) => existsSync(join(root, test)));
    const verdictDefer =
      record !== null && /Default and current verdict: \*\*DEFER\*\*/.test(record);
    return {
      task: item.task,
      capability: item.capability,
      verdict: verdictDefer && testsPresent ? 'DEFER' : 'UNTESTED',
      optional: true,
      disabledProof: {
        label: 'offline',
        guardTests: item.tests,
        testsPresent,
        decisionRecord: item.record,
        decisionRecordIsDefer: verdictDefer,
        note: 'The guard denies without a sealed GO record; no GO record exists in the repository. Test files are listed, not re-run, by this builder.',
      },
    };
  });
}

/** Validates operator-supplied live results with the OPS-03 admission rules. */
function admitLive({ liveResults, sourceSha, imageDigests, dataset }) {
  try {
    const report = buildReport({ dataset, sourceSha, imageDigests, results: liveResults });
    const ids = new Set(liveResults.map((item) => item.id));
    return report.results.filter((item) => ids.has(item.id));
  } catch (error) {
    if (error instanceof ReportRefused) {
      const map = {
        'offline-labeled-live': 'offline-labeled-live',
        'invalid-binding': 'invalid-binding',
      };
      throw new BundleRefused(map[error.code] ?? 'invalid-result');
    }
    throw error;
  }
}

/**
 * Builds the immutable evidence bundle manifest. Everything computed here is offline. A bundle
 * is labeled live only when it carries live-observed results, and an offline-provenance result
 * labeled live is refused.
 */
export function buildBundle({
  root,
  sourceSha,
  imageDigests = [],
  securityInput,
  liveResults = [],
  label = 'offline',
  generatedAt,
  runs = {},
}) {
  const dataset = loadDataset({ splits: ['dev', 'adversarial', 'holdout'], includeHoldout: true });
  const manifest = readJson(root, 'evals/v1/manifest.json');
  const datasetBinding = { version: manifest.datasetVersion, fingerprints: dataset.fingerprints };
  const admittedLive = admitLive({
    liveResults,
    sourceSha,
    imageDigests,
    dataset: datasetBinding,
  });
  const liveObserved = admittedLive.filter((item) => item.provenance === 'live-observed');
  if (label === 'live' && liveObserved.length === 0)
    throw new BundleRefused('live-label-without-live-evidence');
  const migrations = migrationEntries(root);
  if (!migrations.contiguous) throw new BundleRefused('migrations-incomplete');
  const invariantMap = loadInvariantMap();
  const problems = checkInvariantMap(invariantMap, { root: pathToFileURL(`${root}/`) });
  const taskScans = scanTasks(root, allTasks, { evidenceOnly: ['ops-05'] });
  const tasks = taskScans.map(({ operatorItems, files, ...task }) => ({
    ...task,
    awaitingOperatorLines: operatorItems.length,
    files,
  }));
  const body = {
    schemaVersion: '1.0.0',
    kind: 'epv1-release-evidence-bundle',
    label: liveObserved.length > 0 ? label : 'offline',
    notAReleaseApproval: true,
    generatedAt,
    sourceSha,
    imageDigests,
    missingBindings: imageDigests.length > 0 ? [] : ['imageDigests'],
    migrations,
    configRevisions: configRevisions(root),
    testCorpus: {
      datasetVersion: manifest.datasetVersion,
      manifestSha256: sha256(readFileSync(join(root, 'evals/v1/manifest.json'))),
      fingerprints: dataset.fingerprints,
      thresholdStatus: readJson(root, 'evals/gate-config.json').thresholdStatus,
    },
    invariantMap: {
      sha256: sha256(readFileSync(join(root, 'tools/evals/invariant-map.json'))),
      ok: problems.length === 0,
      problems,
      deterministicRuns: runs,
    },
    security: parseSecurity(securityInput ?? {}),
    deferredCapabilities: deferredCapabilities(root),
    evidence: {
      taskCount: tasks.length,
      fileCount: tasks.reduce((n, t) => n + t.files.length, 0),
      tasks,
    },
    live: { results: admittedLive },
  };
  return { ...body, bundleDigest: sha256(canonicalJson(body)) };
}

/** Recomputes every digest. Returns problems; empty means the bundle matches the tree. */
export function verifyBundle(bundle, root) {
  const problems = [];
  const { bundleDigest, ...body } = bundle;
  if (sha256(canonicalJson(body)) !== bundleDigest) problems.push('bundle digest mismatch');
  for (const task of body.evidence.tasks)
    for (const file of task.files) {
      const path = join(root, file.path);
      if (!existsSync(path)) problems.push(`missing evidence file: ${file.path}`);
      else if (sha256(readFileSync(path)) !== file.sha256)
        problems.push(`evidence file changed: ${file.path}`);
    }
  for (const entry of body.migrations.versions) {
    const path = join(root, entry.file);
    if (!existsSync(path) || sha256(readFileSync(path)) !== entry.sha256)
      problems.push(`migration changed: ${entry.file}`);
  }
  for (const entry of body.configRevisions)
    if (entry.sha256) {
      const path = join(root, entry.path);
      if (!existsSync(path) || sha256(readFileSync(path)) !== entry.sha256)
        problems.push(`config changed: ${entry.path}`);
    }
  return problems;
}

/** Writes bundle-<digest12>.json without overwriting. */
export function writeBundle(bundle, outDir) {
  mkdirSync(outDir, { recursive: true });
  const path = join(outDir, `bundle-${bundle.bundleDigest.slice(0, 12)}.json`);
  try {
    writeFileSync(path, `${JSON.stringify(bundle, null, 2)}\n`, { flag: 'wx' });
  } catch (error) {
    if (error?.code === 'EEXIST') throw new BundleRefused('output-exists');
    throw error;
  }
  return path;
}

/**
 * Usage: node scripts/ops-05/build-bundle.mjs <input.json> <outDir>
 * Input: { sourceSha, imageDigests?, security: { output, exitCode } | securityFile, liveResults?,
 *          label?, generatedAt?, runs? }. Exit 0 means a bundle was written, not that a release is approved.
 */
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const root = new URL('../../', import.meta.url).pathname.replace(/\/$/, '');
    const input = JSON.parse(readFileSync(process.argv[2], 'utf8'));
    const securityInput = input.securityFile ? readJson(root, input.securityFile) : input.security;
    const bundle = buildBundle({
      root,
      sourceSha: input.sourceSha,
      imageDigests: input.imageDigests,
      securityInput,
      liveResults: input.liveResults,
      label: input.label,
      generatedAt: input.generatedAt ?? new Date().toISOString(),
      runs: input.runs,
    });
    console.log(writeBundle(bundle, process.argv[3]));
    console.log(`bundleDigest ${bundle.bundleDigest}`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'bundle could not be built');
    process.exitCode = 1;
  }
}
