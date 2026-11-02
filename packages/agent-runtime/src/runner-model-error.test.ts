import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

type Observation = {
  status: string;
  workflow: string;
  answer: string;
  diagnostics: string[];
  retrievedSourceIds: string[];
  calls: { tool: string; authorized: boolean; outcome: string }[];
};
type Evals = {
  runCase: (row: unknown, options: { runner: () => unknown }) => Promise<Observation>;
};

const root = new URL('../../../', import.meta.url);
const rows = (split: string): Record<string, unknown>[] =>
  // eslint-disable-next-line security/detect-non-literal-fs-filename
  readFileSync(new URL(`evals/v1/${split}.jsonl`, root), 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);

async function evals(): Promise<Evals> {
  const { loadRuntime } = (await import(new URL('tools/evals/runtime.mjs', root).href)) as {
    loadRuntime: () => Promise<Evals>;
  };
  return loadRuntime();
}

// A non-ADK runner: the model failing is the only thing under test.
const failingRunner = () => ({
  run: () => Promise.reject(new Error('model not found or no access')),
});

describe('a model error during a retrieval case', () => {
  const visible = () => rows('dev').find((row) => row.id === 'dev-escalation-visible')!;

  it('records status error and a diagnostic, but no phantom drive.search', async () => {
    const { runCase } = await evals();
    const observation = await runCase(visible(), { runner: failingRunner });
    expect(observation).toMatchObject({
      status: 'error',
      workflow: 'blocked',
      answer: '',
      diagnostics: ['model not found or no access'],
      retrievedSourceIds: ['dev-escalation-authoritative'],
    });
    expect(observation.calls).toEqual([
      expect.objectContaining({ tool: 'drive.search', authorized: true, outcome: 'executed' }),
    ]);
  });

  it('still records the single drive.search error call when retrieval itself fails', async () => {
    const { runCase } = await evals();
    const row = rows('adversarial').find(
      (r) => r.fault === 'directory-unavailable' && r.scenario === 'retrieval',
    );
    expect(row, 'dataset needs a directory-unavailable retrieval row').toBeDefined();
    const observation = await runCase(row, { runner: failingRunner });
    expect(observation.status).toBe('error');
    expect(observation.calls).toEqual([
      expect.objectContaining({ tool: 'drive.search', authorized: false, outcome: 'error' }),
    ]);
  });
});
