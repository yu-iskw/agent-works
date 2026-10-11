import { createListener } from './http.js';
import { createRouteTable, matchSlot } from './routes/index.js';
import { selectRoute } from './routes/slot.js';

import type { AskDeps } from './routes/ask.js';
import type { RouteEnv } from './routes/slot.js';
import type { IncomingMessage, RequestListener, ServerResponse } from 'node:http';

const jsonType = 'application/json; charset=utf-8';
const textType = 'text/plain; charset=utf-8';

export function createApp(deps: AskDeps, env: RouteEnv = process.env): RequestListener {
  const listener = createListener(createRouteTable(deps, env));
  return (request, response) => {
    void dispatch(listener, env, request, response);
  };
}

async function dispatch(
  listener: RequestListener,
  env: RouteEnv,
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  try {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    const slot = matchSlot(request.method ?? 'GET', url.pathname);
    if (slot === undefined) {
      listener(request, response);
      return;
    }
    request.resume();
    const reply = await selectRoute(slot, env)({
      method: request.method ?? 'GET',
      path: url.pathname,
      headers: request.headers,
      body: Buffer.alloc(0),
    });
    const payload = typeof reply.body === 'string' ? reply.body : JSON.stringify(reply.body);
    const type = typeof reply.body === 'string' ? textType : jsonType;
    response.writeHead(reply.status, { 'content-type': type });
    response.end(payload);
  } catch {
    if (!response.headersSent) {
      response.writeHead(500, { 'content-type': textType });
      response.end('error');
    }
  }
}
