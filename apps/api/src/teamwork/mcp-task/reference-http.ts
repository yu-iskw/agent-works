/* eslint-disable import-x/no-unresolved -- the SDK ships wildcard subpath exports the lint resolver cannot follow */
import { createServer } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import * as z from 'zod';

import { TASK_TOOLS, submitInputSchema } from './contract.js';
import { createReferenceAgent, referenceDirective } from './reference-agent.js';

import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { IncomingMessage, ServerResponse } from 'node:http';

const textResult = (payload: unknown) => ({
  content: [{ type: 'text' as const, text: JSON.stringify(payload) }],
});
const toolError = () => ({
  isError: true,
  content: [{ type: 'text' as const, text: 'reference upstream secret' }],
});

type ReferenceOptions = Parameters<typeof createReferenceAgent>[0] & {
  port?: number;
  slowSubmitMs?: number;
  /** Test control for a deliberately mismatched manifest. */
  omitTool?: string;
  extraTool?: boolean;
};

function createTaskServer(
  agent: ReturnType<typeof createReferenceAgent>,
  res: ServerResponse,
  opts: ReferenceOptions,
  calls: string[],
) {
  const server = new McpServer({ name: 'local-reference-task-agent', version: '1.0.0' });
  function register(
    name: string,
    schema: z.ZodRawShape,
    handler: (args: Record<string, unknown>) => CallToolResult | Promise<CallToolResult>,
  ) {
    if (name === opts.omitTool) return;
    const pin = TASK_TOOLS.find((tool) => tool.name === name);
    server.registerTool(
      name,
      { inputSchema: schema, annotations: { readOnlyHint: pin?.readOnly ?? true } },
      async (args) => {
        calls.push(name);
        return await handler(args);
      },
    );
  }
  register('task.submit', submitInputSchema.shape, async (args) => {
    const input = submitInputSchema.parse(args);
    const directive = referenceDirective(input.instruction);
    if (directive === 'tool-error') return toolError();
    const outcome = agent.submit(input);
    if (directive === 'drop-submit' && outcome.kind === 'accepted' && !outcome.duplicate)
      res.destroy();
    if (directive === 'slow-submit') await delay(opts.slowSubmitMs ?? 2000);
    if (directive === 'invalid-json')
      return { content: [{ type: 'text' as const, text: '{invalid json' }] };
    return textResult(outcome);
  });
  register('task.status', { handle: z.string() }, (args) =>
    textResult(agent.status(z.string().parse(args.handle))),
  );
  register('task.result', { handle: z.string() }, (args) => {
    const result = agent.result(z.string().parse(args.handle));
    if (!result) return toolError();
    return textResult(result.cost.basis === 'unknown' ? { output: result.output } : result);
  });
  register('task.cancel', { handle: z.string() }, (args) =>
    textResult(agent.cancel(z.string().parse(args.handle))),
  );
  register('task.lookup', { idempotencyKey: z.string() }, (args) =>
    textResult(agent.lookup(z.string().parse(args.idempotencyKey))),
  );
  if (opts.extraTool) register('task.unapproved', {}, () => textResult({}));
  return server;
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of req) {
    const buffer: Buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    bytes += buffer.length;
    if (bytes > 1024 * 1024) throw new Error('request_too_large');
    chunks.push(buffer);
  }
  return JSON.parse(Buffer.concat(chunks).toString()) as unknown;
}

/** Starts an unauthenticated reference service bound exclusively to IPv4 loopback. */
export async function startReferenceAgent(opts: ReferenceOptions = {}) {
  const agent = createReferenceAgent(opts);
  const calls: string[] = [];
  const active = new Set<McpServer>();
  async function handle(req: IncomingMessage, res: ServerResponse) {
    if (req.url !== '/mcp') {
      res.writeHead(404).end();
      return;
    }
    if (req.method !== 'POST') {
      res.writeHead(405).end();
      return;
    }
    const server = createTaskServer(agent, res, opts, calls);
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
      enableDnsRebindingProtection: true,
      allowedHosts: [endpointHost],
    });
    active.add(server);
    res.on('close', () => {
      active.delete(server);
      void server.close().catch(() => undefined);
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, await readBody(req));
  }
  const http = createServer((req, res) => {
    void handle(req, res).catch(() => {
      if (!res.headersSent) res.writeHead(400);
      res.end();
    });
  });
  await new Promise<void>((resolve, reject) => {
    http.once('error', reject);
    http.listen(opts.port ?? 0, '127.0.0.1', resolve);
  });
  const address = http.address();
  if (!address || typeof address === 'string') throw new Error('reference_listen_failed');
  const endpointHost = `127.0.0.1:${address.port}`;
  return {
    endpoint: `http://${endpointHost}/mcp`,
    calls,
    async close() {
      await Promise.all([...active].map((server) => server.close().catch(() => undefined)));
      http.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        http.close((error) => (error ? reject(error) : resolve())),
      );
    },
  };
}
