import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { runAgent, runEvalCommand } from './agent.js';

const runtime = vi.hoisted(() => ({
  listAgents: vi.fn(),
  routeAdkLogsTo: vi.fn(),
  runAgent: vi.fn(),
  runEval: vi.fn(),
}));
vi.mock('@agent-works/agent-runtime', () => runtime);

const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));
const example = 'evals/v1/examples/ask-retrieval.json';
const examplePath = `${repoRoot}${example}`;

type Doc = {
  agents: { id: string }[];
  observation: { caseId: string };
  gate: { passed: boolean };
  run: Record<string, unknown>;
};
const json = (text: string) => JSON.parse(text) as Doc;

function capture() {
  const out: string[] = [];
  const err: string[] = [];
  return {
    streams: {
      stdout: { write: (body: string) => out.push(body) },
      stderr: { write: (body: string) => err.push(body) },
    },
    out: () => out.join(''),
    err: () => err.join(''),
  };
}

beforeEach(() => {
  vi.resetAllMocks();
  runtime.listAgents.mockReturnValue([{ id: 'ask', framework: 'adk', description: 'Ask.' }]);
});

describe('aw agent', () => {
  it('lists agents as JSON or text', async () => {
    const listed = capture();
    expect(await runAgent(['list', '--json'], listed.streams)).toBe(0);
    expect(json(listed.out())).toEqual({
      agents: [{ id: 'ask', framework: 'adk', description: 'Ask.' }],
    });
    const text = capture();
    expect(await runAgent(['list'], text.streams)).toBe(0);
    expect(text.out()).toBe('ask\tadk\tAsk.\n');
  });

  it('runs one case row in fake mode by default', async () => {
    runtime.runAgent.mockResolvedValue({
      observation: { caseId: 'c1' },
      run: { mode: 'fake', model: 'fake', durationMs: 3 },
    });
    const io = capture();
    expect(await runAgent(['run', 'ask', '--input', examplePath, '--json'], io.streams)).toBe(0);
    expect(runtime.runAgent).toHaveBeenCalledWith(
      expect.objectContaining({ agentId: 'ask', mode: 'fake' }),
    );
    expect(json(io.out()).observation.caseId).toBe('c1');
  });

  it('exits 2 when the observation status is error, still printing the observation', async () => {
    runtime.runAgent.mockResolvedValue({
      observation: { caseId: 'c1', status: 'error', diagnostics: ['model not found'] },
      run: { mode: 'live', model: 'm', durationMs: 3 },
    });
    const io = capture();
    expect(
      await runAgent(
        ['run', 'ask', '--mode', 'live', '--input', examplePath, '--json'],
        io.streams,
      ),
    ).toBe(2);
    expect(json(io.out()).observation.caseId).toBe('c1');
    expect(io.err()).toContain('model not found');
  });

  it('exits 0 for non-error statuses such as denied or abstained', async () => {
    runtime.runAgent.mockResolvedValue({
      observation: { caseId: 'c1', status: 'abstained', diagnostics: [] },
      run: { mode: 'fake', model: 'fake', durationMs: 3 },
    });
    expect(
      await runAgent(['run', 'ask', '--input', examplePath, '--json'], capture().streams),
    ).toBe(0);
  });

  it('routes library logs to stderr during a run and restores console afterwards', async () => {
    const before = [console.debug, console.info, console.log];
    runtime.runAgent.mockImplementation(() => {
      console.debug('The user provided project/location will take precedence');
      console.log('plain log');
      return Promise.resolve({
        observation: { caseId: 'c1', status: 'answered' },
        run: { mode: 'fake', model: 'fake', durationMs: 3 },
      });
    });
    const io = capture();
    expect(await runAgent(['run', 'ask', '--input', examplePath, '--json'], io.streams)).toBe(0);
    expect(json(io.out()).observation.caseId).toBe('c1');
    expect(io.err()).toContain('will take precedence');
    expect(io.err()).toContain('plain log');
    expect(runtime.routeAdkLogsTo).toHaveBeenCalledWith(io.streams.stderr);
    expect([console.debug, console.info, console.log]).toEqual(before);
  });

  it.each([
    [['run', 'ask', '--mode', 'turbo', '--input', example]],
    [['run', 'ask']],
    [['run', '--input', example]],
    [['run', 'ask', '--input']],
    [['list', '--bogus']],
    [['nope']],
  ])('exits 2 with usage on stderr for %j', async (args) => {
    const io = capture();
    expect(await runAgent(args, io.streams)).toBe(2);
    expect(io.out()).toBe('');
    expect(io.err()).toContain('usage:');
  });

  it('exits 2 when the runtime rejects, e.g. missing Vertex variables', async () => {
    runtime.runAgent.mockRejectedValue(new Error('missing GOOGLE_CLOUD_PROJECT'));
    const io = capture();
    expect(
      await runAgent(['run', 'ask', '--mode', 'live', '--input', examplePath], io.streams),
    ).toBe(2);
    expect(io.err()).toContain('GOOGLE_CLOUD_PROJECT');
  });

  it('prints help with exit 0 on --help', async () => {
    const io = capture();
    expect(await runAgent(['--help'], io.streams)).toBe(0);
    expect(io.out()).toContain('aw agent run');
  });
});

