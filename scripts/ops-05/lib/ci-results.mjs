import { existsSync, readFileSync } from 'node:fs';
import { relative, resolve } from 'node:path';

import { isRepoRelative } from '../../../tools/evals/invariant-check.mjs';
import { sha256 } from './scan.mjs';

const MAX_AGE_MS = 24 * 60 * 60 * 1000;

/** Playwright retries hide nondeterminism, so a flaky test is no evidence of a passing invariant. */
const playwrightOutcome = { expected: 'PASS', unexpected: 'FAIL', flaky: 'FAIL' };
const vitestOutcome = { passed: 'PASS', failed: 'FAIL' };
/** A file keeps its worst test outcome: one skip keeps it from PASS, one failure makes it FAIL. */
const rank = { PASS: 0, SKIP: 1, FAIL: 2 };

/** [file, 'PASS' | 'FAIL' | 'SKIP'] for every test, plus a FAIL for a file that did not load. */
function vitestOutcomes(report, root) {
  return report.testResults.flatMap((file) => {
    const path = relative(root, file.name);
    return [
      ...(file.status === 'failed' ? [[path, 'FAIL']] : []),
      ...file.assertionResults.map((test) => [path, vitestOutcome[test.status] ?? 'SKIP']),
    ];
  });
}

function playwrightOutcomes(report, root) {
  const walk = (suite) => [
    ...(suite.specs ?? []).flatMap((spec) =>
      spec.tests.map((test) => [
        relative(root, resolve(report.config.rootDir, spec.file)),
        playwrightOutcome[test.status] ?? 'SKIP',
      ]),
    ),
    ...(suite.suites ?? []).flatMap(walk),
  ];
  return report.suites.flatMap(walk);
}

const formats = {
  vitest: {
    matches: (report) => Array.isArray(report?.testResults),
    startedAt: (report) => report.startTime,
    outcomes: vitestOutcomes,
  },
  playwright: {
    matches: (report) =>
      Array.isArray(report?.suites) && typeof report?.config?.rootDir === 'string',
    startedAt: (report) => Date.parse(report.stats?.startTime),
    outcomes: playwrightOutcomes,
  },
};

function readReport(path) {
  try {
    const bytes = readFileSync(path);
    return { digest: sha256(bytes), report: JSON.parse(bytes.toString('utf8')) };
  } catch {
    return { digest: null, report: undefined };
  }
}

/** Status of one report; an INGESTED report folds its tests into `worst`. */
function ingest(root, path, { sameSha, generated }, worst) {
  const entry = { path, sha256: null, format: null, startedAt: null, status: 'MISSING', files: 0 };
  const file = resolve(root, path);
  if (!existsSync(file)) return entry;
  const { digest, report } = readReport(file);
  entry.sha256 = digest;
  entry.format = Object.keys(formats).find((name) => formats[name].matches(report)) ?? null;
  if (entry.format === null) return { ...entry, status: 'UNREADABLE' };
  const started = formats[entry.format].startedAt(report);
  entry.startedAt = Number.isFinite(started) ? new Date(started).toISOString() : null;
  const fresh =
    sameSha &&
    entry.startedAt !== null &&
    started <= generated &&
    generated - started <= MAX_AGE_MS;
  if (!fresh) return { ...entry, status: 'STALE' };
  if ((report.errors ?? []).length > 0) return { ...entry, status: 'ERRORED' };
  const files = new Set();
  for (const [test, outcome] of formats[entry.format].outcomes(report, root)) {
    if (!isRepoRelative(test)) continue;
    files.add(test);
    if (rank[outcome] >= rank[worst.get(test) ?? 'PASS']) worst.set(test, outcome);
  }
  return { ...entry, status: files.size === 0 ? 'EMPTY' : 'INGESTED', files: files.size };
}

/**
 * The `runs` map (repo-relative test file to PASS or FAIL) that the stage gate turns into
 * deterministic invariant rows. With `ciResults: { sourceSha, reports }` the map comes only from
 * Vitest or Playwright JSON reports of the same source SHA that started at most a day before
 * `generatedAt`, and replaces `runs`. A missing, unreadable, stale, errored or empty report adds
 * nothing. A file with a skipped test is not PASS, so its invariant stays UNTESTED.
 */
export function resolveRuns(root, { sourceSha, generatedAt, runs, ciResults }) {
  if (ciResults === undefined || ciResults === null) return { runs: runs ?? {}, ciResults: null };
  if (!Array.isArray(ciResults.reports))
    throw new TypeError('ciResults.reports must be an array of report paths');
  const context = {
    sameSha: ciResults.sourceSha === sourceSha,
    generated: Date.parse(generatedAt),
  };
  const worst = new Map();
  const reports = ciResults.reports.map((path) => ingest(root, path, context, worst));
  const tested = [...worst].filter(([, outcome]) => outcome !== 'SKIP');
  return {
    runs: Object.fromEntries(tested),
    ciResults: { sourceSha: ciResults.sourceSha, reports },
  };
}
