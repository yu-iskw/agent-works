import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import type * as AgentRuntime from '@agent-works/agent-runtime';

type Out = { write(body: string): unknown };
type Streams = { readonly stdout: Out; readonly stderr: Out };
type Mode = 'fake' | 'live';

const agentHelp = `usage:
  aw agent list [--json]
  aw agent run <agent> [--mode fake|live] --input <case.json> [--json]

Runs agents in-process; no server and no AW_API_BASE_URL.
  --input  one eval v1 case row (see evals/v1/examples/ask-retrieval.json)
  --mode   fake (default, offline) or live (Vertex via GOOGLE_CLOUD_PROJECT,
           GOOGLE_CLOUD_LOCATION, VERTEX_MODEL_ID and ADC)
  --json   print JSON on stdout instead of a text summary
exit: 0 ok, 2 usage/config/harness error
`;

const evalHelp = `usage:
  aw eval run --agent <agent> [--mode fake|live] [--dataset <evals/v1/split.jsonl>]... [--include-holdout] [--json]

Scores an agent on eval v1 splits and applies the offline gate.
  --dataset          repeatable: evals/v1/dev.jsonl, adversarial.jsonl or holdout.jsonl;
                     defaults to the release-gate splits in evals/gate-config.json.
                     A single split cannot pass the gate because metrics it
                     does not cover are unavailable (exit 1).
  --include-holdout  required to run holdout.jsonl
  --mode             fake (default, offline) or live (needs the Vertex variables)
  --json             print JSON on stdout instead of a text summary
exit: 0 gate passed, 1 gate failed, 2 usage/config/harness error
`;

const repoRoot = new URL('../../../', import.meta.url);

function defaultDatasets(): string[] {
  // eslint-disable-next-line security/detect-non-literal-fs-filename
  const text = readFileSync(new URL('evals/gate-config.json', repoRoot), 'utf8');
  const { defaultSplits } = JSON.parse(text) as { defaultSplits: string[] };
  return defaultSplits.map((split) => fileURLToPath(new URL(`evals/v1/${split}.jsonl`, repoRoot)));
}

class UsageError extends Error {}

type Parsed = {
  readonly positionals: string[];
  readonly flags: Map<string, string | true>;
  readonly repeated: Map<string, string[]>;
};

function valueOf(tokens: Iterator<string, undefined>, option: string): string {
  const { value }: IteratorResult<string, undefined> = tokens.next();
  if (value === undefined || value.startsWith('--'))
    throw new UsageError(`option ${option} needs a value`);
  return value;
}

function parse(
  args: readonly string[],
  valued: readonly string[],
  bare: readonly string[],
  repeatable: readonly string[] = [],
): Parsed {
  const positionals: string[] = [];
  const flags = new Map<string, string | true>();
  const repeated = new Map<string, string[]>();
  const tokens = args[Symbol.iterator]();
  for (const arg of tokens) {
    if (!arg.startsWith('--')) positionals.push(arg);
    else if (flags.has(arg)) throw new UsageError(`duplicate option ${arg}`);
    else if (bare.includes(arg)) flags.set(arg, true);
    else if (valued.includes(arg) || repeatable.includes(arg)) {
      const value = valueOf(tokens, arg);
      const seen = repeated.get(arg) ?? [];
      if (!repeatable.includes(arg)) flags.set(arg, value);
      else if (seen.includes(value)) throw new UsageError(`duplicate value ${value} for ${arg}`);
      else repeated.set(arg, [...seen, value]);
    } else throw new UsageError(`unknown option ${arg}`);
  }
  return { positionals, flags, repeated };
}

function modeOf(parsed: Parsed): Mode {
  const mode = parsed.flags.get('--mode') ?? 'fake';
  if (mode !== 'fake' && mode !== 'live') throw new UsageError('--mode must be fake or live');
  return mode;
}

function required(parsed: Parsed, name: string): string {
  const value = parsed.flags.get(name);
  if (typeof value !== 'string') throw new UsageError(`missing ${name}`);
  return value;
}

