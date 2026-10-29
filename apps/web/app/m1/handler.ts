import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';

import { artifactMarkdown } from '@agent-works/domain/teamwork-evidence';

import { readBody } from '../body.js';

import { segmentsFor } from './config.js';
import { SESSION_COOKIE, SignInError } from './identity.js';
import { errorText } from './labels.js';
import { m1Styles } from './styles.js';
import { ComparePage, NewTaskPage, TaskPage, TasksPage } from './task-views.js';
import {
  CatalogPage,
  ConnectionsPage,
  DocumentPage,
  ErrorPage,
  ExportPage,
  ImportPage,
  InboxPage,
  SignInPage,
  SkillPage,
  TeammatePage,
  TeammatesPage,
  segPath,
} from './views.js';

import type { ApiResult, ExportPreview, SegmentClient } from './api.js';
import type { Segment, WebConfig } from './config.js';
import type { Identity, Session } from './identity.js';
import type { NewTaskValues } from './task-views.js';
import type { NavKey, Notice, PageCtx } from './views.js';
import type { Html } from '../html.js';
import type { SkillView, TeammateView, Workflow } from '@agent-works/domain/teamwork';
import type { IncomingMessage, RequestListener, ServerResponse } from 'node:http';

const HTML = 'text/html; charset=utf-8';
const PRE_COOKIE = 'aw_m1_pre';
const MAX_FORM = 262_144;
const SESSION_TTL = 12 * 3600;
// A literal, so the route patterns stay statically checkable; it matches UUID_PATTERN in the domain package.
const uuid = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';

const securityHeaders = {
  'content-security-policy':
    "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; form-action 'self' https://accounts.google.com https://github.com; base-uri 'none'; object-src 'none'",
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'same-origin',
  'x-frame-options': 'DENY',
  'cache-control': 'no-store',
};

const NOTICES: Record<string, Notice> = {
  task_started: {
    tone: 'ok',
    text: 'Task started. You can leave this page; the inbox tells you when something needs you.',
  },
  plan_approved: { tone: 'ok', text: 'Plan approved. Specialists are working in parallel.' },
  plan_rejected: { tone: 'info', text: 'Plan rejected. Nothing was dispatched.' },
  plan_edited: { tone: 'info', text: 'Saved as a new plan version. Review it before approving.' },
  replan: { tone: 'info', text: 'The coordinator is drafting a new plan.' },
  revision_requested: {
    tone: 'ok',
    text: 'Revision requested. The current version stays available.',
  },
  answered: { tone: 'ok', text: 'Answer sent. The specialist continues with it.' },
  asked: { tone: 'ok', text: 'Question sent to the result owner.' },
  rescoped: { tone: 'ok', text: 'Re-running the data step with the new comparison.' },
  retrying: { tone: 'ok', text: 'Retrying.' },
  proceeding: {
    tone: 'info',
    text: 'Writing the result from the finished contributions. The missing ones are listed as limitations.',
  },
  cancelled: { tone: 'info', text: 'Task cancelled. Nothing more will run.' },
  publish_approved: { tone: 'ok', text: 'Approved. Creating the document now.' },
  publish_rejected: { tone: 'info', text: 'Publication rejected. Nothing was written.' },
  reconciled: { tone: 'ok', text: 'Checked with Google Docs.' },
  teammate_created: {
    tone: 'ok',
    text: 'Teammate added. It is your private copy; the curated template is unchanged.',
  },
  starter_created: { tone: 'ok', text: 'Starter team added.' },
  teammate_saved: {
    tone: 'ok',
    text: 'Saved. New work uses this version; active work keeps the version it started with.',
  },
  skill_saved: { tone: 'ok', text: 'Skills updated.' },
  skill_customized: {
    tone: 'ok',
    text: 'Saved your private skill. The curated original is unchanged.',
  },
  attachments_saved: { tone: 'ok', text: 'Attachments saved.' },
  message_sent: { tone: 'ok', text: 'Sent. The reply appears here.' },
  connected: { tone: 'ok', text: 'Connected in this segment only.' },
  disconnected: {
    tone: 'info',
    text: 'Disconnected and revoked. Work in this segment can no longer use that account.',
  },
  dismissed: { tone: 'info', text: 'Dismissed.' },
};

export type HandlerDeps = {
  readonly config: WebConfig;
  readonly identity: Identity;
  readonly api: SegmentClient;
};

type Asset = { readonly body: string; readonly type: string; readonly etag: string };

type App = HandlerDeps & {
  readonly assets: ReadonlyMap<string, Asset>;
  readonly origins: ReadonlySet<string>;
};

/** One request past the asset check, with the session its cookie names, if any. */
type Req = {
  readonly app: App;
  readonly request: IncomingMessage;
  readonly response: ServerResponse;
  readonly url: URL;
  readonly jar: ReadonlyMap<string, string>;
  readonly session: Session | undefined;
};

type Signed = Omit<Req, 'session'> & { readonly session: Session };

/** A signed-in request inside one segment; `m` is the route pattern's match on the segment-relative path. */
type SegReq = {
  readonly app: App;
  readonly response: ServerResponse;
  readonly url: URL;
  readonly session: Session;
  readonly segment: Segment;
  readonly m: RegExpExecArray;
};

type PostReq = SegReq & { readonly form: URLSearchParams };

type Route<C> = { readonly pattern: RegExp; readonly handle: (req: C) => Promise<void> | void };

