import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';

import { IAP_ASSERTION_HEADER } from '@agent-works/domain';
import { workbenchCreateSchema, workbenchDecisionSchema } from '@agent-works/domain/workbench';

import { readAdminForm } from '../admin/form.js';
import { h } from '../html.js';
import { headerValue } from '../web-app.js';

import { createWorkbenchApi } from './api.js';
import { csrfCookie, csrfToken, csrfValid, trustedOrigins } from './csrf.js';
import { styles } from './styles.js';
import { TaskLive, TaskPage, reportMarkdown } from './task-views.js';
import {
  ApprovalsPage,
  ConnectionsPage,
  DocumentPage,
  ErrorPage,
  FLAGSHIP_PROMPT,
  HomePage,
  Shell,
  SourcePage,
  TasksPage,
  liveStatuses,
  statusLabel,
} from './views.js';

import type { ApiResult, WorkbenchApi } from './api.js';
import type { NavKey } from './views.js';
import type { Html } from '../html.js';
import type {
  WorkbenchReadiness,
  WorkbenchTaskDetail,
  WorkbenchTaskSummary,
} from '@agent-works/domain/workbench';
import type { IncomingMessage, RequestListener, ServerResponse } from 'node:http';

export type WorkbenchWebOptions = {
  readonly apiUrl: string;
  readonly fetch?: typeof fetch;
  readonly env?: Readonly<Record<string, string | undefined>>;
};

const html = 'text/html; charset=utf-8';
const uuid = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const taskPath = new RegExp(`^/tasks/(${uuid})$`);
const taskReport = new RegExp(`^/tasks/(${uuid})/report\\.md$`);
const taskCommand = new RegExp(`^/tasks/(${uuid})/(cancel|retry|reconcile|approval)$`);
const sourcePath = /^\/fixtures\/drive\/([a-z0-9-]{1,80})$/;
const docPath = /^\/fixtures\/docs\/(fxdoc-[a-f0-9]{16})$/;
/** Pages whose body shows the task list; every other page needs readiness only. */
const listPaths = new Set(['/', '/tasks', '/approvals']);

const securityHeaders = {
  'content-security-policy':
    "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; form-action 'self'; base-uri 'none'; object-src 'none'",
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'same-origin',
  'x-frame-options': 'DENY',
};

const errorText: Record<string, string> = {
  stale_digest:
    'The proposal changed since you loaded it. Review the current version and decide again.',
  already_decided: 'This approval was already decided. The recorded decision stands.',
  not_awaiting_approval: 'This task is no longer waiting for approval.',
  approval_expired: 'The approval expired. Retry the task to get a fresh proposal.',
  csrf: 'Your session token did not match. Reload the page and try again.',
  invalid_request: 'That request was not valid.',
  unavailable: 'The workbench API is unavailable. Try again shortly.',
  approval_tampered: 'The stored proposal failed its integrity check. Nothing was written.',
  no_approval: 'This task has no proposal to decide.',
  client_request_reused:
    'That form was already submitted with different text. Your text is kept below; start it as a new task.',
  bad_contract:
    'The workbench API returned an unexpected response. Reload to see the current state.',
};

/** cannot_<verb>_<status> conflicts share one sentence shape. */
export function noticeText(code: string): string {
  // eslint-disable-next-line security/detect-object-injection
  if (Object.hasOwn(errorText, code)) return errorText[code];
  const blocked = /^cannot_(cancel|retry|reconcile)_([a-z_]+)$/.exec(code);
  if (blocked === null) return 'That request was not valid.';
  const status = (blocked.at(2) ?? '').replaceAll('_', ' ');
  return `This task cannot ${blocked.at(1) ?? ''} while it is ${status}. The page shows its current state.`;
}

/** Paths owned by the workbench when WEB_WORKBENCH=1; everything else falls through. */
export function isWorkbenchPath(path: string): boolean {
  return (
    listPaths.has(path) ||
    path.startsWith('/tasks/') ||
    path === '/connections' ||
    path.startsWith('/fixtures/') ||
    path.startsWith('/assets/')
  );
}

