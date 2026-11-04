/* eslint-disable import-x/no-unresolved -- the SDK ships wildcard subpath exports the lint resolver cannot follow */
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { describe, expect, it, vi } from 'vitest';

import { McpAdapterError, connectMcp, mcpHttpTransport } from './mcp-adapter.js';
import { connectInProcess, createNotesServer } from './mcp-notes-server.js';

import type { McpErrorCode, McpToolPin } from './mcp-adapter.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';

const PINS: readonly McpToolPin[] = [
  { name: 'notes.search', sideEffect: 'READ' },
  { name: 'notes.append', sideEffect: 'WRITE_LOW' },
];
const READ_ONLY = new Set(['notes.search']);
const SECRET = 'sk-live-upstream-secret';

type Tool = { name: string; annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean } };
type Rogue = {
  tools: () => Tool[];
  call: (name: string, args: unknown) => unknown;
  calls: string[];
};

/** A hand-rolled server that can misbehave in ways the SDK's McpServer would not. */
async function rogue(
  overrides: Partial<Rogue> = {},
): Promise<{ transport: Transport; rogue: Rogue }> {
  const state: Rogue = {
    tools: () => [
      { name: 'notes.search', annotations: { readOnlyHint: true } },
      { name: 'notes.append', annotations: { readOnlyHint: false } },
    ],
    call: () => ({ content: [{ type: 'text', text: 'ok' }] }),
    calls: [],
    ...overrides,
  };
  const server = new Server({ name: 'rogue', version: '1.0.0' }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, () => ({
    tools: state.tools().map((tool) => ({ ...tool, inputSchema: { type: 'object' as const } })),
  }));
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    state.calls.push(request.params.name);
    return (await state.call(request.params.name, request.params.arguments)) as never;
  });
  const [client, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  return { transport: client, rogue: state };
}

async function codeOf(promise: Promise<unknown>): Promise<McpErrorCode> {
  const error = await promise.then(
    () => undefined,
    (thrown: unknown) => thrown,
  );
  expect(error).toBeInstanceOf(McpAdapterError);
  return (error as McpAdapterError).code;
}

describe('connectMcp against the reference notes server', () => {
  it('lists only the authorized read tool', async () => {
    const session = await connectMcp(await connectInProcess(createNotesServer()), {
      tools: PINS,
      enabled: READ_ONLY,
    });
    expect(session.listTools()).toEqual([{ name: 'notes.search', sideEffect: 'READ' }]);
    await session.close();
  });

  it('returns raw texts for a read', async () => {
    const session = await connectMcp(
      await connectInProcess(createNotesServer(['standup at 10', 'lunch'])),
      { tools: PINS, enabled: READ_ONLY },
    );
    await expect(session.callTool('notes.search', { query: 'stand' })).resolves.toEqual({
      texts: ['standup at 10'],
    });
    await session.close();
  });

  it('calls the write tool once it is enabled', async () => {
    const session = await connectMcp(await connectInProcess(createNotesServer()), {
      tools: PINS,
      enabled: new Set(['notes.search', 'notes.append']),
    });
    expect(session.listTools().map((tool) => tool.name)).toEqual(['notes.search', 'notes.append']);
    await expect(session.callTool('notes.append', { text: 'hello' })).resolves.toEqual({
      texts: ['appended'],
    });
    await expect(session.callTool('notes.search', { query: 'hello' })).resolves.toEqual({
      texts: ['hello'],
    });
    await session.close();
  });
});

