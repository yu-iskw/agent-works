/* eslint-disable import-x/no-unresolved -- the SDK ships wildcard subpath exports the lint resolver cannot follow */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import * as z from 'zod';

import { McpAdapterError, mcpHttpTransport } from '../mcp-adapter.js';

import { boundedFetch } from './bounded-fetch.js';
import {
  TASK_TOOLS,
  cancelSchema,
  lookupSchema,
  resultSchema,
  statusSchema,
  submitInputSchema,
  submitSchema,
} from './contract.js';
import { parseAgentRegistry } from './registry.js';

import type { AgentTaskClient, ApprovedAgent, SubmitOutcome } from './contract.js';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';

function safeError(error: unknown, timeout: AbortSignal, caller?: AbortSignal): McpAdapterError {
  for (let cause: unknown = error, depth = 0; cause && depth < 5; depth += 1) {
    if (cause instanceof McpAdapterError) return cause;
    cause = cause instanceof Error ? cause.cause : undefined;
  }
  if (caller?.aborted) return new McpAdapterError('mcp_cancelled');
  if (timeout.aborted) return new McpAdapterError('mcp_timeout');
  return new McpAdapterError('mcp_unavailable');
}

function verifyTool(tool: Tool, seen: Set<string>) {
  const pin = TASK_TOOLS.find((candidate) => candidate.name === tool.name);
  if (!pin || seen.has(tool.name)) throw new McpAdapterError('mcp_manifest_mismatch');
  if (
    tool.annotations?.readOnlyHint !== pin.readOnly ||
    (pin.readOnly && tool.annotations.destructiveHint === true)
  )
    throw new McpAdapterError('mcp_manifest_mismatch');
  seen.add(tool.name);
}

async function verifyTools(client: Client, signal: AbortSignal) {
  const seen = new Set<string>();
  let cursor: string | undefined;
  const cursors = new Set<string>();
  do {
    const page = await client.listTools(cursor ? { cursor } : undefined, { signal });
    for (const tool of page.tools) verifyTool(tool, seen);
    cursor = page.nextCursor;
    if (cursor && cursors.has(cursor)) throw new McpAdapterError('mcp_manifest_mismatch');
    if (cursor) cursors.add(cursor);
  } while (cursor);
  if (seen.size !== TASK_TOOLS.length) throw new McpAdapterError('mcp_manifest_mismatch');
}

function decode<T>(result: Record<string, unknown>, schema: z.ZodType<T>, maxBytes: number): T {
  if (result.isError === true) throw new McpAdapterError('mcp_tool_error');
  const content = z
    .array(z.strictObject({ type: z.literal('text'), text: z.string() }))
    .length(1)
    .safeParse(result.content);
  if (!content.success) throw new McpAdapterError('mcp_invalid_response');
  const text = content.data[0].text;
  if (Buffer.byteLength(text) > maxBytes) throw new McpAdapterError('mcp_output_too_large');
  try {
    const parsed = schema.safeParse(JSON.parse(text) as unknown);
    if (parsed.success) return parsed.data;
  } catch {
    /* Only fixed error codes cross this boundary. */
  }
  throw new McpAdapterError('mcp_invalid_response');
}

function uncertain(error: unknown): SubmitOutcome {
  const code = error instanceof McpAdapterError ? error.code : 'mcp_unavailable';
  return {
    kind: 'uncertain',
    code:
      code === 'mcp_timeout'
        ? code
        : ['mcp_invalid_response', 'mcp_output_too_large', 'mcp_tool_error'].includes(code)
          ? 'mcp_invalid_response'
          : 'mcp_unavailable',
  };
}

export async function connectAgentTask(
  agent: ApprovedAgent,
  opts?: { fetch?: typeof fetch },
): Promise<AgentTaskClient> {
  const transport = mcpHttpTransport(agent.endpoint, {
    allowedHosts: agent.allowedHosts,
    fetch: boundedFetch(opts?.fetch ?? fetch, agent.maxOutputBytes, agent.callTimeoutMs),
  });
  // Validate again because callers may construct ApprovedAgent without parsing a registry.
  parseAgentRegistry([agent], { allowLoopback: true });
  const client = new Client({ name: 'agent-works-task-client', version: '1.0.0' });
  const connectTimeout = AbortSignal.timeout(agent.callTimeoutMs);
  try {
    await client.connect(transport, { signal: connectTimeout });
    await verifyTools(client, connectTimeout);
  } catch (error) {
    await client.close().catch(() => undefined);
    throw safeError(error, connectTimeout);
  }

  async function call<T>(
    name: string,
    args: Record<string, unknown>,
    schema: z.ZodType<T>,
    caller?: AbortSignal,
  ): Promise<T> {
    const timeout = AbortSignal.timeout(agent.callTimeoutMs);
    const signal = AbortSignal.any([timeout, ...(caller ? [caller] : [])]);
    try {
      signal.throwIfAborted();
      await verifyTools(client, signal);
      const result = await client.callTool({ name, arguments: args }, undefined, { signal });
      return decode(result, schema, agent.maxOutputBytes);
    } catch (error) {
      throw safeError(error, timeout, caller);
    }
  }

  return {
    async submit(input, signal) {
      let bytes: number;
      try {
        bytes = Buffer.byteLength(JSON.stringify(input));
      } catch {
        return { kind: 'rejected', code: 'invalid_input' };
      }
      if (bytes > agent.maxInputBytes) return { kind: 'rejected', code: 'mcp_input_too_large' };
      const parsed = submitInputSchema.safeParse(input);
      if (!parsed.success) return { kind: 'rejected', code: 'invalid_input' };
      if (signal?.aborted) return { kind: 'rejected', code: 'mcp_cancelled' };
      try {
        return await call('task.submit', parsed.data, submitSchema, signal);
      } catch (error) {
        return uncertain(error);
      }
    },
    status: (handle, signal) => call('task.status', { handle }, statusSchema, signal),
    async result(handle, signal) {
      const result = await call('task.result', { handle }, resultSchema, signal);
      return {
        output: result.output,
        cost: agent.supports.reportsCost
          ? (result.cost ?? { basis: 'unknown' })
          : { basis: 'unknown' },
      };
    },
    async cancel(handle, signal) {
      if (!agent.supports.cancel) return { kind: 'unsupported' };
      try {
        return await call('task.cancel', { handle }, cancelSchema, signal);
      } catch {
        return { kind: 'uncertain' };
      }
    },
    async lookup(idempotencyKey, signal) {
      if (!agent.supports.lookupByIdempotencyKey) return { kind: 'unsupported' };
      try {
        return await call('task.lookup', { idempotencyKey }, lookupSchema, signal);
      } catch {
        return { kind: 'uncertain' };
      }
    },
    close: () => client.close().catch(() => undefined),
  };
}