export function createWorkbenchHandler(options: WorkbenchWebOptions): RequestListener {
  const api = createWorkbenchApi(options.apiUrl, options.fetch);
  const origins = trustedOrigins(options.env ?? process.env);
  const assets = new Map<string, Asset>([
    ['/assets/app.css', asset(styles, 'text/css; charset=utf-8')],
    ['/assets/workbench.js', asset(loadScript(), 'text/javascript; charset=utf-8')],
  ]);
  return (request, response) => {
    void handle({ api, origins, assets }, request, response).catch(() => {
      if (!response.headersSent) {
        response.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
        response.end('error');
      }
    });
  };
}

function loadScript(): string {
  // Static path inside this package's build output, never request controlled.
  const url = new URL('../../client/workbench.js', import.meta.url);
  try {
    // eslint-disable-next-line security/detect-non-literal-fs-filename
    return readFileSync(url, 'utf8');
  } catch (error) {
    throw new Error(
      `workbench client script missing at ${url.pathname}; build apps/web (tsc -p client) first`,
      { cause: error },
    );
  }
}

type Asset = { readonly body: string; readonly type: string; readonly etag: string };

function asset(body: string, type: string): Asset {
  return { body, type, etag: `"${createHash('sha256').update(body).digest('hex')}"` };
}

type Context = {
  readonly api: WorkbenchApi;
  readonly origins: readonly string[];
  readonly assets: ReadonlyMap<string, Asset>;
};

/** Everything one request carries through the handler. */
type Exchange = Context & {
  readonly response: ServerResponse;
  readonly assertion: string | undefined;
  readonly csrf: string;
  readonly url: URL;
};

/** Data every shell page shows in its chrome. */
type Frame = {
  readonly ready: WorkbenchReadiness | undefined;
  readonly list: readonly WorkbenchTaskSummary[];
  readonly signedOut: boolean;
};

type PageView = {
  readonly title: string;
  readonly active: NavKey;
  readonly body: Html;
  readonly status?: number;
};

async function handle(
  ctx: Context,
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  const url = new URL(request.url ?? '/', 'http://localhost');
  const method = request.method ?? 'GET';
  const found = method === 'GET' ? ctx.assets.get(url.pathname) : undefined;
  if (found !== undefined) return sendAsset(request, response, found);
  const req: Exchange = {
    ...ctx,
    response,
    assertion: headerValue(request, IAP_ASSERTION_HEADER),
    csrf: csrfToken(request),
    url,
  };
  if (method === 'POST') return handlePost(req, request);
  if (method !== 'GET') return send(response, 405, 'method not allowed');
  return handleGet(req);
}

async function handlePost(req: Exchange, request: IncomingMessage): Promise<void> {
  const form = await readAdminForm(request);
  if (form === undefined) return send(req.response, 413, 'too large');
  if (!csrfValid(request, form, req.origins)) return forbidden(req.response, req.csrf);
  const path = req.url.pathname;
  if (path === '/tasks') return createTask(req, form);
  const command = taskCommand.exec(path);
  if (command !== null) return runCommand(req, command[1], command[2], form);
  return send(req.response, 404, 'not found');
}

async function handleGet(req: Exchange): Promise<void> {
  const path = req.url.pathname;
  const task = taskPath.exec(path)?.at(1);
  if (task !== undefined) return taskPage(req, task);
  const report = taskReport.exec(path)?.at(1);
  if (report !== undefined) return reportDownload(req, report);
  const frame = await frameFor(req);
  if (frame.signedOut) return send(req.response, 401, 'sign in required');
  renderShell(req, frame, await shellPage(req, frame));
}

/** Readiness and, only on pages that list tasks, the task list, fetched together. */
async function frameFor(req: Exchange): Promise<Frame> {
  const [readiness, tasks] = await Promise.all([
    req.api.readiness(req.assertion),
    listPaths.has(req.url.pathname) ? req.api.list(req.assertion) : undefined,
  ]);
  return {
    ready: readiness.ok ? readiness.value : undefined,
    list: tasks?.ok === true ? tasks.value : [],
    signedOut: !readiness.ok && readiness.status === 401,
  };
}