function asset(body: string, type: string): Asset {
  return { body, type, etag: `"${createHash('sha256').update(body).digest('hex').slice(0, 32)}"` };
}

function loadScript(): string {
  // Static path inside this package's build output, never request controlled.
  // eslint-disable-next-line security/detect-non-literal-fs-filename
  return readFileSync(new URL('../../client/m1.js', import.meta.url), 'utf8');
}

function cookies(request: IncomingMessage): ReadonlyMap<string, string> {
  return new Map(
    (request.headers.cookie ?? '')
      .split(';')
      .map((part) => part.trim())
      .filter(Boolean)
      .map(
        (part) =>
          [part.slice(0, part.indexOf('=')), part.slice(part.indexOf('=') + 1)] as [string, string],
      ),
  );
}

async function readForm(request: IncomingMessage): Promise<URLSearchParams | undefined> {
  const body = await readBody(request, MAX_FORM);
  return body === undefined ? undefined : new URLSearchParams(body.toString('utf8'));
}

function same(a: string | null | undefined, b: string): boolean {
  if (a === null || a === undefined) return false;
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

function render(
  response: ServerResponse,
  status: number,
  title: string,
  body: Html,
  extra: Record<string, string> = {},
): void {
  response.writeHead(status, { ...securityHeaders, 'content-type': HTML, ...extra });
  response.end(
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escape(title)} · Agent Works</title><link rel="stylesheet" href="/assets/m1.css"><script src="/assets/m1.js" defer></script></head><body>${body.html}</body></html>`,
  );
}

function escape(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

function redirect(
  response: ServerResponse,
  location: string,
  extra: Record<string, string | string[]> = {},
): void {
  response.writeHead(303, { ...securityHeaders, location, ...extra });
  response.end();
}

function json(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, {
    ...securityHeaders,
    'content-type': 'application/json; charset=utf-8',
  });
  response.end(JSON.stringify(body));
}

function sessionCookie(value: string, maxAge: number): string {
  return `${SESSION_COOKIE}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}`;
}

function signInError(error: unknown): string {
  return `/sign-in?error=${error instanceof SignInError ? error.code : 'unavailable'}`;
}

/** Form names repeat for checkboxes; this keeps every value. */
function formValues(form: URLSearchParams): NewTaskValues {
  const out: Record<string, string | string[]> = {};
  for (const key of new Set(form.keys())) {
    const all = form.getAll(key);
    // eslint-disable-next-line security/detect-object-injection
    out[key] = all.length > 1 || key.endsWith('.sources') ? all : (all[0] ?? '');
  }
  return out;
}

const lines = (value: string | null) =>
  (value ?? '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);

function originOk(app: App, request: IncomingMessage): boolean {
  const origin =
    request.headers.origin ??
    (request.headers.referer === undefined
      ? undefined
      : URL.parse(request.headers.referer)?.origin);
  return origin !== undefined && app.origins.has(origin);
}

async function ctxFor(
  req: Pick<SegReq, 'app' | 'session' | 'segment' | 'url'>,
  nav: NavKey,
): Promise<PageCtx> {
  const { app, session, segment, url } = req;
  const me = await app.api.me(session, segment.id);
  const notice = NOTICES[url.searchParams.get('notice') ?? ''];
  const error = url.searchParams.get('error');
  return {
    session,
    segment,
    segments: segmentsFor(app.config, session.email),
    readiness: me.ok ? me.value : undefined,
    nav,
    notice: error !== null ? { tone: 'danger', text: errorText(error) } : notice,
  };
}

function failPage(
  response: ServerResponse,
  ctx: PageCtx | undefined,
  result: { status: number; error: string },
): void {
  if (result.error === 'unauthenticated') return redirect(response, '/sign-in');
  const status = result.status === 404 ? 404 : result.status >= 500 ? 502 : result.status;
  render(
    response,
    status,
    'Not available',
    ErrorPage({
      ctx,
      title: status === 404 ? 'Not found' : 'Something went wrong',
      code: result.error,
    }),
  );
}

function back(
  req: Pick<SegReq, 'response' | 'segment'>,
  target: string,
  result: ApiResult<unknown>,
  notice: string,
): void {
  redirect(
    req.response,
    segPath(
      req.segment,
      `${target}${target.includes('?') ? '&' : '?'}${result.ok ? `notice=${notice}` : `error=${result.error}`}${target.startsWith('/tasks/') && target.length > 7 ? '#decision' : ''}`,
    ),
  );
}

/** Splits `/s/<segment>[/rest]` into the segment id and the segment-relative path ('' when absent). */
function splitSegment(path: string): { readonly id: string; readonly sub: string } | undefined {
  const m = /^\/s\/([a-z][a-z0-9-]{1,30})(?=\/|$)/.exec(path);
  return m === null ? undefined : { id: m[1], sub: path.slice(m[0].length) };
}

function match<C>(
  routes: readonly Route<C>[],
  sub: string,
): { readonly route: Route<C>; readonly m: RegExpExecArray } | undefined {
  for (const route of routes) {
    const m = route.pattern.exec(sub);
    if (m !== null) return { route, m };
  }
  return undefined;
}

function serveAsset(request: IncomingMessage, response: ServerResponse, found: Asset): void {
  if (request.headers['if-none-match'] === found.etag) {
    response.writeHead(304).end();
    return;
  }
  response.writeHead(200, {
    'content-type': found.type,
    etag: found.etag,
    'cache-control': 'no-cache',
    'x-content-type-options': 'nosniff',
  });
  response.end(found.body);
}

function signInPage({ app, response, url, session }: Req): void {
  if (session !== undefined) return redirect(response, '/');
  const pre = randomBytes(32).toString('hex');
  render(
    response,
    200,
    'Sign in',
    SignInPage({
      identity: app.config.identity,
      error: url.searchParams.get('error') ?? undefined,
      configured: app.config.google !== undefined,
      csrf: pre,
    }),
    {
      'set-cookie': `${PRE_COOKIE}=${pre}; Path=/; HttpOnly; SameSite=Strict; Max-Age=900`,
    },
  );
}

async function googleStart({ app, response }: Req): Promise<void> {
  try {
    return redirect(response, await app.identity.startGoogle('/'));
  } catch (error) {
    return redirect(response, signInError(error));
  }
}

async function googleCallback({ app, response, url }: Req): Promise<void> {
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  if (code === null || state === null)
    return redirect(
      response,
      `/sign-in?error=${url.searchParams.get('error') === 'access_denied' ? 'access_denied' : 'bad_state'}`,
    );
  try {
    const done = await app.identity.completeGoogle(code, state);
    return redirect(response, '/', { 'set-cookie': sessionCookie(done.cookie, SESSION_TTL) });
  } catch (error) {
    return redirect(response, signInError(error));
  }
}

async function localTestSignIn({ app, request, response, jar }: Req): Promise<void> {
  const form = await readForm(request);
  if (
    form === undefined ||
    !same(form.get('csrf'), jar.get(PRE_COOKIE) ?? '') ||
    !originOk(app, request)
  )
    return redirect(response, '/sign-in?error=bad_state');
  try {
    const done = await app.identity.localTest(form.get('email') ?? '');
    return redirect(response, '/', { 'set-cookie': sessionCookie(done.cookie, SESSION_TTL) });
  } catch (error) {
    return redirect(response, signInError(error));
  }
}

/** Routes served before the session gate; exact paths, so order does not matter. */
const PUBLIC_ROUTES: readonly {
  readonly method: string;
  readonly path: string;
  readonly handle: (req: Req) => Promise<void> | void;
}[] = [
  {
    method: 'GET',
    path: '/',
    handle: ({ app, response, session }) =>
      redirect(
        response,
        session === undefined
          ? '/sign-in'
          : segPath(segmentsFor(app.config, session.email).at(0)?.id ?? 'none', '/inbox'),
      ),
  },
  { method: 'GET', path: '/sign-in', handle: signInPage },
  { method: 'GET', path: '/auth/google/start', handle: googleStart },
  { method: 'GET', path: '/auth/google/callback', handle: googleCallback },
  { method: 'POST', path: '/auth/local-test', handle: localTestSignIn },
];

async function inboxPage(req: SegReq): Promise<void> {
  const { app, response, session, segment } = req;
  const [ctx, items] = await Promise.all([
    ctxFor(req, 'inbox'),
    app.api.inbox(session, segment.id),
  ]);
  return items.ok
    ? render(response, 200, 'Inbox', InboxPage({ ctx, items: items.value.items }))
    : failPage(response, ctx, items);
}

async function teammatesPage(req: SegReq): Promise<void> {
  const { app, response, session, segment } = req;
  const [ctx, list] = await Promise.all([
    ctxFor(req, 'teammates'),
    app.api.teammates(session, segment.id),
  ]);
  return list.ok
    ? render(response, 200, 'Teammates', TeammatesPage({ ctx, teammates: list.value.teammates }))
    : failPage(response, ctx, list);
}

async function teammatePage(req: SegReq): Promise<void> {
  const { app, response, session, segment, m } = req;
  const [ctx, found, catalog] = await Promise.all([
    ctxFor(req, 'teammates'),
    app.api.teammate(session, segment.id, m[1]),
    app.api.catalog(session, segment.id),
  ]);
  if (!found.ok) return failPage(response, ctx, found);
  return render(
    response,
    200,
    found.value.teammate.name,
    TeammatePage({
      ctx,
      teammate: found.value.teammate,
      conversation: found.value.conversation,
      skills: catalog.ok ? catalog.value.skills : [],
    }),
  );
}

async function loadExport(
  req: SegReq,
): Promise<
  | { readonly ctx: PageCtx; readonly teammate: TeammateView; readonly preview: ExportPreview }
  | undefined
> {
  const { app, response, session, segment, m } = req;
  const [ctx, found, preview] = await Promise.all([
    ctxFor(req, 'teammates'),
    app.api.teammate(session, segment.id, m[1]),
    app.api.exportTeammate(session, segment.id, m[1]),
  ]);
  if (!found.ok) {
    failPage(response, ctx, found);
    return undefined;
  }
  if (!preview.ok) {
    failPage(response, ctx, preview);
    return undefined;
  }
  return { ctx, teammate: found.value.teammate, preview: preview.value.export };
}

async function exportPage(req: SegReq): Promise<void> {
  const loaded = await loadExport(req);
  if (loaded !== undefined)
    render(
      req.response,
      200,
      'Export',
      ExportPage({ ctx: loaded.ctx, teammate: loaded.teammate, preview: loaded.preview }),
    );
}

async function exportJson(req: SegReq): Promise<void> {
  const loaded = await loadExport(req);
  if (loaded === undefined) return;
  if (loaded.preview.findings.length > 0)
    return failPage(req.response, loaded.ctx, { status: 409, error: 'contains_secrets' });
  req.response.writeHead(200, {
    ...securityHeaders,
    'content-type': 'application/json; charset=utf-8',
    'content-disposition': 'attachment; filename="teammate-definition.json"',
  });
  req.response.end(loaded.preview.json);
}

async function tasksPage(req: SegReq): Promise<void> {
  const { app, response, session, segment } = req;
  const [ctx, list] = await Promise.all([ctxFor(req, 'tasks'), app.api.tasks(session, segment.id)]);
  return list.ok
    ? render(response, 200, 'Tasks', TasksPage({ ctx, tasks: list.value.tasks }))
    : failPage(response, ctx, list);
}

async function taskVersion({ app, response, session, segment, m }: SegReq): Promise<void> {
  const state = await app.api.taskVersion(session, segment.id, m[1]);
  return state.ok
    ? json(response, 200, {
        segment: segment.id,
        version: state.value.version,
        status: state.value.status,
      })
    : json(response, state.status, { error: state.error });
}

async function taskPage(req: SegReq): Promise<void> {
  const { app, response, session, segment, url, m } = req;
  const [ctx, task, team] = await Promise.all([
    ctxFor(req, 'tasks'),
    app.api.task(session, segment.id, m[1]),
    app.api.teammates(session, segment.id),
  ]);
  if (!task.ok) return failPage(response, ctx, task);
  const rev = Number(url.searchParams.get('rev'));
  return render(
    response,
    200,
    task.value.task.title,
    TaskPage({
      ctx,
      detail: task.value,
      teammates: team.ok ? team.value.teammates : [],
      revision: Number.isInteger(rev) && rev > 0 ? rev : null,
    }),
  );
}

async function comparePage(req: SegReq): Promise<void> {
  const { app, response, session, segment, url, m } = req;
  const [ctx, task] = await Promise.all([
    ctxFor(req, 'tasks'),
    app.api.task(session, segment.id, m[1]),
  ]);
  if (!task.ok) return failPage(response, ctx, task);
  const revs = task.value.revisions;
  const to = revs.find((r) => r.revision === Number(url.searchParams.get('to'))) ?? revs.at(-1);
  const from =
    revs.find((r) => r.revision === Number(url.searchParams.get('from'))) ?? revs.at(-2) ?? to;
  if (from === undefined || to === undefined)
    return failPage(response, ctx, { status: 404, error: 'not_found' });
  return render(response, 200, 'Compare', ComparePage({ ctx, detail: task.value, from, to }));
}

async function revisionMarkdown({ app, response, session, segment, m }: SegReq): Promise<void> {
  const task = await app.api.task(session, segment.id, m[1]);
  if (!task.ok) return failPage(response, undefined, task);
  const rev = task.value.revisions.find((r) => r.revision === Number(m[2]));
  if (rev === undefined) return failPage(response, undefined, { status: 404, error: 'not_found' });
  response.writeHead(200, {
    ...securityHeaders,
    'content-type': 'text/markdown; charset=utf-8',
    'content-disposition': `attachment; filename="revision-${rev.revision}.md"`,
  });
  response.end(
    artifactMarkdown(rev.content, new Map(task.value.evidence.map((e) => [e.id, e.title]))),
  );
}

async function catalogPage(req: SegReq): Promise<void> {
  const { app, response, session, segment } = req;
  const [ctx, catalog] = await Promise.all([
    ctxFor(req, 'catalog'),
    app.api.catalog(session, segment.id),
  ]);
  return catalog.ok
    ? render(
        response,
        200,
        'Catalog',
        CatalogPage({ ctx, templates: catalog.value.templates, skills: catalog.value.skills }),
      )
    : failPage(response, ctx, catalog);
}

async function skillPage(req: SegReq): Promise<void> {
  const { app, response, session, segment, m } = req;
  const [ctx, versions, team] = await Promise.all([
    ctxFor(req, 'catalog'),
    app.api.skillVersions(session, segment.id, m[1]),
    app.api.teammates(session, segment.id),
  ]);
  if (!versions.ok) return failPage(response, ctx, versions);
  return render(
    response,
    200,
    'Skill',
    SkillPage({
      ctx,
      versions: versions.value.versions,
      teammates: team.ok ? team.value.teammates : [],
    }),
  );
}

async function connectionsPage(req: SegReq): Promise<void> {
  const { app, response, session, segment } = req;
  const [ctx, list] = await Promise.all([
    ctxFor(req, 'connections'),
    app.api.connections(session, segment.id),
  ]);
  return list.ok
    ? render(
        response,
        200,
        'Connections',
        ConnectionsPage({ ctx, connections: list.value.connections }),
      )
    : failPage(response, ctx, list);
}

async function fixtureDocPage(req: SegReq): Promise<void> {
  const { app, response, session, segment, m } = req;
  const [ctx, doc] = await Promise.all([
    ctxFor(req, 'tasks'),
    app.api.fixtureDoc(session, segment.id, m[1]),
  ]);
  return doc.ok
    ? render(response, 200, doc.value.title, DocumentPage({ ctx, doc: doc.value }))
    : failPage(response, ctx, doc);
}

/** Older pinned versions of synthesis skills still count; versions only add sections. */
function synthesisSkills(
  skills: readonly SkillView[],
  teammates: readonly TeammateView[],
): Map<string, readonly Workflow[]> {
  const synthesis = new Map<string, readonly Workflow[]>();
  for (const skill of skills)
    if (skill.definition.outputSections.length > 1)
      synthesis.set(`${skill.id}:${skill.version}`, skill.definition.workflows);
  for (const teammate of teammates)
    for (const skill of teammate.skills) {
      const latest = skills.find((s) => s.id === skill.id);
      if (latest !== undefined && latest.definition.outputSections.length > 1)
        synthesis.set(`${skill.id}:${skill.version}`, latest.definition.workflows);
    }
  return synthesis;
}

type NewTaskInput = {
  readonly ctx: PageCtx;
  readonly values: NewTaskValues;
  readonly error: string | undefined;
  readonly status: number;
};

async function newTaskPage(
  { app, response, session, segment }: Pick<SegReq, 'app' | 'response' | 'session' | 'segment'>,
  input: NewTaskInput,
): Promise<void> {
  const { ctx, values, error, status } = input;
  const [team, catalog] = await Promise.all([
    app.api.teammates(session, segment.id),
    app.api.catalog(session, segment.id),
  ]);
  const teammates = team.ok ? team.value.teammates : [];
  const synthesis = synthesisSkills(catalog.ok ? catalog.value.skills : [], teammates);
  const owner = typeof values.owner === 'string' ? values.owner : undefined;
  render(
    response,
    status,
    'New task',
    NewTaskPage({
      ctx,
      teammates,
      synthesis,
      values: owner === undefined ? values : { ...values, resultOwner: owner },
      error,
      defaults: {
        repository: ctx.readiness?.sources.repositories.at(0) ?? null,
        issue: ctx.readiness?.sources.issue ?? null,
      },
    }),
  );
}

const GET_ROUTES: readonly Route<SegReq>[] = [
  { pattern: /^\/(?:inbox)?$/, handle: inboxPage },
  { pattern: /^\/teammates$/, handle: teammatesPage },
  { pattern: new RegExp(`^/teammates/(${uuid})$`), handle: teammatePage },
  { pattern: new RegExp(`^/teammates/(${uuid})/export$`), handle: exportPage },
  { pattern: new RegExp(`^/teammates/(${uuid})/export\\.json$`), handle: exportJson },
  {
    pattern: /^\/import$/,
    handle: async (req) =>
      render(req.response, 200, 'Import', ImportPage({ ctx: await ctxFor(req, 'teammates') })),
  },
  { pattern: /^\/tasks$/, handle: tasksPage },
  {
    pattern: /^\/tasks\/new$/,
    handle: async (req) =>
      newTaskPage(req, {
        ctx: await ctxFor(req, 'tasks'),
        values: Object.fromEntries(req.url.searchParams),
        error: undefined,
        status: 200,
      }),
  },
  { pattern: new RegExp(`^/tasks/(${uuid})/version$`), handle: taskVersion },
  { pattern: new RegExp(`^/tasks/(${uuid})$`), handle: taskPage },
  { pattern: new RegExp(`^/tasks/(${uuid})/compare$`), handle: comparePage },
  { pattern: new RegExp(`^/tasks/(${uuid})/revisions/(\\d{1,4})\\.md$`), handle: revisionMarkdown },
  { pattern: /^\/catalog$/, handle: catalogPage },
  { pattern: new RegExp(`^/catalog/skills/(${uuid})$`), handle: skillPage },
  { pattern: /^\/connections$/, handle: connectionsPage },
  { pattern: /^\/fixture-docs\/(fxdoc-[a-f0-9]{16})$/, handle: fixtureDocPage },
];

async function createTeammate({ app, response, session, segment, form }: PostReq): Promise<void> {
  const result = await app.api.createTeammate(session, segment.id, {
    templateId: form.get('templateId'),
    clientRequestId: form.get('clientRequestId'),
    ...(form.get('name') ? { name: form.get('name') } : {}),
  });
  return result.ok
    ? redirect(
        response,
        segPath(segment, `/teammates/${result.value.teammate.id}?notice=teammate_created`),
      )
    : back({ response, segment }, '/catalog', result, '');
}

async function updateTeammate(req: PostReq): Promise<void> {
  const { app, session, segment, form, m } = req;
  const body = {
    expectedVersion: Number(form.get('expectedVersion')),
    name: form.get('name') ?? '',
    role: form.get('role') ?? '',
    instructions: form.get('instructions') ?? '',
  };
  return back(
    req,
    `/teammates/${m[1]}`,
    await app.api.updateTeammate(session, segment.id, m[1], body),
    'teammate_saved',
  );
}

async function setSkill(req: PostReq): Promise<void> {
  const { app, session, segment, form, m } = req;
  const [skillId, version] = (
    form.get('skillRef') ?? `${form.get('skillId') ?? ''}:${form.get('version') ?? ''}`
  ).split(':');
  return back(
    req,
    `/teammates/${m[1]}`,
    await app.api.setSkill(session, segment.id, m[1], {
      skillId,
      version: Number(version),
      attach: form.get('attach') === '1',
    }),
    'skill_saved',
  );
}

async function postMessage(req: PostReq): Promise<void> {
  const { app, session, segment, form, m } = req;
  const found = await app.api.teammate(session, segment.id, m[1]);
  if (!found.ok) return back(req, `/teammates/${m[1]}`, found, '');
  return back(
    req,
    `/teammates/${m[1]}`,
    await app.api.postMessage(session, segment.id, found.value.conversation.id, {
      clientRequestId: form.get('clientRequestId'),
      text: form.get('text') ?? '',
    }),
    'message_sent',
  );
}

async function importTeammate(req: PostReq): Promise<void> {
  const { app, response, session, segment, form } = req;
  const result = await app.api.importTeammate(session, segment.id, {
    clientRequestId: form.get('clientRequestId'),
    definition: form.get('definition') ?? '',
  });
  const ctx = await ctxFor(req, 'teammates');
  if (!result.ok)
    return render(
      response,
      400,
      'Import',
      ImportPage({
        ctx: { ...ctx, notice: { tone: 'danger', text: errorText(result.error) } },
        draft: form.get('definition') ?? '',
      }),
    );
  return render(response, 201, 'Import', ImportPage({ ctx, result: result.value }));
}

async function customizeSkill(req: PostReq): Promise<void> {
  const { app, response, session, segment, form, m } = req;
  const versions = await app.api.skillVersions(session, segment.id, m[1]);
  if (!versions.ok) return back(req, '/catalog', versions, '');
  const base =
    versions.value.versions.find((v) => v.version === Number(form.get('fromVersion'))) ??
    versions.value.versions.at(-1);
  if (base === undefined)
    return back(req, '/catalog', { ok: false, status: 404, error: 'not_found' }, '');
  const result = await app.api.customizeSkill(session, segment.id, {
    fromSkillId: base.id,
    fromVersion: base.version,
    definition: {
      ...base.definition,
      name: form.get('name') ?? base.definition.name,
      summary: form.get('summary') ?? base.definition.summary,
      steps: lines(form.get('steps')),
      validation: lines(form.get('validation')),
      missingData: form.get('missingData') ?? base.definition.missingData,
    },
  });
  return result.ok
    ? redirect(
        response,
        segPath(segment, `/catalog/skills/${result.value.skill.id}?notice=skill_customized`),
      )
    : back(req, `/catalog/skills/${m[1]}`, result, '');
}

async function attachSkill(req: PostReq): Promise<void> {
  const { app, session, segment, form, m } = req;
  const target = `/catalog/skills/${m[1]}`;
  const team = await app.api.teammates(session, segment.id);
  if (!team.ok) return back(req, target, team, '');
  const wanted = new Set(form.getAll('teammate'));
  const version = Number(form.get('version'));
  for (const teammate of team.value.teammates) {
    const has = teammate.skills.some((s) => s.id === m[1] && s.version === version);
    const want = wanted.has(teammate.id);
    if (has === want) continue;
    const result = await app.api.setSkill(session, segment.id, teammate.id, {
      skillId: m[1],
      version,
      attach: want,
    });
    if (!result.ok) return back(req, target, result, '');
  }
  return back(req, target, { ok: true, value: null }, 'attachments_saved');
}

async function connectStart(req: PostReq): Promise<void> {
  const { app, response, session, segment, m } = req;
  const result = await app.api.connectStart(session, segment.id, m[1]);
  return result.ok ? redirect(response, result.value.url) : back(req, '/connections', result, '');
}

function manualAssignments(form: URLSearchParams): readonly {
  readonly teammateId: string;
  readonly brief: string;
  readonly sources: readonly string[];
}[] {
  return [0, 1, 2]
    .map((index) => ({
      teammateId: form.get(`a${index}.teammate`) ?? '',
      brief: (form.get(`a${index}.brief`) ?? '').trim(),
      sources: form.getAll(`a${index}.sources`),
    }))
    .filter((a) => a.teammateId !== '' && a.brief !== '' && a.sources.length > 0);
}

function taskScope(form: URLSearchParams, workflow: Workflow) {
  const issue = Number(form.get('issueNumber'));
  return {
    question: form.get('question') ?? '',
    metrics:
      workflow === 'metrics_explanation'
        ? {
            baseline: form.get('baseline'),
            current: form.get('current'),
            groupBy: form.get('groupBy') ?? 'region',
          }
        : null,
    repository: workflow === 'engineering_proposal' ? (form.get('repository') ?? null) : null,
    issueNumber:
      workflow === 'engineering_proposal' && Number.isInteger(issue) && issue > 0 ? issue : null,
  };
}

async function createTask(req: PostReq): Promise<void> {
  const { app, response, session, segment, form } = req;
  const workflow = form.get('workflow') as Workflow;
  const mode = form.get('mode') === 'coordinated' ? 'coordinated' : 'manual';
  const body = {
    clientRequestId: form.get('clientRequestId') ?? randomUUID(),
    workflow,
    mode,
    scope: taskScope(form, workflow),
    resultOwner: form.get('resultOwner') ?? '',
    conversationId: form.get('conversationId') || null,
    assignments: mode === 'manual' ? manualAssignments(form) : [],
  };
  const result = await app.api.createTask(session, segment.id, body);
  if (result.ok)
    return redirect(
      response,
      segPath(segment, `/tasks/${result.value.task.id}?notice=task_started`),
    );
  const ctx = await ctxFor(req, 'tasks');
  return newTaskPage(req, {
    ctx,
    values: formValues(form),
    error: errorText(result.error),
    status: result.status === 404 ? 404 : 400,
  });
}

/** What a task command posts to the segment API, or the failure to show instead. */
type Command =
  | { readonly kind: 'run'; readonly body: unknown; readonly notice: string }
  | { readonly kind: 'fail'; readonly result: ApiResult<unknown> };

const run = (body: unknown, notice: string): Command => ({ kind: 'run', body, notice });

async function planEdit(
  form: URLSearchParams,
  { app, session, segment, m }: PostReq,
): Promise<Command> {
  const task = await app.api.task(session, segment.id, m[1]);
  if (!task.ok) return { kind: 'fail', result: task };
  const plan = task.value.plans.find((p) => p.version === Number(form.get('baseVersion')));
  if (plan === undefined)
    return { kind: 'fail', result: { ok: false, status: 409, error: 'stale_plan' } };
  const assignments = plan.content.assignments
    .map((a, index) => ({
      key: a.key,
      teammateId: form.get(`p${index}.teammate`) ?? a.teammateId,
      brief: (form.get(`p${index}.brief`) ?? a.brief).trim() || a.brief,
      deliverable: a.deliverable,
      sources: form.getAll(`p${index}.sources`),
      dependsOn: a.dependsOn,
      remove: form.get(`p${index}.remove`) === '1',
    }))
    .filter((a) => !a.remove && a.sources.length > 0)
    .map(({ remove: _remove, ...rest }) => rest);
  const keys = new Set(assignments.map((a) => a.key));
  return run(
    {
      baseVersion: plan.version,
      content: {
        ...plan.content,
        assignments: assignments.map((a) => ({
          ...a,
          dependsOn: a.dependsOn.filter((k) => keys.has(k)),
        })),
      },
    },
    'plan_edited',
  );
}

const FOLLOW_UP_NOTICES: ReadonlyMap<string, string> = new Map([
  ['revise', 'revision_requested'],
  ['answer', 'answered'],
  ['question', 'asked'],
  ['rescope', 'rescoped'],
]);

function followUp(form: URLSearchParams): Command {
  const kind = form.get('kind') ?? 'question';
  const metrics =
    kind === 'rescope'
      ? {
          baseline: form.get('baseline'),
          current: form.get('current'),
          groupBy: form.get('groupBy'),
        }
      : null;
  return run(
    {
      clientRequestId: form.get('clientRequestId'),
      kind,
      text: form.get('text') ?? '',
      assignmentId: form.get('assignmentId') || null,
      metrics,
    },
    FOLLOW_UP_NOTICES.get(kind) ?? 'asked',
  );
}

type CommandBuilder = (form: URLSearchParams, req: PostReq) => Command | Promise<Command>;

const TASK_COMMANDS: ReadonlyMap<string, CommandBuilder> = new Map<string, CommandBuilder>([
  [
    'plan/decision',
    (form) => {
      const decision = form.get('decision');
      return run(
        {
          version: Number(form.get('version')),
          expectedDigest: form.get('expectedDigest'),
          decision,
        },
        decision === 'approve' ? 'plan_approved' : 'plan_rejected',
      );
    },
  ],
  ['plan/edit', planEdit],
  ['plan/replan', (form) => run({ feedback: form.get('feedback') ?? '' }, 'replan')],
  ['follow-up', followUp],
  [
    'missing',
    (form) => {
      const decision = form.get('decision') === 'proceed' ? 'proceed' : 'retry';
      return run(
        { decision, assignmentIds: form.getAll('assignmentId') },
        decision === 'retry' ? 'retrying' : 'proceeding',
      );
    },
  ],
  ['publish', (form) => run({ revision: Number(form.get('revision')) }, '')],
  ['cancel', () => run({}, 'cancelled')],
  ['retry', () => run({}, 'retrying')],
  ['reconcile', () => run({}, 'reconciled')],
  [
    'action',
    (form) => {
      const decision = form.get('decision') === 'approve' ? 'approve' : 'reject';
      return run(
        {
          approvalId: form.get('approvalId'),
          expectedDigest: form.get('expectedDigest'),
          decision,
        },
        decision === 'approve' ? 'publish_approved' : 'publish_rejected',
      );
    },
  ],
]);

async function taskCommand(req: PostReq): Promise<void> {
  const { app, session, segment, form, m } = req;
  const [, id, command] = m;
  const target = `/tasks/${id}`;
  const build = TASK_COMMANDS.get(command);
  if (build === undefined)
    return failPage(req.response, undefined, { status: 404, error: 'not_found' });
  const built = await build(form, req);
  if (built.kind === 'fail') return back(req, target, built.result, '');
  const result = await app.api.command(session, segment.id, id, command, built.body);
  return back(req, target, result, built.notice);
}

const POST_ROUTES: readonly Route<PostReq>[] = [
  { pattern: /^\/teammates$/, handle: createTeammate },
  {
    pattern: /^\/teammates\/starter$/,
    handle: async (req) =>
      back(
        req,
        '/teammates',
        await req.app.api.starterTeam(req.session, req.segment.id),
        'starter_created',
      ),
  },
  { pattern: new RegExp(`^/teammates/(${uuid})$`), handle: updateTeammate },
  { pattern: new RegExp(`^/teammates/(${uuid})/skills$`), handle: setSkill },
  { pattern: new RegExp(`^/teammates/(${uuid})/messages$`), handle: postMessage },
  { pattern: /^\/import$/, handle: importTeammate },
  { pattern: /^\/tasks$/, handle: createTask },
  { pattern: new RegExp(`^/catalog/skills/(${uuid})/customize$`), handle: customizeSkill },
  { pattern: new RegExp(`^/catalog/skills/(${uuid})/attach$`), handle: attachSkill },
  { pattern: /^\/connections\/(google|github)\/start$/, handle: connectStart },
  {
    pattern: /^\/connections\/(google|github)\/disconnect$/,
    handle: async (req) =>
      back(
        req,
        '/connections',
        await req.app.api.disconnect(req.session, req.segment.id, req.m[1]),
        'disconnected',
      ),
  },
  {
    pattern: new RegExp(`^/inbox/(${uuid})/dismiss$`),
    handle: async (req) =>
      back(
        req,
        '/inbox',
        await req.app.api.dismiss(req.session, req.segment.id, req.m[1]),
        'dismissed',
      ),
  },
  {
    // eslint-disable-next-line security/detect-non-literal-regexp
    pattern: new RegExp(`^/tasks/(${uuid})/(${[...TASK_COMMANDS.keys()].join('|')})$`),
    handle: taskCommand,
  },
];

async function connectComplete(
  { app, response, url, session }: Signed,
  provider: string,
): Promise<void> {
  const state = url.searchParams.get('state') ?? '';
  // The state names its segment; the segment API checks it was issued to this same member.
  const segmentId = /^([a-z][a-z0-9-]{1,30})\./.exec(state)?.[1] ?? '';
  const segment = app.api.segmentFor(session, segmentId);
  if (segment === undefined)
    return failPage(response, undefined, { status: 404, error: 'segment_not_found' });
  const code = url.searchParams.get('code');
  if (code === null)
    return redirect(response, segPath(segment, `/connections?error=oauth_exchange_failed`));
  const result = await app.api.connectComplete(session, segment.id, provider, { code, state });
  return redirect(
    response,
    segPath(
      segment,
      result.ok ? '/connections?notice=connected' : `/connections?error=${result.error}`,
    ),
  );
}

async function get(req: Signed): Promise<void> {
  const { app, response, url, session } = req;
  const callback = /^\/connections\/(google|github)\/callback$/.exec(url.pathname);
  if (callback !== null) return connectComplete(req, callback[1]);
  const seg = splitSegment(url.pathname);
  if (seg === undefined) return failPage(response, undefined, { status: 404, error: 'not_found' });
  const segment = app.api.segmentFor(session, seg.id);
  if (segment === undefined)
    return failPage(response, undefined, { status: 404, error: 'segment_not_found' });
  const base = { app, response, url, session, segment };
  const hit = match(GET_ROUTES, seg.sub === '' ? '/inbox' : seg.sub);
  if (hit === undefined)
    return failPage(response, await ctxFor(base, 'none'), { status: 404, error: 'not_found' });
  return hit.route.handle({ ...base, m: hit.m });
}

async function post(req: Signed): Promise<void> {
  const { app, request, response, url, jar, session } = req;
  const form = await readForm(request);
  if (form === undefined) return json(response, 413, { error: 'too_large' });
  if (!same(form.get('csrf'), session.csrf) || !originOk(app, request))
    return render(
      response,
      403,
      'Forbidden',
      ErrorPage({ ctx: undefined, title: 'Request blocked', code: 'csrf' }),
    );
  if (url.pathname === '/auth/sign-out') {
    await app.identity.signOut(jar.get(SESSION_COOKIE));
    return redirect(response, '/sign-in', { 'set-cookie': sessionCookie('', 0) });
  }
  const seg = splitSegment(url.pathname);
  const segment = seg === undefined ? undefined : app.api.segmentFor(session, seg.id);
  if (seg === undefined || seg.sub === '' || segment === undefined)
    return failPage(response, undefined, { status: 404, error: 'segment_not_found' });
  const hit = match(POST_ROUTES, seg.sub);
  if (hit === undefined) return failPage(response, undefined, { status: 404, error: 'not_found' });
  return hit.route.handle({ app, response, url, session, segment, form, m: hit.m });
}

async function handle(app: App, request: IncomingMessage, response: ServerResponse): Promise<void> {
  const url = new URL(request.url ?? '/', 'http://localhost');
  const method = request.method ?? 'GET';
  const found = method === 'GET' ? app.assets.get(url.pathname) : undefined;
  if (found !== undefined) return serveAsset(request, response, found);
  const jar = cookies(request);
  const session = await app.identity.session(jar.get(SESSION_COOKIE));
  const req: Req = { app, request, response, url, jar, session };
  const open = PUBLIC_ROUTES.find(
    (route) => route.method === method && route.path === url.pathname,
  );
  if (open !== undefined) return open.handle(req);
  if (session === undefined) {
    if (method === 'GET' && url.pathname.endsWith('/version'))
      return json(response, 401, { error: 'unauthenticated' });
    return redirect(response, '/sign-in');
  }
  const signed: Signed = { ...req, session };
  return method === 'POST' ? post(signed) : get(signed);
}

export function createM1Handler(deps: HandlerDeps): RequestListener {
  const app: App = {
    ...deps,
    assets: new Map([
      ['/assets/m1.css', asset(m1Styles, 'text/css; charset=utf-8')],
      ['/assets/m1.js', asset(loadScript(), 'text/javascript; charset=utf-8')],
    ]),
    origins: new Set([
      deps.config.publicUrl,
      deps.config.publicUrl.replace('localhost', '127.0.0.1'),
      'http://web:8080',
    ]),
  };
  return (request, response) => {
    void handle(app, request, response).catch((error: unknown) => {
      console.error(
        JSON.stringify({
          level: 'error',
          component: 'm1-web',
          error: error instanceof Error ? error.name : 'unknown',
        }),
      );
      if (!response.headersSent)
        render(
          response,
          500,
          'Error',
          ErrorPage({ ctx: undefined, title: 'Something went wrong', code: 'unavailable' }),
        );
      else response.end();
    });
  };
}
