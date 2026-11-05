import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';

import { handleBrokerRequest } from './app.js';
import { createMemoryStore } from './store.js';

import type { BrokerDeps, BrokerReply } from './app.js';
import type { IncomingMessage, ServerResponse } from 'node:http';

const maxBodyBytes = 16 * 1024;

type Env = Readonly<Record<string, string | undefined>>;

function required(env: Env, name: string): string {
  const value = Reflect.get(env, name);
  if (value === undefined || value.trim() === '') throw new Error(`missing env: ${name}`);
  return value;
}

export function startBroker(env: Env = process.env) {
  const deps: BrokerDeps = {
    store: createMemoryStore(),
    google: {
      clientId: required(env, 'GOOGLE_CLIENT_ID'),
      clientSecret: required(env, 'GOOGLE_CLIENT_SECRET'),
      fetch: globalThis.fetch,
    },
    allowedDomain: required(env, 'ALLOWED_HOSTED_DOMAIN'),
    newTokenRef: () => `grant-${randomUUID()}`,
    now: () => new Date(),
  };
  const server = createServer((request, response) => {
    void serve(deps, request, response);
  });
  server.listen(Number(env.PORT ?? 8080));
  return server;
}

async function serve(
  deps: BrokerDeps,
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  let reply: BrokerReply;
  try {
    const body = await readBody(request);
    const path = new URL(request.url ?? '/', 'http://broker.internal').pathname;
    reply = await handleBrokerRequest(deps, {
      method: request.method ?? 'GET',
      path,
      body,
    });
  } catch {
    reply = { status: 500, body: { error: 'internal' } };
  }
  response.writeHead(reply.status, { 'content-type': 'application/json' });
  response.end(JSON.stringify(reply.body));
}

async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = chunk as Buffer;
    size += buffer.length;
    if (size > maxBodyBytes) throw new Error('body too large');
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}