async function shellPage(req: Exchange, frame: Frame): Promise<PageView> {
  const path = req.url.pathname;
  if (path === '/') return homeView(req, frame);
  if (path === '/tasks') return { title: 'Tasks', active: 'tasks', body: TasksPage(frame.list) };
  if (path === '/approvals')
    return { title: 'Approvals', active: 'approvals', body: ApprovalsPage(frame.list) };
  if (path === '/connections')
    return { title: 'Connections', active: 'connections', body: ConnectionsPage(frame.ready) };
  const source = sourcePath.exec(path)?.at(1);
  if (source !== undefined)
    return fixtureView(
      await req.api.source(req.assertion, source),
      SourcePage,
      'Source not available',
    );
  const doc = docPath.exec(path)?.at(1);
  if (doc !== undefined)
    return fixtureView(
      await req.api.document(req.assertion, doc),
      DocumentPage,
      'Document not available',
    );
  return missingView('Page not found', 'Check the address or go back to your tasks.');
}

function homeView(req: Exchange, frame: Frame, draft?: string, error?: string): PageView {
  return {
    title: 'New task',
    active: 'home',
    body: HomePage({
      csrf: req.csrf,
      clientRequestId: randomUUID(),
      readiness: frame.ready,
      recent: frame.list,
      draft: draft ?? (req.url.searchParams.get('prompt') === 'flagship' ? FLAGSHIP_PROMPT : ''),
      error,
    }),
  };
}

function fixtureView<T extends { readonly title: string }>(
  found: ApiResult<T>,
  view: (value: T) => Html,
  missingTitle: string,
): PageView {
  return found.ok
    ? { title: found.value.title, active: 'none', body: view(found.value) }
    : missingView(missingTitle, 'This document does not exist or you cannot read it.');
}

function missingView(title: string, text: string): PageView {
  return { title: 'Not found', active: 'none', body: ErrorPage(title, text), status: 404 };
}

function renderShell(req: Exchange, frame: Frame, view: PageView): void {
  render(
    req,
    view.status ?? 200,
    view.title,
    Shell({
      title: view.title,
      active: view.active,
      readiness: frame.ready,
      pendingApprovals: frame.ready?.pendingApprovals ?? 0,
      body: view.body,
    }),
  );
}

async function reportDownload(req: Exchange, id: string): Promise<void> {
  const detail = await req.api.detail(req.assertion, id);
  if (!detail.ok || detail.value.artifact === null) return send(req.response, 404, 'not found');
  req.response.writeHead(200, {
    ...securityHeaders,
    'content-type': 'text/markdown; charset=utf-8',
    'content-disposition': `attachment; filename="report-${id.slice(0, 8)}.md"`,
  });
  req.response.end(reportMarkdown(detail.value));
}

async function taskPage(req: Exchange, id: string): Promise<void> {
  if (req.url.searchParams.get('fragment') === '1')
    return taskFragment(req, await req.api.detail(req.assertion, id));
  const [detail, frame] = await Promise.all([req.api.detail(req.assertion, id), frameFor(req)]);
  renderShell(req, frame, taskView(req, detail));
}

function taskView(req: Exchange, detail: ApiResult<WorkbenchTaskDetail>): PageView {
  if (!detail.ok) {
    const missing = detail.status === 404;
    return {
      title: 'Task not found',
      active: 'tasks',
      status: missing ? 404 : 503,
      body: missing
        ? ErrorPage('Task not found', 'This task does not exist, or it belongs to someone else.')
        : ErrorPage('Task unavailable', 'The workbench API did not respond. Reload to try again.'),
    };
  }
  const noticeCode = req.url.searchParams.get('notice');
  const notice = noticeCode === null ? undefined : noticeText(noticeCode);
  return {
    title: detail.value.task.title,
    active: 'tasks',
    body: TaskPage(detail.value, req.csrf, notice),
  };
}

