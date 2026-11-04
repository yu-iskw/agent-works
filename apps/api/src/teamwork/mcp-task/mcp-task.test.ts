import { afterEach, describe, expect, it, vi } from 'vitest';
import * as z from 'zod';

import { McpAdapterError } from '../mcp-adapter.js';

import { startReferenceAgent } from './reference-agent-server.js';

import { AGENT_TASK_CONTRACT, connectAgentTask, parseAgentRegistry } from './index.js';

import type {
  AgentRegistry,
  AgentTaskClient,
  ApprovedAgent,
  CancelOutcome,
  LookupOutcome,
  SubmitOutcome,
  TaskResult,
  TaskStatus,
} from './index.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.reverse()) await cleanup();
  cleanups.length = 0;
});

function config(endpoint = 'https://agent.internal/mcp'): ApprovedAgent {
  return {
    agentId: 'reference',
    displayName: 'Local reference agent',
    protocol: 'mcp',
    contract: AGENT_TASK_CONTRACT,
    endpoint,
    allowedHosts: [new URL(endpoint).host],
    supports: { cancel: true, lookupByIdempotencyKey: true, reportsCost: true },
    maxInputBytes: 4096,
    maxOutputBytes: 4096,
    callTimeoutMs: 1000,
    dataClassification: 'Test data sent externally',
  };
}
const taskInput = (instruction = 'echo', idempotencyKey = 'bot:run:step:1') => ({
  idempotencyKey,
  instruction,
  input: { question: 'hello' },
});
function handleOf(outcome: SubmitOutcome): string {
  expect(outcome.kind).toBe('accepted');
  if (outcome.kind !== 'accepted') throw new Error('Expected accepted task');
  return outcome.handle;
}
async function fixture(options: Parameters<typeof startReferenceAgent>[0] = {}) {
  let time = 0;
  const server = await startReferenceAgent({ now: () => time, ...options });
  cleanups.push(() => server.close());
  const agent = config(server.endpoint);
  async function connect(
    overrides: Partial<ApprovedAgent> = {},
    fetchOverride?: typeof fetch,
  ): Promise<AgentTaskClient> {
    const client = await connectAgentTask(
      { ...agent, ...overrides },
      { fetch: fetchOverride, allowLoopback: true },
    );
    cleanups.push(() => client.close());
    return client;
  }
  return {
    server,
    agent,
    connect,
    advance: (ms: number) => {
      time += ms;
    },
  };
}

describe('approved agent registry', () => {
  it('accepts immutable HTTPS entries and development loopback entries', () => {
    const registry: AgentRegistry = parseAgentRegistry([config()], { allowLoopback: false });
    expect(registry.list()).toEqual([config()]);
    expect(registry.get('absent')).toBeUndefined();
    expect(Object.isFrozen(registry.get('reference'))).toBe(true);
    expect(Object.isFrozen(registry.get('reference')?.supports)).toBe(true);
    expect(
      parseAgentRegistry([config('http://127.0.0.1:4567/mcp')], { allowLoopback: true }).list(),
    ).toHaveLength(1);
    expect(
      parseAgentRegistry([config('http://localhost:4567/mcp')], { allowLoopback: true }).list(),
    ).toHaveLength(1);
  });

  it.each([
    [{ protocol: 'a2a' }, 'protocol'],
    [{ contract: undefined }, 'contract'],
    [{ contract: 'other' }, 'contract'],
    [{ extra: 'secret-value' }, 'extra'],
    [{ endpoint: 'http://agent.internal/mcp' }, 'endpoint'],
    [{ endpoint: 'http://127.0.0.1/mcp' }, 'endpoint'],
    [{ endpoint: 'https://user:secret@agent.internal/mcp' }, 'endpoint'],
    [{ allowedHosts: ['elsewhere.internal'] }, 'allowedHosts'],
    [{ maxInputBytes: 0 }, 'maxInputBytes'],
    [{ maxOutputBytes: -1 }, 'maxOutputBytes'],
    [{ callTimeoutMs: Infinity }, 'callTimeoutMs'],
    [
      {
        supports: {
          cancel: true,
          lookupByIdempotencyKey: true,
          reportsCost: true,
          secret: 'secret-value',
        },
      },
      'supports.secret',
    ],
  ])('rejects invalid fields without including values (%s)', (override, field) => {
    expect(() =>
      parseAgentRegistry([{ ...config(), ...override }], { allowLoopback: false }),
    ).toThrow(field);
    expect(() =>
      parseAgentRegistry([{ ...config(), ...override }], { allowLoopback: false }),
    ).not.toThrow('secret-value');
  });
  it('rejects duplicate IDs and non-loopback HTTP even in development', () => {
    expect(() => parseAgentRegistry([config(), config()], { allowLoopback: true })).toThrow(
      'agentId',
    );
    expect(() =>
      parseAgentRegistry([config('http://elsewhere.internal/mcp')], { allowLoopback: true }),
    ).toThrow('endpoint');
  });
});

