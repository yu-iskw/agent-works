// The workspace's HTTP surface: shell documents for `/s/<seg>[/teammates/<id>...]` and JSON routes
// under `/api/s/<seg>/`. handler.ts dispatches here; everything segment-facing goes through loaders.

import { CSRF_HEADER, pages } from '../../shared/contract.js';
import { formatRoute, parseRoute } from '../../shared/route.js';
import { readBody } from '../body.js';

import { csrfOk } from './csrf.js';
import { securityHeaders } from './headers.js';
import {
  loadConversation,
  loadMe,
  loadTeammateConversation,
  loadTeammates,
  messagePostSchema,
  unavailableMe,
} from './loaders.js';
import { memberTag } from './member-tag.js';
import { preferencesPatchSchema } from './preferences.js';
import { shellDocument } from './shell.js';
import { resolveStartup } from './startup.js';

import type { LoaderDeps } from './loaders.js';
import type { PreferencesStore } from './preferences.js';
import type {
  BootNotice,
  Bootstrap,
  ConversationPage,
  MeView,
  TeammatesPage,
} from '../../shared/contract.js';
import type { Route } from '../../shared/route.js';
import type { ApiResult } from '../m1/api.js';
import type { Segment } from '../m1/config.js';
import type { Session } from '../m1/identity.js';
import type { IncomingMessage, ServerResponse } from 'node:http';

export type WorkspaceDeps = LoaderDeps & {
  readonly prefs: PreferencesStore;
  readonly origins: ReadonlySet<string>;
};

const HTML = 'text/html; charset=utf-8';
const MAX_JSON = 262_144;
const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';

type SegReq = {
  readonly deps: WorkspaceDeps;
  readonly response: ServerResponse;
  readonly url: URL;
  readonly session: Session;
  readonly segment: Segment;
};

function json(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, {
    ...securityHeaders,
    'content-type': 'application/json; charset=utf-8',
  });
  response.end(JSON.stringify(body));
}

function failed(
  response: ServerResponse,
  segment: Segment,
  result: { status: number; error: string },
) {
  json(response, result.status >= 500 ? 502 : result.status, {
    segment: segment.id,
    error: result.error,
  });
}

// ---- shell ----

type Loaded = {
  readonly me: MeView;
  readonly teammates: TeammatesPage;
  readonly notice: BootNotice | null;
  readonly status: number;
};

async function loadShared({ deps, session, segment }: SegReq): Promise<Loaded> {
  const [me, teammates] = await Promise.all([
    loadMe(deps, session, segment),
    loadTeammates(deps, session, segment),
  ]);
  if (me.ok && teammates.ok)
    return { me: me.value, teammates: teammates.value, notice: null, status: 200 };
  const error = me.ok ? (teammates.ok ? 'unavailable' : teammates.error) : me.error;
  return {
    me: me.ok ? me.value : unavailableMe(deps, session, segment),
    teammates: teammates.ok
      ? teammates.value
      : { segment: segment.id, items: [], nextCursor: null },
    notice: { code: 'segment_unavailable', error },
    status: 502,
  };
}

function renderShell(
  req: SegReq,
  input: {
    readonly status: number;
    readonly route: Route;
    readonly loaded: Loaded;
    readonly conversation: ConversationPage | null;
    readonly notice: BootNotice | null;
    readonly title: string;
  },
): Promise<void> {
  const { deps, response, session, segment } = req;
  return deps.prefs.read(session.sub, segment.id).then((prefs) => {
    const teammate = input.route.teammate;
    const bootstrap: Bootstrap = {
      scope: { memberTag: memberTag(session.sub), segment: segment.id, csrf: session.csrf },
      route: input.route,
      me: input.loaded.me,
      prefs,
      teammates: input.loaded.teammates,
      conversation: input.conversation,
      notice: input.notice ?? input.loaded.notice,
      fallbackHref:
        teammate === null
          ? pages.teammates(segment.id)
          : pages.teammateFallback(segment.id, teammate),
    };
    response.writeHead(input.status, { ...securityHeaders, 'content-type': HTML });
    response.end(
      shellDocument({
        bootstrap,
        title: input.title,
        summary: `${segment.name} · ${session.email} · ${input.title}`,
      }),
    );
  });
}