function taskFragment(req: Exchange, detail: ApiResult<WorkbenchTaskDetail>): void {
  if (!detail.ok) return send(req.response, detail.status === 404 ? 404 : 502, 'unavailable');
  const { task } = detail.value;
  req.response.writeHead(200, {
    ...securityHeaders,
    'content-type': html,
    'cache-control': 'no-store',
    'x-task-version': String(task.version),
    'x-task-status': task.status,
    'x-task-status-label': statusLabel(task.status),
    'x-task-live': liveStatuses.includes(task.status) ? 'true' : 'false',
  });
  req.response.end(TaskLive(detail.value, req.csrf).html);
}

async function createTask(req: Exchange, form: URLSearchParams): Promise<void> {
  const input = workbenchCreateSchema.safeParse({
    objective: form.get('objective') ?? '',
    clientRequestId: form.get('clientRequestId') ?? '',
  });
  if (!input.success)
    return composerError(req, form, 400, 'Enter an objective between 1 and 4,000 characters.');
  const created = await req.api.create(req.assertion, input.data);
  if (!created.ok) {
    // Keep the user's text on every failure; nothing about a failed create is worth losing it.
    const status = created.status === 409 ? 409 : 503;
    return composerError(
      req,
      form,
      status,
      noticeText(created.error === 'client_request_reused' ? created.error : 'unavailable'),
    );
  }
  redirect(req.response, `/tasks/${created.value.id}`);
}

async function composerError(
  req: Exchange,
  form: URLSearchParams,
  status: number,
  error: string,
): Promise<void> {
  const frame = await frameFor(req);
  const draft = (form.get('objective') ?? '').slice(0, 4000);
  renderShell(req, frame, { ...homeView(req, frame, draft, error), status });
}

async function runCommand(
  req: Exchange,
  id: string,
  command: string,
  form: URLSearchParams,
): Promise<void> {
  let result: ApiResult<unknown>;
  if (command === 'approval') {
    const decision = workbenchDecisionSchema.safeParse({
      decision: form.get('decision'),
      expectedPayloadSha256: form.get('expectedPayloadSha256'),
    });
    if (!decision.success) return redirect(req.response, `/tasks/${id}?notice=invalid_request`);
    result = await req.api.decide(req.assertion, id, decision.data);
  } else {
    result = await req.api.command(req.assertion, id, command as 'cancel' | 'retry' | 'reconcile');
  }
  if (result.ok)
    return redirect(req.response, `/tasks/${id}${command === 'approval' ? '#approval' : ''}`);
  if (result.status === 404) return redirect(req.response, `/tasks/${id}`);
  redirect(req.response, `/tasks/${id}?notice=${encodeURIComponent(result.error)}`);
}

function forbidden(response: ServerResponse, csrf: string): void {
  response.writeHead(403, {
    ...securityHeaders,
    'content-type': html,
    'set-cookie': csrfCookie(csrf),
  });
  response.end(
    document(
      'Request blocked',
      ErrorPage(
        'Request blocked',
        'The security token or origin did not match. Reload the page and try again.',
      ),
    ),
  );
}

function render(req: Exchange, status: number, title: string, body: Html): void {
  req.response.writeHead(status, {
    ...securityHeaders,
    'content-type': html,
    'cache-control': 'no-store',
    'set-cookie': csrfCookie(req.csrf),
  });
  req.response.end(document(title, body));
}

function document(title: string, body: Html): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="color-scheme" content="light dark">${h('title', null, `${title} · Agent Works`).html}<link rel="stylesheet" href="/assets/app.css"><script src="/assets/workbench.js" defer></script></head><body>${body.html}</body></html>`;
}

function sendAsset(request: IncomingMessage, response: ServerResponse, found: Asset): void {
  const headers = {
    etag: found.etag,
    'cache-control': 'no-cache',
    'x-content-type-options': 'nosniff',
  };
  if (headerValue(request, 'if-none-match') === found.etag) {
    response.writeHead(304, headers);
    response.end();
    return;
  }
  response.writeHead(200, { ...headers, 'content-type': found.type });
  response.end(found.body);
}

function redirect(response: ServerResponse, location: string): void {
  response.writeHead(303, { location, 'cache-control': 'no-store' });
  response.end();
}

function send(response: ServerResponse, status: number, body: string): void {
  response.writeHead(status, { ...securityHeaders, 'content-type': 'text/plain; charset=utf-8' });
  response.end(body);
}
