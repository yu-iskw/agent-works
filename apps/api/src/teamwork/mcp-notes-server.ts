/* eslint-disable import-x/no-unresolved -- the SDK ships wildcard subpath exports the lint resolver cannot follow */
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import * as z from 'zod';

import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';

/** First-party reference MCP server "Team notes": one READ tool and one WRITE tool, in memory. */
export function createNotesServer(seed: readonly string[] = []): McpServer {
  const notes = [...seed];
  const server = new McpServer({ name: 'team-notes', version: '1.0.0' });
  server.registerTool(
    'notes.search',
    {
      description: 'Search team notes by substring.',
      inputSchema: { query: z.string().max(200) },
      annotations: { readOnlyHint: true },
    },
    ({ query }) => ({
      content: notes
        .filter((note) => note.toLowerCase().includes(query.toLowerCase()))
        .map((text) => ({ type: 'text' as const, text })),
    }),
  );
  server.registerTool(
    'notes.append',
    {
      description: 'Append a team note.',
      inputSchema: { text: z.string().max(2000) },
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    ({ text }) => {
      notes.push(text);
      return { content: [{ type: 'text' as const, text: 'appended' }] };
    },
  );
  return server;
}

/** Connects the server to an in-memory pair and returns the client side transport. */
export async function connectInProcess(server: McpServer): Promise<Transport> {
  const [client, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  return client;
}