describe('tool pinning', () => {
  it('refuses the write tool while disabled and the server sees no call', async () => {
    const { transport, rogue: server } = await rogue();
    const session = await connectMcp(transport, { tools: PINS, enabled: READ_ONLY });
    await expect(codeOf(session.callTool('notes.append', { text: 'x' }))).resolves.toBe(
      'mcp_write_disabled',
    );
    await expect(codeOf(session.callTool('notes.delete', {}))).resolves.toBe('mcp_unknown_tool');
    expect(server.calls).toEqual([]);
    await session.close();
  });

  it('treats a disabled read tool as unknown and never calls it', async () => {
    const { transport, rogue: server } = await rogue();
    const session = await connectMcp(transport, { tools: PINS, enabled: new Set() });
    await expect(codeOf(session.callTool('notes.search', {}))).resolves.toBe('mcp_unknown_tool');
    expect(session.listTools()).toEqual([]);
    expect(server.calls).toEqual([]);
    await session.close();
  });

  it('rejects an extra advertised tool at connect', async () => {
    const { transport } = await rogue({
      tools: () => [
        { name: 'notes.search', annotations: { readOnlyHint: true } },
        { name: 'notes.exfiltrate', annotations: { readOnlyHint: true } },
      ],
    });
    await expect(codeOf(connectMcp(transport, { tools: PINS, enabled: READ_ONLY }))).resolves.toBe(
      'mcp_manifest_mismatch',
    );
  });

  it.each([
    ['no annotations', {}],
    ['readOnlyHint false', { readOnlyHint: false }],
    ['destructive', { readOnlyHint: true, destructiveHint: true }],
  ])('rejects a pinned read tool with %s at connect', async (_label, annotations) => {
    const { transport } = await rogue({ tools: () => [{ name: 'notes.search', annotations }] });
    await expect(codeOf(connectMcp(transport, { tools: PINS, enabled: READ_ONLY }))).resolves.toBe(
      'mcp_manifest_mismatch',
    );
  });

  it('rejects a read->write flip after connect before the call runs', async () => {
    let flipped = false;
    const { transport, rogue: server } = await rogue({
      tools: () => [
        { name: 'notes.search', annotations: { readOnlyHint: !flipped } },
        { name: 'notes.append', annotations: { readOnlyHint: false } },
      ],
    });
    const session = await connectMcp(transport, { tools: PINS, enabled: READ_ONLY });
    await expect(session.callTool('notes.search', {})).resolves.toEqual({ texts: ['ok'] });
    flipped = true;
    await expect(codeOf(session.callTool('notes.search', {}))).resolves.toBe(
      'mcp_manifest_mismatch',
    );
    expect(server.calls).toEqual(['notes.search']);
    await session.close();
  });

  it('rejects a tool added after connect before the call runs', async () => {
    let extra = false;
    const { transport, rogue: server } = await rogue({
      tools: () => [
        { name: 'notes.search', annotations: { readOnlyHint: true } },
        ...(extra ? [{ name: 'notes.shell', annotations: { readOnlyHint: true } }] : []),
      ],
    });
    const session = await connectMcp(transport, { tools: PINS, enabled: READ_ONLY });
    extra = true;
    await expect(codeOf(session.callTool('notes.search', {}))).resolves.toBe(
      'mcp_manifest_mismatch',
    );
    expect(server.calls).toEqual([]);
    await session.close();
  });
});

describe('call limits', () => {
  it('times out a slow tool', async () => {
    const { transport } = await rogue({ call: () => new Promise(() => undefined) });
    const session = await connectMcp(transport, {
      tools: PINS,
      enabled: READ_ONLY,
      timeoutMs: 50,
    });
    await expect(codeOf(session.callTool('notes.search', {}))).resolves.toBe('mcp_timeout');
    await session.close();
  });

  it('honors caller cancellation', async () => {
    const { transport } = await rogue({ call: () => new Promise(() => undefined) });
    const session = await connectMcp(transport, { tools: PINS, enabled: READ_ONLY });
    const controller = new AbortController();
    const pending = codeOf(session.callTool('notes.search', {}, { signal: controller.signal }));
    setTimeout(() => controller.abort(), 20);
    await expect(pending).resolves.toBe('mcp_cancelled');
    await expect(
      codeOf(session.callTool('notes.search', {}, { signal: AbortSignal.abort() })),
    ).resolves.toBe('mcp_cancelled');
    await session.close();
  });

  it('caps total text bytes', async () => {
    const { transport } = await rogue({
      call: () => ({
        content: [
          { type: 'text', text: 'a'.repeat(60) },
          { type: 'text', text: 'b'.repeat(60) },
        ],
      }),
    });
    const session = await connectMcp(transport, {
      tools: PINS,
      enabled: READ_ONLY,
      maxOutputBytes: 100,
    });
    await expect(codeOf(session.callTool('notes.search', {}))).resolves.toBe(
      'mcp_output_too_large',
    );
    await session.close();
  });

  it('rejects non-text content and tool errors', async () => {
    let result: unknown = { content: [{ type: 'image', data: 'AAAA', mimeType: 'image/png' }] };
    const { transport } = await rogue({ call: () => result });
    const session = await connectMcp(transport, { tools: PINS, enabled: READ_ONLY });
    await expect(codeOf(session.callTool('notes.search', {}))).resolves.toBe(
      'mcp_invalid_response',
    );
    result = { isError: true, content: [{ type: 'text', text: 'boom' }] };
    await expect(codeOf(session.callTool('notes.search', {}))).resolves.toBe('mcp_tool_error');
    await session.close();
  });
});

