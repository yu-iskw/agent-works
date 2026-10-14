import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { scoreCase, scoreDataset } from '../../tools/evals/scorer.mjs';
const root = new URL('./fixtures/', import.meta.url);
mkdirSync(root, { recursive: true });
const seeds = JSON.parse(
  readFileSync(new URL('../results/fixtures/known-grounding.json', import.meta.url), 'utf8'),
);
const selected = new Map();
for (const seed of seeds) {
  const score = scoreCase(seed.case, seed.observation);
  if (
    score.security.leaks === 0 &&
    score.security.unauthorizedExecutions === 0 &&
    !selected.has(seed.case.id)
  )
    selected.set(seed.case.id, seed);
}
const fixtures = [...selected.values()];
const report = scoreDataset(
  fixtures.map((row) => row.case),
  fixtures.map((row) => row.observation),
);
const fingerprint = (await import('node:crypto'))
  .createHash('sha256')
  .update(JSON.stringify(fixtures))
  .digest('hex');
for (const [name, modelId] of [
  ['baseline', 'fixture-gemini-default'],
  ['candidate', 'fixture-gemini-fast'],
]) {
  const output = {
    ...report,
    dataset: { version: '1.0.0', splits: ['dev'], fingerprints: { dev: fingerprint } },
    routingEvidence: {
      model: {
        modelId,
        version: 'offline-1',
        region: 'asia-northeast1',
        governanceZone: 'fixture',
      },
      taskClass: 'research',
    },
    limitations: [
      'Derived identical observations prove contract plumbing only; no evidence of faster, cheaper or better real models.',
    ],
  };
  writeFileSync(new URL(`routing-${name}.json`, root), JSON.stringify(output, null, 2) + '\n');
}
