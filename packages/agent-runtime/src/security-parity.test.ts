import { readFileSync } from 'node:fs';

import { runnerLimitsSchema } from '@agent-works/domain';
import { describe, expect, it } from 'vitest';

import { createAdkRunner } from './adk-runner.js';
import { runEval } from './eval.js';
import { FetchLlm } from './fetch-llm.js';

import type { RunnerLimits } from '@agent-works/domain';

const root = new URL('../../../', import.meta.url);
const tool = async <T>(file: string): Promise<T> =>
  (await import(new URL(`tools/evals/${file}`, root).href)) as T;
const dev = 'evals/v1/dev.jsonl';
const adversarial = 'evals/v1/adversarial.jsonl';
const noHook = (): Promise<void> => Promise.resolve();

type Seed = { caseId: string; patch: Record<string, unknown> };
const seed = (name: string): Seed =>
  JSON.parse(
    // eslint-disable-next-line security/detect-non-literal-fs-filename
    readFileSync(new URL(`evals/results/fixtures/${name}-regression.json`, root), 'utf8'),
  ) as Seed;

function limits(overrides: Partial<RunnerLimits> = {}): RunnerLimits {
  return runnerLimitsSchema.parse({
    maxSteps: 4,
    maxToolCalls: 4,
    maxCostUsd: 1,
    maxElapsedMs: 1000,
    maxBytesRetrieved: 10,
    maxGeneratedOutputs: 1,
    maxModelRetries: 1,
    maxSubagents: 0,
    maxParallelToolCalls: 1,
    ...overrides,
  });
}

const replying =
  (...replies: unknown[]): typeof fetch =>
  () =>
    Promise.resolve(Response.json(replies.shift()));

const source = {
  id: 'note',
  title: 'Note',
  text: 'plain text',
  uri: 'https://drive.fake.test/d/n',
};
const call = (name: string) => ({
  candidates: [{ content: { parts: [{ functionCall: { name, args: {} } }] } }],
});

describe('adversarial split through the native ADK path', () => {
  it('has no leaks and no unauthorized executions', async () => {
    const report = await runEval({ agentId: 'ask', mode: 'fake', datasetPath: [dev, adversarial] });
    expect((report as { security?: unknown }).security).toEqual({
      leaks: 0,
      unauthorizedExecutions: 0,
    });
    expect(report.gate).toMatchObject({ passed: true });
  }, 60_000);

  it.each(['leak', 'unapproved-call'])(
    'a seeded %s regression fails the gate',
    async (name) => {
      const { loadDataset } = await tool<{
        loadDataset: (o: { splits: string[] }) => { cases: { id: string }[] };
      }>('dataset.mjs');
      const { loadRuntime } = await tool<{
        loadRuntime: () => Promise<{
          runDataset: (rows: unknown[]) => Promise<{ caseId: string }[]>;
        }>;
      }>('runtime.mjs');
      const { scoreDataset } = await tool<{
        scoreDataset: (c: unknown[], o: unknown[]) => { security: Record<string, number> };
      }>('scorer.mjs');
      const { evaluateGate } = await tool<{
        evaluateGate: (r: unknown, c: unknown) => { passed: boolean; failures: string[] };
      }>('gate.mjs');
      const { cases } = loadDataset({ splits: ['dev', 'adversarial'] });
      const observations = await (await loadRuntime()).runDataset(cases);
      const { caseId, patch } = seed(name);
      const seeded = observations.map((observation) =>
        observation.caseId === caseId ? { ...observation, ...patch } : observation,
      );
      expect(seeded).not.toEqual(observations);
      const report = scoreDataset(cases, seeded);
      const config: unknown = JSON.parse(
        // eslint-disable-next-line security/detect-non-literal-fs-filename
        readFileSync(new URL('evals/gate-config.json', root), 'utf8'),
      );
      const gate = evaluateGate(report, config);
      expect(gate.passed).toBe(false);
      expect(gate.failures.some((failure) => failure.startsWith('security:'))).toBe(true);
    },
    60_000,
  );
});

describe('runner failures surface as errors, not answers', () => {
  it('rejects when the step budget is exhausted', async () => {
    const runner = createAdkRunner({
      model: new FetchLlm({
        baseUrl: 'https://llm.test',
        fetch: replying(call('search'), call('search'), call('search')),
      }),
      limits: limits({ maxSteps: 2 }),
      beforeModelCall: noHook,
    });
    await expect(runner.run({ question: 'loop', sources: [source] })).rejects.toThrow(
      'TASK_BUDGET_EXCEEDED',
    );
  });

  it('rejects a call to a tool that is not exposed', async () => {
    const runner = createAdkRunner({
      model: new FetchLlm({ baseUrl: 'https://llm.test', fetch: replying(call('send_email')) }),
      limits: limits(),
      beforeModelCall: noHook,
    });
    await expect(runner.run({ question: 'mail it', sources: [source] })).rejects.toThrow(
      'hidden tool',
    );
  });
});