function finish(streams: Streams, error: unknown, help: string): number {
  const message = error instanceof Error ? error.message : String(error);
  streams.stderr.write(`aw: ${message}\n`);
  if (error instanceof UsageError) streams.stderr.write(`\n${help}`);
  return 2;
}

const wantsHelp = (args: readonly string[]) =>
  args.length === 0 || args[0] === '--help' || args[0] === '-h' || args[0] === 'help';

type Runtime = typeof AgentRuntime;

function listCommand(runtime: Runtime, rest: readonly string[], stdout: Out): number {
  const parsed = parse(rest, [], ['--json']);
  if (parsed.positionals.length > 0) throw new UsageError('list takes no arguments');
  const agents = runtime.listAgents();
  stdout.write(
    parsed.flags.has('--json')
      ? `${JSON.stringify({ agents }, null, 2)}\n`
      : agents.map((a) => `${a.id}\t${a.framework}\t${a.description}\n`).join(''),
  );
  return 0;
}

async function runCommand(runtime: Runtime, rest: readonly string[], stdout: Out): Promise<number> {
  const parsed = parse(rest, ['--mode', '--input'], ['--json']);
  if (parsed.positionals.length !== 1) throw new UsageError('run needs exactly one agent id');
  const mode = modeOf(parsed);
  // eslint-disable-next-line security/detect-non-literal-fs-filename
  const caseRow: unknown = JSON.parse(readFileSync(required(parsed, '--input'), 'utf8'));
  const result = await runtime.runAgent({ agentId: parsed.positionals[0], mode, caseRow });
  stdout.write(
    parsed.flags.has('--json')
      ? `${JSON.stringify(result, null, 2)}\n`
      : `case ${result.observation.caseId}: ${result.run.mode} run on ${result.run.model} in ${result.run.durationMs}ms\n`,
  );
  return 0;
}

export async function runAgent(args: readonly string[], streams: Streams): Promise<number> {
  if (wantsHelp(args)) {
    streams.stdout.write(agentHelp);
    return args.length === 0 ? 2 : 0;
  }
  try {
    const [action, ...rest] = args;
    const runtime = await import('@agent-works/agent-runtime');
    if (action === 'list') return listCommand(runtime, rest, streams.stdout);
    if (action === 'run') return await runCommand(runtime, rest, streams.stdout);
    throw new UsageError(`unknown agent command ${action}`);
  } catch (error) {
    return finish(streams, error, agentHelp);
  }
}

export async function runEvalCommand(args: readonly string[], streams: Streams): Promise<number> {
  if (wantsHelp(args)) {
    streams.stdout.write(evalHelp);
    return args.length === 0 ? 2 : 0;
  }
  try {
    const [action, ...rest] = args;
    if (action !== 'run') throw new UsageError(`unknown eval command ${action}`);
    const parsed = parse(
      rest,
      ['--agent', '--mode'],
      ['--include-holdout', '--json'],
      ['--dataset'],
    );
    if (parsed.positionals.length > 0) throw new UsageError('run takes no positional arguments');
    const runtime = await import('@agent-works/agent-runtime');
    const report = await runtime.runEval({
      agentId: required(parsed, '--agent'),
      mode: modeOf(parsed),
      datasetPath: parsed.repeated.get('--dataset') ?? defaultDatasets(),
      includeHoldout: parsed.flags.has('--include-holdout'),
    });
    const gate = report.gate as { passed?: boolean; failures?: string[] };
    const passed = gate.passed === true;
    const failures = gate.failures?.length ? ` [${gate.failures.join(', ')}]` : '';
    streams.stdout.write(
      parsed.flags.has('--json')
        ? `${JSON.stringify(report, null, 2)}\n`
        : `gate ${passed ? 'passed' : 'FAILED'}${failures}: ${report.run.mode} run on ${report.run.model}, ${String((report as { caseCount?: number }).caseCount)} cases, ${report.run.durationMs}ms\n`,
    );
    return passed ? 0 : 1;
  } catch (error) {
    return finish(streams, error, evalHelp);
  }
}
