// JSON routes for the task graph status view. The projection is re-parsed with the frozen strict
// schema before it reaches the browser, so a field the contract does not list is dropped here too.

import {
  graphMutationSchema,
  graphProjectionSchema,
} from '@agent-works/domain/teamwork-graph-contract';

import { securityHeaders } from './headers.js';

import type { TaskRoute } from './task-routes.js';
import type { ApiResult } from '../m1/api.js';

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';

type Reply = { projection: unknown; taskVersion: number };

function checked(result: ApiResult<Reply>): ApiResult<Reply> {
  if (!result.ok) return result;
  const { projection, taskVersion } = result.value;
  if (projection === null) return { ok: true, value: { projection: null, taskVersion } };
  const parsed = graphProjectionSchema.safeParse(projection);
  return parsed.success
    ? { ok: true, value: { projection: parsed.data, taskVersion } }
    : { ok: false, status: 502, error: 'bad_contract' };
}

export const GRAPH_ROUTES: readonly TaskRoute[] = [
  {
    method: 'GET',
    pattern: new RegExp(`^/tasks/(${UUID})/graph$`),
    handle: async (req) => {
      const result = checked(await req.deps.api.graph(req.session, req.segment.id, req.m[1]));
      respond(req, result);
    },
  },
  {
    method: 'POST',
    pattern: new RegExp(`^/tasks/(${UUID})/graph/(cancel|approve)$`),
    handle: async (req, body) => {
      const action = req.m[2] === 'approve' ? 'approve' : 'cancel';
      if (!graphMutationSchema.safeParse(body).success) {
        req.response.writeHead(400, {
          ...securityHeaders,
          'content-type': 'application/json; charset=utf-8',
        });
        req.response.end(JSON.stringify({ segment: req.segment.id, error: 'bad_request' }));
        return;
      }
      const result = checked(
        await req.deps.api.graphCommand(req.session, req.segment.id, req.m[1], action, body),
      );
      respond(req, result);
    },
  },
];

function respond(req: Parameters<TaskRoute['handle']>[0], result: ApiResult<Reply>): void {
  const ok = result.ok;
  const status = ok ? 200 : result.status >= 500 ? 502 : result.status;
  req.response.writeHead(status, {
    ...securityHeaders,
    'content-type': 'application/json; charset=utf-8',
  });
  req.response.end(
    JSON.stringify(
      ok
        ? { ...result.value, segment: req.segment.id }
        : { segment: req.segment.id, error: result.error },
    ),
  );
}