describe('aw eval', () => {
  const report = (passed: boolean) => ({
    caseCount: 2,
    gate: { passed },
    run: { mode: 'fake', model: 'fake', durationMs: 1 },
  });

  it.each([
    [true, 0],
    [false, 1],
  ])('maps gate passed=%s to exit %i', async (passed, code) => {
    runtime.runEval.mockResolvedValue(report(passed));
    const io = capture();
    const args = ['run', '--agent', 'ask', '--dataset', 'evals/v1/dev.jsonl', '--include-holdout'];
    expect(await runEvalCommand(args, io.streams)).toBe(code);
    expect(runtime.runEval).toHaveBeenCalledWith({
      agentId: 'ask',
      mode: 'fake',
      datasetPath: ['evals/v1/dev.jsonl'],
      includeHoldout: true,
    });
    expect(io.out()).toContain(passed ? 'gate passed' : 'gate FAILED');
  });

  it('emits the report as JSON', async () => {
    runtime.runEval.mockResolvedValue(report(true));
    const io = capture();
    await runEvalCommand(['run', '--agent', 'ask', '--dataset', 'x', '--json'], io.streams);
    expect(json(io.out()).gate.passed).toBe(true);
  });

  it.each([[['run', '--dataset', 'x']], [['list']]])('exits 2 for usage error %j', async (args) => {
    const io = capture();
    expect(await runEvalCommand(args, io.streams)).toBe(2);
    expect(io.err()).toContain('usage:');
  });

  it('collects repeated --dataset values and defaults to the gate splits', async () => {
    runtime.runEval.mockResolvedValue(report(true));
    await runEvalCommand(
      ['run', '--agent', 'ask', '--dataset', 'a', '--dataset', 'b'],
      capture().streams,
    );
    expect(runtime.runEval).toHaveBeenLastCalledWith(
      expect.objectContaining({ datasetPath: ['a', 'b'] }),
    );
    await runEvalCommand(['run', '--agent', 'ask'], capture().streams);
    expect(runtime.runEval).toHaveBeenLastCalledWith(
      expect.objectContaining({
        datasetPath: [
          expect.stringMatching(/evals\/v1\/dev\.jsonl$/),
          expect.stringMatching(/evals\/v1\/adversarial\.jsonl$/),
        ],
      }),
    );
  });

  it('prints gate failures in the text summary', async () => {
    runtime.runEval.mockResolvedValue({
      ...report(false),
      gate: { passed: false, failures: ['unavailable:deniedCallRate'] },
    });
    const io = capture();
    await runEvalCommand(['run', '--agent', 'ask', '--dataset', 'x'], io.streams);
    expect(io.out()).toContain('unavailable:deniedCallRate');
  });

  it('exits 2 for a duplicate --dataset', async () => {
    const io = capture();
    expect(
      await runEvalCommand(
        ['run', '--agent', 'ask', '--dataset', 'x', '--dataset', 'x'],
        io.streams,
      ),
    ).toBe(2);
    expect(io.err()).toContain('duplicate');
  });

  it('exits 2 for harness errors such as holdout without opt-in', async () => {
    runtime.runEval.mockRejectedValue(new Error('holdout requires explicit opt-in'));
    const io = capture();
    expect(
      await runEvalCommand(
        ['run', '--agent', 'ask', '--dataset', 'evals/v1/holdout.jsonl'],
        io.streams,
      ),
    ).toBe(2);
    expect(io.err()).toContain('holdout');
  });
});

