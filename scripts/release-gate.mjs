import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

import { loadDataset } from '../tools/evals/dataset.mjs';
import { evaluateGate } from '../tools/evals/gate.mjs';
import { loadRuntime } from '../tools/evals/runtime.mjs';
import { scoreDataset } from '../tools/evals/scorer.mjs';

const root = new URL('../', import.meta.url);
const configUrl = new URL('evals/gate-config.json', root);
const resultDir = new URL('evals/results/', root);
const regressionFixtures = new Map([
  ['leak', new URL('evals/results/fixtures/leak-regression.json', root)],
  ['unapproved-call', new URL('evals/results/fixtures/unapproved-call-regression.json', root)],
]);

export function parseGateArgs(args) {
  const options = { includeHoldout: false, regression: null, writeResults: true };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--include-holdout') {
      if (options.includeHoldout) throw new Error('duplicate holdout flag');
      options.includeHoldout = true;
    } else if (arg === '--no-write') options.writeResults = false;
    else if (arg === '--regression') {
      const name = args[++index];
      if (options.regression !== null || !regressionFixtures.has(name))
        throw new Error('unknown regression fixture');
      options.regression = name;
    } else throw new Error('unknown release-gate option');
  }
  return options;
}

export function selectGateSplits(includeHoldout) {
  return includeHoldout === true ? ['dev', 'adversarial', 'holdout'] : ['dev', 'adversarial'];
}

async function runReleaseGate(options = {}) {
  const includeHoldout = options.includeHoldout === true;
  const dataset = loadDataset({
    splits: selectGateSplits(includeHoldout),
    includeHoldout,
  });
  const { runDataset } = await loadRuntime();
  const observations = await runDataset(dataset.cases);
  if (options.regression != null) {
    if (!regressionFixtures.has(options.regression)) throw new Error('unknown regression fixture');
    const seed = JSON.parse(readFileSync(regressionFixtures.get(options.regression), 'utf8'));
    const index = observations.findIndex((observation) => observation.caseId === seed.caseId);
    if (index === -1) throw new Error('regression case not selected');
    observations[index] = { ...observations[index], ...seed.patch };
  }
  const report = scoreDataset(dataset.cases, observations);
  const config = JSON.parse(readFileSync(configUrl, 'utf8'));
  const gate = evaluateGate(report, config);
  const result = {
    ...report,
    dataset: { version: '1.0.0', splits: dataset.splits, fingerprints: dataset.fingerprints },
    gate,
    limitations: [
      'Synthetic answer keys await human review',
      'Thresholds are UNAPPROVED_PLACEHOLDER',
      'Skill revocation lifecycle is blocked by #134',
      'Sandbox egress is simulated; #135 budget and isolation follow-up',
      'Memory deletion is deferred; P4-MEM is not filed',
      'No live evidence for #20–#24, #60 or #105–#112',
    ],
  };
  if (options.writeResults !== false) {
    mkdirSync(resultDir, { recursive: true });
    const suffix = options.regression ?? (includeHoldout ? 'release' : 'dev');
    writeFileSync(
      new URL(`offline-${suffix}.json`, resultDir),
      `${JSON.stringify(result, null, 2)}\n`,
    );
  }
  return result;
}

async function main() {
  try {
    const report = await runReleaseGate(parseGateArgs(process.argv.slice(2)));
    console.log(
      JSON.stringify({
        evidence: report.evidence,
        cases: report.caseCount,
        deferred: report.deferredCount,
        gate: report.gate,
      }),
    );
    if (!report.gate.passed) process.exitCode = 1;
  } catch (error) {
    // Input errors may include secret fixture content; emit a fixed message.
    console.error('offline release gate could not complete; inspect local validated fixtures');
    process.exitCode = 2;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