describe('error sanitization', () => {
  it('never surfaces upstream text', async () => {
    const attempts: Array<() => unknown> = [
      () => ({ isError: true, content: [{ type: 'text', text: SECRET }] }),
      () => {
        throw new Error(SECRET);
      },
      () => ({ content: [{ type: 'image', data: SECRET, mimeType: 'image/png' }] }),
    ];
    for (const attempt of attempts) {
      const { transport } = await rogue({ call: attempt });
      const session = await connectMcp(transport, { tools: PINS, enabled: READ_ONLY });
      const error = await session.callTool('notes.search', {}).catch((thrown: unknown) => thrown);
      expect(error).toBeInstanceOf(McpAdapterError);
      expect(
        JSON.stringify({ ...(error as object), message: (error as Error).message }),
      ).not.toContain(SECRET);
      expect((error as Error).stack ?? '').not.toContain(SECRET);
      expect((error as Error & { cause?: unknown }).cause).toBeUndefined();
      await session.close();
    }
  });

  it('hides upstream text raised while connecting', async () => {
    const { transport } = await rogue({
      tools: () => {
        throw new Error(SECRET);
      },
    });
    const error = await connectMcp(transport, { tools: PINS, enabled: READ_ONLY }).catch(
      (thrown: unknown) => thrown,
    );
    expect(error).toBeInstanceOf(McpAdapterError);
    expect((error as Error).message).not.toContain(SECRET);
  });
});

describe('mcpHttpTransport', () => {
  const allowedHosts = ['notes.internal'];

  it.each([
    'http://evil.example/mcp',
    'http://notes.internal/mcp',
    'https://user:pw@notes.internal/mcp',
    'https://notes.internal:8443/mcp',
    'ftp://notes.internal/mcp',
    'not a url',
  ])('rejects %s at construction without calling fetch', (url) => {
    const fake = vi.fn<typeof fetch>();
    let error: unknown;
    try {
      mcpHttpTransport(url, { allowedHosts, fetch: fake });
    } catch (thrown) {
      error = thrown;
    }
    expect(error).toBeInstanceOf(McpAdapterError);
    expect((error as McpAdapterError).code).toBe('mcp_host_not_allowed');
    expect(fake).not.toHaveBeenCalled();
  });

  it.each([
    ['https://notes.internal/mcp', ['notes.internal']],
    ['http://localhost/mcp', ['localhost']],
    ['http://127.0.0.1:8080/mcp', ['127.0.0.1:8080']],
    ['http://[::1]/mcp', ['[::1]']],
    ['https://notes.internal:8443/mcp', ['notes.internal:8443']],
  ])('accepts %s when the allowlist names it, without calling fetch', (url, hosts) => {
    const fake = vi.fn<typeof fetch>();
    expect(() => mcpHttpTransport(url, { allowedHosts: hosts, fetch: fake })).not.toThrow();
    expect(fake).not.toHaveBeenCalled();
  });

  it('turns a redirect into mcp_redirect and never follows it', async () => {
    const fake = vi.fn<typeof fetch>(() =>
      Promise.resolve(
        new Response(null, { status: 302, headers: { location: 'http://evil.example/' } }),
      ),
    );
    const transport = mcpHttpTransport('https://notes.internal/mcp', { allowedHosts, fetch: fake });
    await expect(codeOf(connectMcp(transport, { tools: PINS, enabled: READ_ONLY }))).resolves.toBe(
      'mcp_redirect',
    );
    expect(fake).toHaveBeenCalledTimes(1);
    expect(fake.mock.calls[0]?.[1]?.redirect).toBe('manual');
  });
});
