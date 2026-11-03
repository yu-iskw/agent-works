import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

import { loadDataset } from '../../tools/evals/dataset.mjs';
import { loadInvariantMap } from '../../tools/evals/invariant-check.mjs';
import { buildReport, invariantResultsFromRuns } from '../../tools/evals/release-report.mjs';
import { loadRuntime } from '../../tools/evals/runtime.mjs';
import { scoreDataset } from '../../tools/evals/scorer.mjs';
import {
  evaluateStageGate,
  offlineEvalResults,
  renderStageGate,
} from '../../tools/evals/stage-gate.mjs';

const root = new URL('../../', import.meta.url);

/**
 * Usage: node scripts/ops-03/stage-gate.mjs <input.json>
 * Input: { sourceSha, imageDigests, model?, judge?, runs?, liveResults?, approvers?, gate?, ... }.
 * `runs` maps mapped test files to PASS/FAIL; `liveResults` must carry live-observed provenance.
 * Prints the filled templates/stage-gate.md. Exit 0 only on GO.
 */
export async function runStageGate(input, injectedScore) {
  const dataset = loadDataset({
    splits: ['dev', 'adversarial', 'holdout'],
    includeHoldout: true,
  });
  const score =
    injectedScore ??
    scoreDataset(dataset.cases, await (await loadRuntime()).runDataset(dataset.cases));
  const gateConfig = JSON.parse(readFileSync(new URL('evals/gate-config.json', root), 'utf8'));
  const manifest = JSON.parse(readFileSync(new URL('evals/v1/manifest.json', root), 'utf8'));
  const report = buildReport({
    model: input.model ?? null,
    judge: input.judge ?? { kind: 'deterministic-scorer' },
    dataset: { version: manifest.datasetVersion, fingerprints: dataset.fingerprints },
    sourceSha: input.sourceSha,
    imageDigests: input.imageDigests ?? [],
    results: [
      ...invariantResultsFromRuns(loadInvariantMap(), input.runs ?? {}),
      ...offlineEvalResults(score, gateConfig),
      ...(input.liveResults ?? []),
    ],
  });
  const decision = evaluateStageGate(report, { approvers: input.approvers ?? [] });
  return { text: renderStageGate(report, decision, input), verdict: decision.verdict };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const result = await runStageGate(JSON.parse(readFileSync(process.argv[2], 'utf8')));
    console.log(result.text);
    process.exitCode = result.verdict === 'GO' ? 0 : 1;
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'stage gate could not complete');
    process.exitCode = 2;
  }
}
