/* eslint-disable import-x/no-unresolved -- the SDK ships wildcard subpath exports the lint resolver cannot follow */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

import type { ToolManifest } from '@agent-works/domain';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';

export type McpToolPin = {
  readonly name: string;
  readonly sideEffect: ToolManifest['spec']['sideEffect'];
};

export type McpErrorCode =
  | 'mcp_manifest_mismatch'
  | 'mcp_unknown_tool'
  | 'mcp_write_disabled'
  | 'mcp_timeout'
  | 'mcp_cancelled'
  | 'mcp_output_too_large'
  | 'mcp_host_not_allowed'
  | 'mcp_redirect'
  | 'mcp_tool_error'
  | 'mcp_invalid_response'
  | 'mcp_unavailable';

const MESSAGES: Record<McpErrorCode, string> = {
  mcp_manifest_mismatch: 'MCP server does not match its pinned tool manifest',
  mcp_unknown_tool: 'MCP tool is not available',
  mcp_write_disabled: 'MCP write tool is not enabled',
  mcp_timeout: 'MCP call timed out',
  mcp_cancelled: 'MCP call was cancelled',
  mcp_output_too_large: 'MCP output exceeds the size limit',
  mcp_host_not_allowed: 'MCP server host is not allowed',
  mcp_redirect: 'MCP server attempted a redirect',
  mcp_tool_error: 'MCP tool reported an error',
  mcp_invalid_response: 'MCP server returned an invalid response',
  mcp_unavailable: 'MCP server is unavailable',
};

/** Carries only a safe code and a fixed message; upstream text never reaches it. */
export class McpAdapterError extends Error {
  constructor(readonly code: McpErrorCode) {
    // eslint-disable-next-line security/detect-object-injection -- `code` is a closed union
    super(MESSAGES[code]);
    this.name = 'McpAdapterError';
  }
}

export type McpSession = {
  /** Only tools that are both pinned and enabled. */
  listTools(): readonly McpToolPin[];
  callTool(
    name: string,
    args: Record<string, unknown>,
    opts?: { readonly signal?: AbortSignal },
  ): Promise<{ readonly texts: readonly string[] }>;
  close(): Promise<void>;
};

export type McpOptions = {
  readonly tools: readonly McpToolPin[];
  /** Authorized tool names; a pinned tool outside this set is never called. */
  readonly enabled: ReadonlySet<string>;
  readonly timeoutMs?: number;
  readonly maxOutputBytes?: number;
};

/**
 * Connects, pins the server's tool set and returns a session that re-checks the pin before every
 * call, so a server that flips a read tool to a write tool after connect is rejected unused.
 */
export async function connectMcp(transport: Transport, options: McpOptions): Promise<McpSession> {
  const pins = new Map(options.tools.map((pin) => [pin.name, pin]));
  const timeoutMs = options.timeoutMs ?? 10_000;
  const maxOutputBytes = options.maxOutputBytes ?? 64 * 1024;
  const client = new Client({ name: 'agent-works', version: '1.0.0' });
  const connectSignal = AbortSignal.timeout(timeoutMs);
  try {
    await client.connect(transport, { signal: connectSignal });
    await verifyPins(client, pins, connectSignal);
  } catch (error) {
    await client.close().catch(() => undefined);
    throw toAdapterError(error, connectSignal);
  }
  return {
    listTools: () => [...pins.values()].filter((pin) => options.enabled.has(pin.name)),
    async callTool(name, args, opts) {
      const pin = pins.get(name);
      if (!pin) throw new McpAdapterError('mcp_unknown_tool');
      if (!options.enabled.has(name))
        throw new McpAdapterError(
          pin.sideEffect === 'READ' ? 'mcp_unknown_tool' : 'mcp_write_disabled',
        );
      const timeout = AbortSignal.timeout(timeoutMs);
      const signal = AbortSignal.any([timeout, ...(opts?.signal ? [opts.signal] : [])]);
      try {
        signal.throwIfAborted();
        await verifyPins(client, pins, signal);
        const result = await client.callTool({ name, arguments: args }, undefined, { signal });
        return { texts: readTexts(result, maxOutputBytes) };
      } catch (error) {
        throw toAdapterError(error, timeout, opts?.signal);
      }
    },
    close: () => client.close().catch(() => undefined),
  };
}

