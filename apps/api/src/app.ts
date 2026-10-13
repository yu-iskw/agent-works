import { IAP_ASSERTION_HEADER } from '@agent-works/domain';

import { Unauthenticated, Unavailable } from './auth/iap.js';
import { createListener, headerValue, readLimited } from './http.js';
import { createMemoryTaskPorts } from './ports/memory/task-ports.js';
import { createApprovalsRoute } from './routes/approvals.js';
import { createRouteTable, matchSlot } from './routes/index.js';
import { createOAuthConnectRoute, createOAuthRevokeRoute } from './routes/oauth.js';
import { selectRoute } from './routes/slot.js';
import { cancelTaskRoute } from './routes/tasks-cancel.js';
import { createTaskRoutes } from './routes/tasks.js';
import { createSkillRegistry } from './skills/registry.js';

import type { OAuthFlow } from './credentials/flow.js';
import type { Route } from './http.js';
import type { ApprovalsDeps } from './routes/approvals.js';
import type { RouteDeps } from './routes/index.js';
import type { RouteEnv } from './routes/slot.js';
import type { IncomingMessage, RequestListener, ServerResponse } from 'node:http';

const jsonType = 'application/json; charset=utf-8';
const textType = 'text/plain; charset=utf-8';

type AppDeps = RouteDeps & {
  readonly approvals?: Omit<ApprovalsDeps, 'verify'>;
  readonly oauth?: OAuthFlow;
};

export function createApp(deps: AppDeps, env: RouteEnv = process.env): RequestListener {
  const skills = deps.skills ?? createSkillRegistry();
  const memory = createMemoryTaskPorts(deps.now);
  const tasks =
    deps.tasks ??
    createTaskRoutes(
      deps.dispatch === undefined ? memory.ledger : (deps.wire?.ledger ?? memory.ledger),
      deps.verify,
      skills,
      deps,
      deps.dispatch ?? memory.dispatch,
    );
  const listener = createListener(createRouteTable({ ...deps, tasks, skills }, env));
  const approvals =
    deps.approvals === undefined
      ? undefined
      : createApprovalsRoute({ ...deps.approvals, verify: deps.verify });
  const oauthDeps =
    deps.oauth === undefined
      ? undefined
      : {
          flow: deps.oauth,
          subject: async (headers: Parameters<Route>[0]['headers']) => {
            const caller = await deps.verify(headerValue(headers, IAP_ASSERTION_HEADER));
            return caller.sub;
          },
        };
  const routes = new Map<string, Route | undefined>([
    ['tasks-read', tasks.read],
    ['tasks-events', tasks.events],
    ['tasks-cancel', taskCancellation(tasks.cancel)],
    ['approvals-decide', approvals],
    ['approvals-read', approvals],
    ['oauth-connect', oauthDeps === undefined ? undefined : createOAuthConnectRoute(oauthDeps)],
    ['oauth-revoke', oauthDeps === undefined ? undefined : createOAuthRevokeRoute(oauthDeps)],
  ]);
  return (request, response) => {
    void dispatch(listener, env, routes, request, response);
  };
}

async function dispatch(
  listener: RequestListener,
  env: RouteEnv,
  routes: ReadonlyMap<string, Route | undefined>,
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
      routes.has(slot.id) ? { ...slot, real: routes.get(slot.id) } : slot,
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
  } catch (error) {
    dispatchError(error, response);
  }
}

function dispatchError(error: unknown, response: ServerResponse): void {
  if (response.headersSent) return;
  if (error instanceof Unauthenticated || error instanceof Unavailable) {
    const unauthenticated = error instanceof Unauthenticated;
    response.writeHead(unauthenticated ? 401 : 503, { 'content-type': jsonType });
    response.end(JSON.stringify({ error: unauthenticated ? 'unauthenticated' : 'unavailable' }));
    return;
  }
  response.writeHead(500, { 'content-type': textType });
  response.end('error');
}

function taskCancellation(cancel: Route | undefined): Route {
  return async (request) => {
    const reply = await cancel?.(request);
    return reply === undefined || reply.status === 404 ? cancelTaskRoute(request) : reply;
  };
}
