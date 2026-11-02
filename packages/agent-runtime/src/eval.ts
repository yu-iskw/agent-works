import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { agents } from './agents.js';
import { createLiveModel, requireVertexConfig } from './live-model.js';

import type { AgentInfo } from './agents.js';
import type { AgentRunner } from './runner-port.js';
import type { BaseLlm } from '@google/adk';

export type EvalMode = 'fake' | 'live';
export type RunRecord = {
  readonly framework: 'adk';
  readonly model: string;
  readonly mode: EvalMode;
  readonly durationMs: number;
  readonly usage: null | { readonly promptTokens: number; readonly outputTokens: number };
};
export type Observation = { readonly caseId: string } & Record<string, unknown>;
export type RunAgentInput = {
  readonly agentId: string;
  readonly mode: EvalMode;
  readonly caseRow: unknown;
  readonly env?: Readonly<Record<string, string | undefined>>;
};
export type RunEvalInput = {
  readonly agentId: string;
  readonly mode: EvalMode;
  readonly datasetPath: string | readonly string[];
  readonly includeHoldout?: boolean;
  readonly env?: Readonly<Record<string, string | undefined>>;
};

type RunnerFactory = (modelFetch: typeof fetch) => Promise<AgentRunner>;
type Tokens = { readonly promptTokens: number; readonly outputTokens: number };
type EvalRunner = {
  runCase: (row: unknown, options: { runner: RunnerFactory }) => Promise<Observation>;
  runDataset: (
    rows: readonly unknown[],
    options: { runner: RunnerFactory },
  ) => Promise<Observation[]>;
  nativeRunner: (model: BaseLlm) => Promise<AgentRunner>;
  fakeRunner: RunnerFactory;
};

const root = new URL('../../../', import.meta.url);
const splits = ['dev', 'adversarial', 'holdout'] as const;
type Split = (typeof splits)[number];

// tools/evals is plain .mjs outside this package's rootDir, so it is loaded by URL at call time.
async function tool<T>(file: string): Promise<T> {
  return (await import(new URL(`tools/evals/${file}`, root).href)) as T;
}

async function loadEvalRunner(): Promise<EvalRunner> {
  const { loadRuntime } = await tool<{ loadRuntime: () => Promise<EvalRunner> }>('runtime.mjs');
  return loadRuntime();
}

export function listAgents(): readonly AgentInfo[] {
  return agents;
}

function requireAgent(agentId: string): void {
  if (!agents.some((agent) => agent.id === agentId)) throw new Error(`unknown agent: ${agentId}`);
}

type Mode = {
  readonly model: string;
  readonly factory: (evalRunner: EvalRunner) => RunnerFactory | undefined;
};

function resolveMode(mode: EvalMode, env: RunAgentInput['env']): Mode {
  if (mode === 'fake') return { model: 'fake', factory: () => undefined };
  const config = requireVertexConfig(env ?? process.env);
  return {
    model: config.modelId,
    factory: (evalRunner) => () => evalRunner.nativeRunner(createLiveModel(config)),
  };
}

/** Wraps a runner factory so each run's token usage is collected; undefined means "not reported". */
function metered(inner: RunnerFactory, sink: (Tokens | undefined)[]): RunnerFactory {
  return async (modelFetch) => {
    const runner = await inner(modelFetch);
    return {
      async run(input) {
        const output = await runner.run(input);
        sink.push(output.usage);
        return output;
      },
    };
  };
}

function sumUsage(samples: readonly (Tokens | undefined)[]): RunRecord['usage'] {
  if (samples.length === 0) return null;
  let promptTokens = 0;
  let outputTokens = 0;
  for (const sample of samples) {
    if (sample === undefined) return null;
    promptTokens += sample.promptTokens;
    outputTokens += sample.outputTokens;
  }
  return { promptTokens, outputTokens };
}

async function prepare(input: { agentId: string; mode: EvalMode; env?: RunAgentInput['env'] }) {
  requireAgent(input.agentId);
  const mode = resolveMode(input.mode, input.env);
  const evalRunner = await loadEvalRunner();
  const samples: (Tokens | undefined)[] = [];
  const base: RunnerFactory = mode.factory(evalRunner) ?? evalRunner.fakeRunner;
  const startedAt = performance.now();
  const record = (): RunRecord => ({
    framework: 'adk',
    model: mode.model,
    mode: input.mode,
    durationMs: Math.round(performance.now() - startedAt),
    usage: sumUsage(samples),
  });
  return { evalRunner, runner: metered(base, samples), record };
}

export async function runAgent(
  input: RunAgentInput,
): Promise<{ observation: Observation; run: RunRecord }> {
  const { evalRunner, runner, record } = await prepare(input);
  const observation = await evalRunner.runCase(input.caseRow, { runner });
  return { observation, run: record() };
}

function splitOf(datasetPath: string): Split {
  const resolved = resolve(datasetPath);
  const match = splits.find(
    (split) => resolved === resolve(fileURLToPath(root), 'evals', 'v1', `${split}.jsonl`),
  );
  if (match === undefined)
    throw new Error(
      `dataset must be one of evals/v1/{${splits.join(',')}}.jsonl (got ${datasetPath})`,
    );
  return match;
}

export async function runEval(input: RunEvalInput) {
  const paths = typeof input.datasetPath === 'string' ? [input.datasetPath] : input.datasetPath;
  const selected = [...new Set(paths.map(splitOf))];
  const includeHoldout = input.includeHoldout === true;
  const { loadDataset } = await tool<{
    loadDataset: (options: { splits: Split[]; includeHoldout: boolean }) => {
      cases: unknown[];
      splits: string[];
      fingerprints: Record<string, string>;
    };
  }>('dataset.mjs');
  const dataset = loadDataset({ splits: selected, includeHoldout });
  const { evalRunner, runner, record } = await prepare(input);
  const observations = await evalRunner.runDataset(dataset.cases, { runner });
  const { scoreDataset } = await tool<{
    scoreDataset: (cases: unknown[], observations: Observation[]) => Record<string, unknown>;
  }>('scorer.mjs');
  const { evaluateGate } = await tool<{
    evaluateGate: (report: unknown, config: unknown) => unknown;
  }>('gate.mjs');
  // eslint-disable-next-line security/detect-non-literal-fs-filename
  const config: unknown = JSON.parse(readFileSync(new URL('evals/gate-config.json', root), 'utf8'));
  const report = scoreDataset(dataset.cases, observations);
  return {
    ...report,
    dataset: { version: '1.0.0', splits: dataset.splits, fingerprints: dataset.fingerprints },
    gate: evaluateGate(report, config),
    run: record(),
  };
}
