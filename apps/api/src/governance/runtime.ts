import { createApp } from '../app.js';
import { readLimited } from '../http.js';
import { createArtifactsReadRoute } from '../routes/artifacts-read.js';
import { governanceRoutes } from '../routes/governance-routes.js';

import type { GovernedArtifactReadDeps } from './artifact-route.js';
import type { GovernanceRegistration } from '../routes/governance-routes.js';
import type { RouteDeps } from '../routes/index.js';
import type { RouteEnv } from '../routes/slot.js';
import type { RequestListener, ServerResponse } from 'node:http';

export type GovernanceRuntimeDeps = {
  readonly app: RouteDeps;
  readonly registration: GovernanceRegistration;
  readonly artifacts: GovernedArtifactReadDeps;
};
/** Offline composition root: existing task dispatch stays intact. No cloud adapter
 * or service deletion claim is introduced by mounting this local governance surface. */
export function createGovernanceApp(
  deps: GovernanceRuntimeDeps,
  env: RouteEnv = {},
): RequestListener {
  const fallback = createApp(deps.app, env);
  const routes = new Map(Object.entries(governanceRoutes(deps.registration)));
  const artifact = createArtifactsReadRoute(deps.artifacts);
  return (request, response) => {
    let url: URL;
    try {
      url = new URL(request.url ?? '/', 'http://127.0.0.1');
    } catch {
      reply(response, 400, { error: 'invalid_request_target' });
      return;
    }
    const route =
      request.method === 'GET' && /^\/v1\/artifacts\/[^/]+$/.test(url.pathname)
        ? artifact
        : routes.get(`${request.method ?? 'GET'} ${url.pathname}`);
    if (route === undefined) {
      fallback(request, response);
      return;
    }
    void (async () => {
      try {
        const body = await readLimited(request);
        if (body === undefined) {
          reply(response, 413, { error: 'too_large' });
          return;
        }
        const result = await route({
          method: request.method ?? 'GET',
          path: url.pathname,
          headers: request.headers,
          body,
        });
        reply(response, result.status, result.body);
      } catch {
        reply(response, 503, { error: 'governance_unavailable' });
      }
    })();
  };
}

function reply(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  response.end(JSON.stringify(body));
}