describe('real Streamable HTTP lifecycle', () => {
  it('returns a handle before completion, advances status, and validates result and reported cost', async () => {
    const f = await fixture();
    const client = await f.connect();
    const handle = handleOf(await client.submit(taskInput()));
    const queued: TaskStatus = await client.status(handle);
    expect(queued).toEqual({ state: 'queued' });
    await expect(client.result(handle)).rejects.toMatchObject({ code: 'mcp_tool_error' });
    f.advance(100);
    await expect(client.status(handle)).resolves.toEqual({ state: 'running' });
    f.advance(900);
    await expect(client.status(handle)).resolves.toEqual({ state: 'succeeded' });
    const result: TaskResult = await client.result(handle);
    expect(result).toEqual({
      output: { reference: true, input: { question: 'hello' } },
      cost: { basis: 'reported', amountMicros: 1234, currency: 'USD' },
    });
    expect(f.server.calls).toContain('task.submit');
  });

  it('deduplicates concurrent delivery and finds the original handle', async () => {
    const f = await fixture();
    const client = await f.connect();
    const outcomes = await Promise.all([client.submit(taskInput()), client.submit(taskInput())]);
    const handles = outcomes.map(handleOf);
    expect(new Set(handles).size).toBe(1);
    expect(outcomes).toContainEqual({ kind: 'accepted', handle: handles[0], duplicate: true });
    const lookup: LookupOutcome = await client.lookup(taskInput().idempotencyKey);
    expect(lookup).toEqual({ kind: 'found', handle: handles[0] });
    await expect(client.submit({ ...taskInput(), instruction: 'changed' })).resolves.toEqual({
      kind: 'rejected',
      code: 'idempotency_conflict',
    });
  });

  it('recovers a created task after a dropped submit response and a new client session', async () => {
    const f = await fixture();
    const first = await f.connect();
    await expect(first.submit(taskInput('[reference:drop-submit]'))).resolves.toEqual({
      kind: 'uncertain',
      code: 'mcp_unavailable',
    });
    await first.close();
    const restarted = await f.connect();
    const lookup = await restarted.lookup(taskInput().idempotencyKey);
    expect(lookup.kind).toBe('found');
    if (lookup.kind !== 'found') throw new Error('Expected recovered handle');
    await expect(restarted.status(lookup.handle)).resolves.toEqual({ state: 'queued' });
    f.advance(1000);
    await expect(restarted.status(lookup.handle)).resolves.toEqual({ state: 'succeeded' });
    await expect(restarted.result(lookup.handle)).resolves.toMatchObject({
      output: { reference: true },
    });
    expect(f.server.calls.filter((name) => name === 'task.submit')).toHaveLength(1);
  });

  it.each(['unknown-cost', 'normal'])(
    'maps missing or disabled cost reporting to unknown (%s)',
    async (mode) => {
      const f = await fixture();
      const client = await f.connect({
        supports: { ...f.agent.supports, reportsCost: mode !== 'normal' },
      });
      const handle = handleOf(await client.submit(taskInput(`[reference:${mode}]`)));
      f.advance(1000);
      await expect(client.result(handle)).resolves.toMatchObject({ cost: { basis: 'unknown' } });
    },
  );

  it('cancels a running task and never accepts a late completion', async () => {
    const f = await fixture();
    const client = await f.connect();
    const handle = handleOf(await client.submit(taskInput()));
    f.advance(100);
    const cancelled: CancelOutcome = await client.cancel(handle);
    expect(cancelled).toEqual({ kind: 'cancelled' });
    f.advance(1_000_000);
    await expect(client.status(handle)).resolves.toEqual({ state: 'cancelled' });
    await expect(client.result(handle)).rejects.toMatchObject({ code: 'mcp_tool_error' });
    await expect(client.cancel(handle)).resolves.toEqual({ kind: 'already_terminal' });
  });

  it('reports terminal cancellation and unknown handles', async () => {
    const f = await fixture();
    const client = await f.connect();
    const handle = handleOf(await client.submit(taskInput()));
    f.advance(1000);
    await expect(client.cancel(handle)).resolves.toEqual({ kind: 'already_terminal' });
    await expect(client.status('missing')).resolves.toEqual({ state: 'not_found' });
    await expect(client.lookup('missing')).resolves.toEqual({ kind: 'not_found' });
  });

  it('short-circuits unsupported cancel and lookup without a remote call', async () => {
    const f = await fixture();
    const client = await f.connect({
      supports: { cancel: false, lookupByIdempotencyKey: false, reportsCost: false },
    });
    await expect(client.cancel('any')).resolves.toEqual({ kind: 'unsupported' });
    await expect(client.lookup('any')).resolves.toEqual({ kind: 'unsupported' });
    expect(f.server.calls).toEqual([]);
  });
});