async function startup(req: SegReq, route: Route): Promise<void> {
  const { deps, response, session, segment } = req;
  const loaded = await loadShared(req);
  if (loaded.status !== 200)
    return renderShell(req, {
      status: 502,
      route,
      loaded,
      conversation: null,
      notice: null,
      title: segment.name,
    });
  const prefs = await deps.prefs.read(session.sub, segment.id);
  const target = resolveStartup(prefs, loaded.teammates.items);
  if (target.kind === 'empty')
    return renderShell(req, {
      status: 200,
      route,
      loaded,
      conversation: null,
      notice: { code: 'no_teammates' },
      title: segment.name,
    });
  const location =
    target.kind === 'inbox'
      ? pages.inbox(segment.id)
      : withNotice(formatRoute({ ...route, teammate: target.id }), target.notice);
  response.writeHead(303, { ...securityHeaders, location });
  response.end();
}

const withNotice = (url: string, notice: BootNotice | null): string =>
  notice === null ? url : `${url}${url.includes('?') ? '&' : '?'}notice=${notice.code}`;

function noticeFrom(url: URL): BootNotice | null {
  return url.searchParams.get('notice') === 'remembered_teammate_gone'
    ? { code: 'remembered_teammate_gone' }
    : null;
}

async function conversationShell(req: SegReq, route: Route, teammateId: string): Promise<void> {
  const { deps, session, segment, url } = req;
  const loaded = await loadShared(req);
  const row = loaded.teammates.items.find((t) => t.id === teammateId);
  const conversation: ApiResult<ConversationPage> =
    loaded.status !== 200
      ? { ok: false, status: 502, error: 'unavailable' }
      : row === undefined
        ? await loadTeammateConversation(deps, session, segment, teammateId)
        : await loadConversation(deps, session, segment, {
            conversationId: row.conversationId,
            teammateId,
            after: null,
          });
  if (conversation.ok)
    return renderShell(req, {
      status: 200,
      route,
      loaded,
      conversation: conversation.value,
      notice: noticeFrom(url),
      title: row?.name ?? 'Conversation',
    });
  if (conversation.status === 404)
    return renderShell(req, {
      status: 404,
      route: { ...route, panel: { kind: 'missing', what: 'teammate', id: teammateId } },
      loaded,
      conversation: null,
      notice: null,
      title: 'Not found',
    });
  return renderShell(req, {
    status: 502,
    route,
    loaded,
    conversation: null,
    notice: loaded.notice ?? { code: 'segment_unavailable', error: conversation.error },
    title: segment.name,
  });
}

/** Renders the workspace when the URL is a workspace route; false leaves it to the page routes. */
export async function handleShell(req: SegReq): Promise<boolean> {
  const route = parseRoute(req.url.pathname, req.url.search);
  if (route === undefined || route.segment !== req.segment.id) return false;
  if (route.teammate === null) await startup(req, route);
  else await conversationShell(req, route, route.teammate);
  return true;
}

// ---- JSON ----

type JsonReq = SegReq & { readonly request: IncomingMessage; readonly m: RegExpExecArray };
type JsonRoute = {
  readonly method: 'GET' | 'POST';
  readonly pattern: RegExp;
  readonly handle: (req: JsonReq, body: unknown) => Promise<void>;
};

function reply<T>(req: JsonReq, result: ApiResult<T>, status = 200): void {
  if (!result.ok) return failed(req.response, req.segment, result);
  json(req.response, status, { segment: req.segment.id, ...(result.value as object) });
}