const awPath = fileURLToPath(new URL('../dist/aw.js', import.meta.url));
// eslint-disable-next-line security/detect-non-literal-fs-filename
describe.skipIf(!existsSync(awPath))('built dist/aw.js subprocess', () => {
  const aw = awPath;
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      ([key]) => !/^(GOOGLE_|VERTEX_|OPENAI_API_KEY|AW_API_BASE_URL)/.test(key),
    ),
  );
  const aw$ = (...args: string[]) =>
    spawnSync(process.execPath, [aw, ...args], { cwd: repoRoot, env, encoding: 'utf8' });

  it('lists agents as valid JSON', () => {
    const result = aw$('agent', 'list', '--json');
    expect(result.status).toBe(0);
    expect(json(result.stdout).agents[0].id).toBe('ask');
  });

  it('runs the example case offline', () => {
    const result = aw$('agent', 'run', 'ask', '--mode', 'fake', '--input', example, '--json');
    expect(result.status).toBe(0);
    const parsed = json(result.stdout);
    expect(parsed.run).toMatchObject({ framework: 'adk', mode: 'fake' });
    expect(typeof parsed.observation.caseId).toBe('string');
  });

  it('prints only the JSON document on stdout for a fake --json run', () => {
    const result = aw$('agent', 'run', 'ask', '--mode', 'fake', '--input', example, '--json');
    expect(() => void JSON.parse(result.stdout)).not.toThrow();
  });

  it('keeps stdout empty or JSON-only when live mode fails on missing variables', () => {
    const result = aw$('agent', 'run', 'ask', '--mode', 'live', '--input', example, '--json');
    expect(result.status).toBe(2);
    if (result.stdout !== '') expect(() => void JSON.parse(result.stdout)).not.toThrow();
    expect(result.stdout).not.toMatch(/\[ADK\]|take precedence/);
  });

  it('passes the release gate by default in fake mode', () => {
    const result = aw$('eval', 'run', '--agent', 'ask', '--json');
    expect(result.status).toBe(0);
    expect(json(result.stdout).gate.passed).toBe(true);
  });

  it('passes with repeated dev and adversarial datasets', () => {
    const result = aw$(
      'eval',
      'run',
      '--agent',
      'ask',
      '--dataset',
      'evals/v1/dev.jsonl',
      '--dataset',
      'evals/v1/adversarial.jsonl',
      '--json',
    );
    expect(result.status).toBe(0);
  });

  it('fails a single split with unavailable metrics', () => {
    const result = aw$('eval', 'run', '--agent', 'ask', '--dataset', 'evals/v1/dev.jsonl');
    expect(result.status).toBe(1);
    expect(result.stdout + result.stderr).toContain('unavailable');
  });

  it('rejects a duplicate --dataset', () => {
    const result = aw$(
      'eval',
      'run',
      '--agent',
      'ask',
      '--dataset',
      'evals/v1/dev.jsonl',
      '--dataset',
      'evals/v1/dev.jsonl',
    );
    expect(result.status).toBe(2);
  });

  it('refuses holdout without --include-holdout', () => {
    const result = aw$('eval', 'run', '--agent', 'ask', '--dataset', 'evals/v1/holdout.jsonl');
    expect(result.status).toBe(2);
  });

  it('names the missing Vertex variables in live mode', () => {
    const result = aw$('agent', 'run', 'ask', '--mode', 'live', '--input', example);
    expect(result.status).toBe(2);
    for (const name of ['GOOGLE_CLOUD_PROJECT', 'GOOGLE_CLOUD_LOCATION', 'VERTEX_MODEL_ID'])
      expect(result.stderr).toContain(name);
  });
});
