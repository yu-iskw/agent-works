import { readFileSync } from 'node:fs';
import net from 'node:net';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { runAgent, runEval } from './eval.js';

const root = new URL('../../../', import.meta.url);
const dataset = (split: string) => `evals/v1/${split}.jsonl`;
const firstRow = (split: string): unknown =>
  // eslint-disable-next-line security/detect-non-literal-fs-filename
  JSON.parse(readFileSync(new URL(dataset(split), root), 'utf8').split('\n')[0]);

function forbidIo() {
  const refuse = (what: string) => () => {
    throw new Error(`isolation violated: ${what}`);
  };
  return {
    listen: vi.spyOn(net.Server.prototype, 'listen').mockImplementation(refuse('listen')),
    connect: vi.spyOn(net.Socket.prototype, 'connect').mockImplementation(refuse('connect')),
    fetch: vi.spyOn(globalThis, 'fetch').mockImplementation(refuse('global fetch')),
  };
}

describe('fake mode is server-free', () => {
  let io: ReturnType<typeof forbidIo>;

  beforeEach(() => {
    vi.stubEnv('GOOGLE_GENAI_USE_VERTEXAI', '');
    vi.stubEnv('GOOGLE_CLOUD_LOCATION', '');
    vi.stubEnv('OPENAI_API_KEY', '');
    io = forbidIo();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  const expectNoIo = () => {
    expect(io.listen).not.toHaveBeenCalled();
    expect(io.connect).not.toHaveBeenCalled();
    expect(io.fetch).not.toHaveBeenCalled();
  };

  it('runAgent opens no listener, socket or global fetch', async () => {
    const { observation } = await runAgent({
      agentId: 'ask',
      mode: 'fake',
      caseRow: firstRow('dev'),
    });
    expect(observation).toHaveProperty('caseId');
    expectNoIo();
  });

  it('runEval opens no listener, socket or global fetch', async () => {
    const report = await runEval({
      agentId: 'ask',
      mode: 'fake',
      datasetPath: [dataset('dev'), dataset('adversarial')],
    });
    expect(report).toMatchObject({ gate: { passed: true } });
    expectNoIo();
  }, 60_000);
});
