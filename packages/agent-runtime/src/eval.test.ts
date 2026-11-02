import { readFileSync } from 'node:fs';

import { afterEach, describe, expect, it, vi } from 'vitest';
import * as z from 'zod';

import { listAgents, runAgent, runEval } from './eval.js';

const root = new URL('../../../', import.meta.url);
const observationSchema = z.fromJSONSchema(
  // eslint-disable-next-line security/detect-non-literal-fs-filename
  JSON.parse(readFileSync(new URL('evals/v1/observation.schema.json', root), 'utf8')) as Parameters<
    typeof z.fromJSONSchema
  >[0],
);
const dataset = (split: string) => `evals/v1/${split}.jsonl`;
const absolute = (split: string) => new URL(dataset(split), root).pathname;
const tool = async <T>(file: string): Promise<T> =>
  (await import(new URL(`tools/evals/${file}`, root).href)) as T;
const firstRow = (split: string): unknown =>
  // eslint-disable-next-line security/detect-non-literal-fs-filename
  JSON.parse(readFileSync(absolute(split), 'utf8').split('\n')[0]);

afterEach(() => {
  vi.restoreAllMocks();
});

describe('listAgents', () => {
  it('lists the ask agent on ADK', () => {
    expect(listAgents()).toMatchObject([{ id: 'ask', framework: 'adk' }]);
  });
});

describe('runAgent (fake)', () => {
  it('returns a v1 observation and a run record without cost', async () => {
    const { observation, run } = await runAgent({
      agentId: 'ask',
      mode: 'fake',
      caseRow: firstRow('dev'),
    });
    expect(observationSchema.safeParse(observation).success).toBe(true);
    expect(run).toMatchObject({ framework: 'adk', mode: 'fake', model: 'fake' });
    expect(run).not.toHaveProperty('cost');
    expect(run.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('rejects an unknown agent and an invalid case row', async () => {
    await expect(runAgent({ agentId: 'nope', mode: 'fake', caseRow: {} })).rejects.toThrow(
      'unknown agent',
    );
    await expect(
      runAgent({ agentId: 'ask', mode: 'fake', caseRow: { id: 'x' } }),
    ).rejects.toThrow();
  });
});

describe('runEval (fake)', () => {
  it('matches the release gate over dev and adversarial and validates every observation', async () => {
    const report = await runEval({
      agentId: 'ask',
      mode: 'fake',
      datasetPath: [dataset('dev'), dataset('adversarial')],
    });
    expect(report).toMatchObject({ caseCount: 102, gate: { passed: true } });
    expect(report.run).toMatchObject({ framework: 'adk', mode: 'fake' });

    const { loadDataset } = await tool<{ loadDataset: () => { cases: unknown[] } }>('dataset.mjs');
    const { loadRuntime } = await tool<{
      loadRuntime: () => Promise<{ runDataset: (rows: unknown[]) => Promise<unknown[]> }>;
    }>('runtime.mjs');
    const { scoreDataset } = await tool<{
      scoreDataset: (cases: unknown[], observations: unknown[]) => { metrics: unknown };
    }>('scorer.mjs');
    const { cases } = loadDataset();
    const observations = await (await loadRuntime()).runDataset(cases);
    for (const observation of observations)
      expect(observationSchema.safeParse(observation).success).toBe(true);
    const expected = scoreDataset(cases, observations);
    expect(report).toMatchObject({ metrics: expected.metrics });
  }, 60_000);

  it('rejects holdout without opt-in and paths outside evals/v1', async () => {
    await expect(
      runEval({ agentId: 'ask', mode: 'fake', datasetPath: dataset('holdout') }),
    ).rejects.toThrow('holdout requires explicit opt-in');
    await expect(
      runEval({ agentId: 'ask', mode: 'fake', datasetPath: 'package.json' }),
    ).rejects.toThrow('dataset must be one of');
  });
});

describe('live mode', () => {
  it('fails with the missing variables and makes no network call', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    await expect(
      runAgent({ agentId: 'ask', mode: 'live', caseRow: firstRow('dev'), env: {} }),
    ).rejects.toThrow(/GOOGLE_CLOUD_PROJECT, GOOGLE_CLOUD_LOCATION, VERTEX_MODEL_ID/);
    await expect(
      runEval({ agentId: 'ask', mode: 'live', datasetPath: dataset('dev'), env: {} }),
    ).rejects.toThrow('Live mode needs');
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