const JSON_ROUTES: readonly JsonRoute[] = [
  {
    method: 'GET',
    pattern: /^\/me$/,
    handle: async (req) => reply(req, await loadMe(req.deps, req.session, req.segment)),
  },
  {
    method: 'GET',
    pattern: /^\/teammates$/,
    handle: async (req) => reply(req, await loadTeammates(req.deps, req.session, req.segment)),
  },
  {
    method: 'GET',
    pattern: new RegExp(`^/conversations/(${UUID})$`),
    handle: async (req) => {
      const teammateId = req.url.searchParams.get('teammate') ?? '';
      if (!new RegExp(`^${UUID}$`).test(teammateId))
        return failed(req.response, req.segment, { status: 400, error: 'bad_request' });
      const after = req.url.searchParams.get('after');
      reply(
        req,
        await loadConversation(req.deps, req.session, req.segment, {
          conversationId: req.m[1],
          teammateId,
          after: after === null || after === '' ? null : after,
        }),
      );
    },
  },
  {
    method: 'POST',
    pattern: new RegExp(`^/conversations/(${UUID})/messages$`),
    handle: async (req, body) => {
      const parsed = messagePostSchema.safeParse(body);
      if (!parsed.success)
        return failed(req.response, req.segment, { status: 400, error: 'bad_request' });
      const result = await req.deps.api.postMessage(
        req.session,
        req.segment.id,
        req.m[1],
        parsed.data,
      );
      reply(req, result.ok ? { ok: true, value: { accepted: true } } : result, 202);
    },
  },
  {
    method: 'GET',
    pattern: /^\/preferences$/,
    handle: async (req) =>
      json(req.response, 200, {
        segment: req.segment.id,
        ...(await req.deps.prefs.read(req.session.sub, req.segment.id)),
      }),
  },
  {
    method: 'POST',
    pattern: /^\/preferences$/,
    handle: async (req, body) => {
      const parsed = preferencesPatchSchema.safeParse(body);
      if (!parsed.success)
        return failed(req.response, req.segment, { status: 400, error: 'bad_request' });
      json(req.response, 200, {
        segment: req.segment.id,
        ...(await req.deps.prefs.write(req.session.sub, req.segment.id, parsed.data)),
      });
    },
  },
];

async function readJson(
  request: IncomingMessage,
): Promise<
  { readonly ok: true; readonly body: unknown } | { readonly ok: false; readonly status: number }
> {
  const raw = await readBody(request, MAX_JSON);
  if (raw === undefined) return { ok: false, status: 413 };
  try {
    return { ok: true, body: JSON.parse(raw.toString('utf8')) as unknown };
  } catch {
    return { ok: false, status: 400 };
  }
}

/** Dispatches `/api/s/<seg>/...` for a signed-in member. The caller has already answered 401. */
export async function handleApi(
  deps: WorkspaceDeps,
  input: {
    readonly request: IncomingMessage;
    readonly response: ServerResponse;
    readonly url: URL;
    readonly session: Session;
  },
): Promise<void> {
  const { request, response, url, session } = input;
  const seg = /^\/api\/s\/([a-z][a-z0-9-]{1,30})(\/.*)$/.exec(url.pathname);
  const segment = seg === null ? undefined : deps.api.segmentFor(session, seg[1]);
  if (seg === null || segment === undefined)
    return json(response, 404, { error: 'segment_not_found' });
  const method = request.method === 'POST' ? 'POST' : 'GET';
  const hit = JSON_ROUTES.flatMap((route) => {
    const m = route.method === method ? route.pattern.exec(seg[2]) : null;
    return m === null ? [] : [{ route, m }];
  }).at(0);
  if (hit === undefined) return json(response, 404, { segment: segment.id, error: 'not_found' });
  const req: JsonReq = { deps, request, response, url, session, segment, m: hit.m };
  if (method === 'GET') return hit.route.handle(req, undefined);
  // A fixed header name, not request-controlled.
  // eslint-disable-next-line security/detect-object-injection
  const presented = request.headers[CSRF_HEADER];
  if (
    !csrfOk({
      headers: request.headers,
      presented: typeof presented === 'string' ? presented : undefined,
      sessionCsrf: session.csrf,
      origins: deps.origins,
      json: true,
    })
  )
    return json(response, 403, { segment: segment.id, error: 'csrf' });
  const body = await readJson(request);
  if (!body.ok)
    return json(response, body.status, {
      segment: segment.id,
      error: body.status === 413 ? 'too_large' : 'bad_request',
    });
  return hit.route.handle(req, body.body);
}