describe('transport faults and bounds', () => {
  it('rejects a directly constructed HTTP loopback agent by default before fetching', async () => {
    const fake = vi.fn<typeof fetch>();
    await expect(
      connectAgentTask(config('http://127.0.0.1:4567/mcp'), { fetch: fake }),
    ).rejects.toThrow('endpoint');
    expect(fake).not.toHaveBeenCalled();
  });

  it('rejects manifest changes before sending another tool call', async () => {
    const f = await fixture();
    let changed = false;
    const intercepted: typeof fetch = async (input, init) => {
      const response = await fetch(input, init);
      if (!changed || typeof init?.body !== 'string' || !init.body.includes('tools/list'))
        return response;
      const envelope = z
        .object({ id: z.union([z.string(), z.number()]) })
        .parse(await response.json());
      return Response.json({ jsonrpc: '2.0', id: envelope.id, result: { tools: [] } });
    };
    const client = await f.connect({}, intercepted);
    changed = true;
    await expect(client.status('any')).rejects.toMatchObject({ code: 'mcp_manifest_mismatch' });
    expect(f.server.calls).toEqual([]);
  });

  it.each([
    { state: 'failed', code: 'reference-upstream-secret' },
    { state: 'imaginary' },
    { output: 'ok', cost: { basis: 'reported', amountMicros: -1, currency: 'USD' } },
    { output: 'ok', cost: { basis: 'reported', amountMicros: 1.5, currency: 'USD' } },
    { output: 'ok', cost: { basis: 'reported', amountMicros: 1, currency: 'secret' } },
    { cost: { basis: 'unknown' } },
  ])(
    'rejects invalid status or result shape without exposing response text (%s)',
    async (payload) => {
      const f = await fixture();
      const intercepted: typeof fetch = async (input, init) => {
        const response = await fetch(input, init);
        if (typeof init?.body !== 'string' || !init.body.includes('tools/call')) return response;
        const envelope = z
          .object({ id: z.union([z.string(), z.number()]) })
          .parse(await response.json());
        return Response.json({
          jsonrpc: '2.0',
          id: envelope.id,
          result: { content: [{ type: 'text', text: JSON.stringify(payload) }] },
        });
      };
      const client = await f.connect({}, intercepted);
      const pending = 'state' in payload ? client.status('any') : client.result('any');
      const error: unknown = await pending.catch((thrown: unknown) => thrown);
      expect(error).toMatchObject({ code: 'mcp_invalid_response' });
      expect(String(error)).not.toContain('secret');
    },
  );

  it('preserves uncertainty on unavailable cancel and lookup and sanitizes status errors', async () => {
    const f = await fixture();
    let unavailable = false;
    const intercepted: typeof fetch = (input, init) => {
      if (unavailable) throw new Error('reference-upstream-secret');
      return fetch(input, init);
    };
    const client = await f.connect({}, intercepted);
    unavailable = true;
    await expect(client.cancel('any')).resolves.toEqual({ kind: 'uncertain' });
    await expect(client.lookup('any')).resolves.toEqual({ kind: 'uncertain' });
    await expect(client.status('any')).rejects.toMatchObject({ code: 'mcp_unavailable' });
  });

  it.each([{ omitTool: 'task.cancel' }, { extraTool: true }])(
    'refuses mismatched tool sets after handshake (%s)',
    async (options) => {
      const f = await fixture(options);
      await expect(f.connect()).rejects.toMatchObject({ code: 'mcp_manifest_mismatch' });
      expect(f.server.calls).toEqual([]);
    },
  );

  it('rejects oversized input, invalid input, and pre-aborted submit without network calls', async () => {
    const f = await fixture();
    const traced = vi.fn<typeof fetch>(fetch);
    const client = await f.connect({}, traced);
    traced.mockClear();
    await expect(client.submit({ ...taskInput(), input: 'x'.repeat(5000) })).resolves.toEqual({
      kind: 'rejected',
      code: 'mcp_input_too_large',
    });
    await expect(client.submit({ ...taskInput(), input: undefined })).resolves.toEqual({
      kind: 'rejected',
      code: 'invalid_input',
    });
    await expect(client.submit(taskInput(), AbortSignal.abort())).resolves.toEqual({
      kind: 'rejected',
      code: 'mcp_cancelled',
    });
    expect(traced).not.toHaveBeenCalled();
    expect(f.server.calls).toEqual([]);
  });

  it('keeps slow submit uncertain and recovers its handle without resubmitting', async () => {
    const f = await fixture({ slowSubmitMs: 400 });
    const client = await f.connect({ callTimeoutMs: 150 });
    await expect(client.submit(taskInput('[reference:slow-submit]'))).resolves.toEqual({
      kind: 'uncertain',
      code: 'mcp_timeout',
    });
    await expect(client.lookup(taskInput().idempotencyKey)).resolves.toMatchObject({
      kind: 'found',
    });
  });

  it('keeps caller cancellation after submit uncertain', async () => {
    const f = await fixture({ slowSubmitMs: 400 });
    const client = await f.connect();
    const controller = new AbortController();
    const pending = client.submit(taskInput('[reference:slow-submit]'), controller.signal);
    await vi.waitFor(() => {
      expect(f.server.calls).toContain('task.submit');
    });
    controller.abort();
    await expect(pending).resolves.toEqual({ kind: 'uncertain', code: 'mcp_unavailable' });
    await expect(client.lookup(taskInput().idempotencyKey)).resolves.toMatchObject({
      kind: 'found',
    });
  });

  it.each(['tool-error', 'invalid-json'])(
    'sanitizes a faulty submit response (%s)',
    async (mode) => {
      const f = await fixture();
      const client = await f.connect();
      await expect(client.submit(taskInput(`[reference:${mode}]`))).resolves.toEqual({
        kind: 'uncertain',
        code: 'mcp_invalid_response',
      });
    },
  );

  it('reports asynchronous task failure without upstream error text', async () => {
    const f = await fixture();
    const client = await f.connect();
    const handle = handleOf(await client.submit(taskInput('[reference:fail]')));
    f.advance(1000);
    await expect(client.status(handle)).resolves.toEqual({ state: 'failed', code: 'task_failed' });
    const error: unknown = await client.result(handle).catch((thrown: unknown) => thrown);
    expect(error).toBeInstanceOf(McpAdapterError);
    expect(String(error)).not.toContain('secret');
    expect(error).not.toHaveProperty('cause');
  });

  it('rejects oversized output and leaves never-completing tasks running until cancel', async () => {
    const f = await fixture();
    const client = await f.connect();
    const oversized = handleOf(
      await client.submit(taskInput('[reference:oversized-output]', 'large')),
    );
    const never = handleOf(await client.submit(taskInput('[reference:never]', 'never')));
    f.advance(100_000);
    await expect(client.result(oversized)).rejects.toMatchObject({ code: 'mcp_output_too_large' });
    await expect(client.status(never)).resolves.toEqual({ state: 'running' });
    await expect(client.cancel(never)).resolves.toEqual({ kind: 'cancelled' });
  });

  it('refuses disallowed hosts before fetch and never follows redirects', async () => {
    const fake = vi.fn<typeof fetch>(() =>
      Promise.resolve(
        new Response(null, { status: 302, headers: { location: 'https://elsewhere.internal' } }),
      ),
    );
    await expect(
      connectAgentTask({ ...config(), allowedHosts: ['elsewhere.internal'] }, { fetch: fake }),
    ).rejects.toThrow('allowedHosts');
    expect(fake).not.toHaveBeenCalled();
    await expect(connectAgentTask(config(), { fetch: fake })).rejects.toMatchObject({
      code: 'mcp_redirect',
    });
    expect(fake).toHaveBeenCalledTimes(1);
    expect(fake.mock.calls[0]?.[1]?.redirect).toBe('manual');
  });
});
