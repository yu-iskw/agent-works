import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { expect, it } from 'vitest';

const root = fileURLToPath(new URL('../../../', import.meta.url));

// Runs in a child so the resolve hook can poison '@google/adk' without affecting this process.
const child = `
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { pathToFileURL } from 'node:url';

let adkResolutions = 0;
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === '@google/adk' || specifier.startsWith('@google/adk/')) {
      adkResolutions += 1;
      throw new Error('@google/adk must not load for an injected runner');
    }
    return next(specifier, context);
  },
});
const tools = (file) => import(pathToFileURL(process.cwd() + '/tools/evals/' + file).href);
const { loadRuntime } = await tools('runtime.mjs');
const { loadDataset } = await tools('dataset.mjs');
const { scoreDataset } = await tools('scorer.mjs');
const { evaluateGate } = await tools('gate.mjs');
const { runCase, runDataset } = await loadRuntime();

let runs = 0;
const runner = () => ({
  run(input) {
    runs += 1;
    return Promise.resolve({
      answer: input.sources.map((s) => s.text + ' [' + s.id + ']').join('\\n'),
      citedSourceIds: input.sources.map((s) => s.id),
    });
  },
});
const { cases } = loadDataset();
const single = await runCase(cases[0], { runner });
const observations = await runDataset(cases, { runner });
const report = scoreDataset(cases, observations);
const gate = evaluateGate(report, JSON.parse(readFileSync('evals/gate-config.json', 'utf8')));
console.log(JSON.stringify({
  caseId: single.caseId,
  observations: observations.length,
  cases: cases.length,
  scored: report.caseCount,
  gateEvaluated: typeof gate.passed === 'boolean',
  injectedRunnerCalls: runs,
  adkResolutions,
}));
`;

it('scores an injected non-ADK runner without ever resolving @google/adk', () => {
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', child], {
    cwd: root,
    encoding: 'utf8',
    timeout: 60_000,
  });
  expect({ status: result.status, stderr: result.stderr }).toMatchObject({ status: 0 });
  const out = JSON.parse(result.stdout) as Record<string, unknown>;
  expect(out).toMatchObject({ adkResolutions: 0, gateEvaluated: true });
  expect(out.observations).toBe(out.cases);
  expect(out.scored).toBe(out.cases);
  expect(out.injectedRunnerCalls).toBeGreaterThan(0);
}, 60_000);
