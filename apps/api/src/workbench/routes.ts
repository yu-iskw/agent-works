import { IAP_ASSERTION_HEADER } from '@agent-works/domain';
import {
  WORKBENCH_API_VERSION,
  workbenchCreateSchema,
  workbenchDecisionSchema,
} from '@agent-works/domain/workbench';

import { Unauthenticated, Unavailable } from '../auth/iap.js';
import { headerValue } from '../http.js';

import { WorkbenchConflict } from './service.js';

import type { VerifyAssertion } from '../auth/iap.js';
import type { ApiReply, Route } from '../http.js';
import type { Owner, WorkbenchService } from './service.js';
import type { WorkspacePort } from './workspace.js';

type ApiRequest = Parameters<Route>[0];

const uuid = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const taskPath = new RegExp(`^/v1/workbench/tasks/(${uuid})$`);
const drivePath = /^\/v1\/workbench\/fixture\/drive\/([a-z0-9-]{1,80})$/;
const docPath = /^\/v1\/workbench\/fixture\/docs\/(fxdoc-[a-f0-9]{16})$/;

const reply = (status: number, body: unknown): ApiReply => ({ status, body });
const notFound = reply(404, { error: 'not_found' });
const invalid = reply(400, { error: 'invalid_request' });

export type WorkbenchRouteDeps = {
  readonly verify: VerifyAssertion;
  readonly service: WorkbenchService;
  readonly workspace: WorkspacePort;
};

/**
 * Owner-scoped workbench API. A task, its events and its approval are only visible to the
 * subject that created it; any other subject gets 404, never 403, so ids leak nothing.
 */
export function createWorkbenchRoute(deps: WorkbenchRouteDeps): Route {
  return async (request) => {
    let owner: Owner;
    try {
      const caller = await deps.verify(headerValue(request.headers, IAP_ASSERTION_HEADER));
      owner = { sub: caller.sub, email: caller.email ?? null };
    } catch (error) {
      if (error instanceof Unauthenticated) return reply(401, { error: 'unauthenticated' });
      if (error instanceof Unavailable) return reply(503, { error: 'unavailable' });
      throw error;
    }
    if (request.method === 'POST' && !csrfHeader(request))
      return reply(403, { error: 'csrf_missing' });
    try {
      return await route(deps, owner, request);
    } catch (error) {
      if (error instanceof WorkbenchConflict) return reply(409, { error: error.code });
      throw error;
    }
  };
}

type RouteContext = {
  readonly deps: WorkbenchRouteDeps;
  readonly owner: Owner;
  readonly request: ApiRequest;
};
type Handler = (ctx: RouteContext, params: readonly string[]) => ApiReply | Promise<ApiReply>;
type Entry = { readonly method: 'GET' | 'POST'; readonly path: RegExp; readonly handle: Handler };

const actionPath = (verb: string): RegExp => new RegExp(`^/v1/workbench/tasks/(${uuid})/${verb}$`);

/** A command that answers with the task summary when it ran, 404 when the owner has no such task. */
const command =
  (run: (service: WorkbenchService, ownerSub: string, id: string) => Promise<boolean>): Handler =>
  async ({ deps, owner }, [id]) =>
    (await run(deps.service, owner.sub, id)) ? accepted(deps.service, owner, id) : notFound;

const table: readonly Entry[] = [
  {
    method: 'GET',
    path: /^\/v1\/workbench\/readiness$/,
    handle: async ({ deps, owner }) => reply(200, await deps.service.readiness(owner)),
  },
  {
    method: 'GET',
    path: /^\/v1\/workbench\/tasks$/,
    handle: async ({ deps, owner }) =>
      reply(200, { apiVersion: WORKBENCH_API_VERSION, tasks: await deps.service.list(owner.sub) }),
  },
  {
    method: 'POST',
    path: /^\/v1\/workbench\/tasks$/,
    handle: async ({ deps, owner, request }) => {
      const parsed = workbenchCreateSchema.safeParse(json(request.body));
      if (!parsed.success)
        return reply(400, {
          error: 'invalid_request',
          message: 'Enter an objective of 1 to 4000 characters.',
        });
      const { task, created } = await deps.service.create(owner, parsed.data);
      return reply(created ? 201 : 200, { apiVersion: WORKBENCH_API_VERSION, task });
    },
  },
  {
    method: 'GET',
    path: taskPath,
    handle: async ({ deps, owner }, [id]) => {
      const detail = await deps.service.detail(owner.sub, id);
      return detail === undefined ? notFound : reply(200, detail);
    },
  },
  {
    method: 'POST',
    path: actionPath('cancel'),
    handle: command((s, sub, id) => s.cancel(sub, id)),
  },
  { method: 'POST', path: actionPath('retry'), handle: command((s, sub, id) => s.retry(sub, id)) },
  {
    method: 'POST',
    path: actionPath('reconcile'),
    handle: command((s, sub, id) => s.reconcile(sub, id)),
  },
  {
    method: 'POST',
    path: actionPath('approval'),
    handle: async ({ deps, owner, request }, [id]) => {
      const parsed = workbenchDecisionSchema.safeParse(json(request.body));
      if (!parsed.success) return invalid;
      const decided = await deps.service.decide(owner, id, parsed.data);
      if (decided === undefined) return notFound;
      if (decided === 'expired') return reply(409, { error: 'approval_expired' });
      return accepted(deps.service, owner, id);
    },
  },
  {
    method: 'GET',
    path: drivePath,
    handle: ({ deps, owner }, [sourceId]) => {
      const doc = deps.workspace.readSource(owner.sub, sourceId);
      return doc === undefined
        ? notFound
        : reply(200, {
            id: doc.id,
            title: doc.title,
            modifiedAt: doc.modifiedAt,
            body: doc.body,
            simulated: true,
          });
    },
  },
  {
    method: 'GET',
    path: docPath,
    handle: async ({ deps, owner }, [docId]) => {
      const doc = await deps.workspace.readDoc(owner.sub, docId);
      return doc === undefined ? notFound : reply(200, { ...doc, simulated: true });
    },
  },
];

async function route(
  deps: WorkbenchRouteDeps,
  owner: Owner,
  request: ApiRequest,
): Promise<ApiReply> {
  for (const entry of table) {
    if (entry.method !== request.method) continue;
    const match = entry.path.exec(request.path);
    if (match !== null) return entry.handle({ deps, owner, request }, match.slice(1));
  }
  return notFound;
}

async function accepted(service: WorkbenchService, owner: Owner, id: string): Promise<ApiReply> {
  const task = await service.task(owner.sub, id);
  return task === undefined ? notFound : reply(200, { apiVersion: WORKBENCH_API_VERSION, task });
}

function csrfHeader(request: ApiRequest): boolean {
  const token = headerValue(request.headers, 'x-csrf-token');
  return token !== undefined && token.length > 0;
}

function json(body: Buffer): unknown {
  if (body.length === 0) return undefined;
  try {
    return JSON.parse(body.toString('utf8')) as unknown;
  } catch {
    return undefined;
  }
}
