import { createListener, readLimited } from './http.js';
import { createApprovalsRoute } from './routes/approvals.js';
import { createRouteTable, matchSlot } from './routes/index.js';
import { selectRoute } from './routes/slot.js';

import type { Route } from './http.js';
import type { ApprovalsDeps } from './routes/approvals.js';
import type { AskDeps } from './routes/ask.js';
import type { RouteEnv } from './routes/slot.js';
import type { IncomingMessage, RequestListener, ServerResponse } from 'node:http';

const jsonType = 'application/json; charset=utf-8';
const textType = 'text/plain; charset=utf-8';

type AppDeps = AskDeps & { readonly approvals?: Omit<ApprovalsDeps, 'verify'> };

export function createApp(deps: AppDeps, env: RouteEnv = process.env): RequestListener {
  const listener = createListener(createRouteTable(deps, env));
  const approvals =
    deps.approvals === undefined
      ? undefined
      : createApprovalsRoute({ ...deps.approvals, verify: deps.verify });
  return (request, response) => {
    void dispatch(listener, env, approvals, request, response);
  };
}

async function dispatch(
  listener: RequestListener,
  env: RouteEnv,
  approvals: Route | undefined,
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
    const body = await readLimited(request);
    if (body === undefined) {
      response.writeHead(413, { 'content-type': jsonType });
      response.end(JSON.stringify({ error: 'too_large' }));
      return;
    }
    const route = selectRoute(
      slot.id === 'approvals-decide' ? { ...slot, real: approvals } : slot,
      env,
    );
    const reply = await route({
      method: request.method ?? 'GET',
      path: url.pathname,
      headers: request.headers,
      body,
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