/** Rejects any advertised tool that is unpinned, or a pinned READ tool no longer declared read-only. */
async function verifyPins(
  client: Client,
  pins: ReadonlyMap<string, McpToolPin>,
  signal: AbortSignal,
) {
  let cursor: string | undefined;
  do {
    const page = await client.listTools(cursor ? { cursor } : undefined, { signal });
    for (const tool of page.tools) {
      const pin = pins.get(tool.name);
      if (!pin) throw new McpAdapterError('mcp_manifest_mismatch');
      const { readOnlyHint, destructiveHint } = tool.annotations ?? {};
      if (pin.sideEffect === 'READ' && (readOnlyHint !== true || destructiveHint === true))
        throw new McpAdapterError('mcp_manifest_mismatch');
    }
    cursor = page.nextCursor;
  } while (cursor);
}

function readTexts(result: Record<string, unknown>, maxOutputBytes: number): string[] {
  if (result.isError === true) throw new McpAdapterError('mcp_tool_error');
  const content = result.content;
  if (!Array.isArray(content)) throw new McpAdapterError('mcp_invalid_response');
  const texts = content.map((item: unknown) => {
    if (typeof item !== 'object' || item === null)
      throw new McpAdapterError('mcp_invalid_response');
    const { type, text } = item as { type?: unknown; text?: unknown };
    if (type !== 'text' || typeof text !== 'string')
      throw new McpAdapterError('mcp_invalid_response');
    return text;
  });
  const bytes = texts.reduce((sum, text) => sum + Buffer.byteLength(text), 0);
  if (bytes > maxOutputBytes) throw new McpAdapterError('mcp_output_too_large');
  return texts;
}

/** Maps anything thrown to a safe code; the original message is dropped on purpose. */
function toAdapterError(
  error: unknown,
  timeout: AbortSignal,
  caller?: AbortSignal,
): McpAdapterError {
  for (let cause: unknown = error, depth = 0; cause && depth < 5; depth += 1) {
    if (cause instanceof McpAdapterError) return cause;
    cause = (cause as { cause?: unknown }).cause;
  }
  if (caller?.aborted) return new McpAdapterError('mcp_cancelled');
  if (timeout.aborted) return new McpAdapterError('mcp_timeout');
  return new McpAdapterError('mcp_unavailable');
}

export type McpHttpOptions = {
  readonly allowedHosts: readonly string[];
  readonly fetch?: typeof fetch;
};

/** Streamable HTTP transport that only talks to allowlisted hosts and never follows a redirect. */
export function mcpHttpTransport(url: string, options: McpHttpOptions): Transport {
  const target = parseAllowed(url, options.allowedHosts);
  const upstream = options.fetch ?? fetch;
  const guarded: typeof fetch = async (input, init) => {
    parseAllowed(input instanceof Request ? input.url : String(input), options.allowedHosts);
    const response = await upstream(input, { ...init, redirect: 'manual' });
    if (response.type === 'opaqueredirect' || (response.status >= 300 && response.status < 400))
      throw new McpAdapterError('mcp_redirect');
    return response;
  };
  return new StreamableHTTPClientTransport(target, { fetch: guarded });
}

function parseAllowed(value: string, allowedHosts: readonly string[]): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new McpAdapterError('mcp_host_not_allowed');
  }
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    url.username ||
    url.password ||
    !allowedHosts.includes(url.hostname)
  )
    throw new McpAdapterError('mcp_host_not_allowed');
  return url;
}
