import { randomBytes } from 'node:crypto';

import { approvalSchema } from '@agent-works/domain';

import { renderDocument } from '../html.js';

import { workspacePage } from './workspace-page.js';

import type { WorkspacePageView } from './workspace-page.js';
import type { IncomingMessage, RequestListener, ServerResponse } from 'node:http';
export type WorkspaceHandlerOptions = {
  readonly apiUrl: string;
  readonly fetch?: typeof fetch;
  readonly now?: () => Date;
};
const csrfCookie = 'workspace-approval-csrf';
export function createWorkspaceApprovalsHandler(options: WorkspaceHandlerOptions): RequestListener {
  const api = new URL(options.apiUrl);
  if (api.protocol !== 'http:' || !['localhost', '127.0.0.1', '[::1]'].includes(api.hostname))
    throw new Error('offline endpoint');
  return (request, response) => {
    void handle(options, request, response).catch(() =>
      send(response, 503, 'Workspace approval unavailable.'),
    );
  };
}
async function handle(
  options: WorkspaceHandlerOptions,
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  const match = /^\/approvals\/workspace\/([^/]+)(\/decide)?$/.exec(
    new URL(request.url ?? '/', 'http://localhost').pathname,
  );
  if (!match) {
    send(response, 404, 'Approval not found.');
    return;
  }
  const id = decodeURIComponent(match[1]);
  const decision = request.method === 'POST' && match[2] === '/decide';
  if (!decision && !readRequest(request.method, match[2])) {
    send(response, 404, 'Approval not found.');
    return;
  }
  const loaded = await apiPost(options, request, '/v1/connectors/approvals/read', {
    approvalId: id,
  });
  if (!loaded.ok) {
    send(response, loaded.status, 'Approval unavailable.');
    return;
  }
  const data: unknown = await loaded.json();
  const fields = record(data);
  const approval = approvalSchema.parse(fields.get('approval'));
  if (approval.id !== id || approval.maxExecutions !== 1) throw new Error('approval mismatch');
  const csrfToken = cookieToken(request) ?? randomBytes(32).toString('hex');
  const view: WorkspacePageView = {
    approval,
    payload: fields.get('payload'),
    csrfToken,
    now: (options.now ?? (() => new Date()))(),
  };
  // Validate the payload before ever offering the decision controls.
  workspacePage(view);
  if (decision) {
    await decide(options, request, response, view);
    return;
  }
  response.setHeader(
    'set-cookie',
    `${csrfCookie}=${csrfToken}; Path=/approvals/workspace; HttpOnly; SameSite=Strict`,
  );
  sendPage(response, 200, view);
}
async function decide(
  options: WorkspaceHandlerOptions,
  request: IncomingMessage,
  response: ServerResponse,
  view: WorkspacePageView,
): Promise<void> {
  const form = await readForm(request);
  if (!form || !validCsrf(request, form)) {
    send(response, 403, 'Reload the approval before deciding.');
    return;
  }
  if (form.get('expectedPayloadSha256') !== view.approval.payloadSha256) {
    send(response, 409, 'Payload changed. Reload and review.');
    return;
  }
  const decision = form.get('decision');
  if (decision !== 'approve' && decision !== 'reject') {
    send(response, 400, 'Invalid decision.');
    return;
  }
  const result = await apiPost(options, request, '/v1/connectors/approvals/decide', {
    approvalId: view.approval.id,
    decision,
    expectedPayloadSha256: view.approval.payloadSha256,
  });
  if (!result.ok) {
    send(response, result.status, 'Decision could not be saved. Reload and review.');
    return;
  }
  const fields = record((await result.json()) as unknown);
  if (
    fields.get('id') !== view.approval.id ||
    !['approved', 'rejected'].includes(String(fields.get('state')))
  )
    throw new Error('invalid decision reply');
  sendPage(response, 200, {
    ...view,
    approval: { ...view.approval, state: decision === 'approve' ? 'approved' : 'rejected' },
    message: 'Decision saved.',
  });
}
function apiPost(
  options: WorkspaceHandlerOptions,
  request: IncomingMessage,
  path: string,
  body: unknown,
): Promise<Response> {
  const assertion = request.headers['x-goog-iap-jwt-assertion'];
  return (options.fetch ?? fetch)(new URL(path, options.apiUrl), {
    method: 'POST',
    redirect: 'error',
    headers: {
      'content-type': 'application/json',
      ...(typeof assertion === 'string' ? { 'x-goog-iap-jwt-assertion': assertion } : {}),
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(1500),
  });
}
function validCsrf(request: IncomingMessage, form: URLSearchParams): boolean {
  if (!cookieToken(request) || cookieToken(request) !== form.get('csrfToken')) return false;
  const origin = request.headers.origin;
  return origin === undefined || new URL(origin).host === request.headers.host;
}
function cookieToken(request: IncomingMessage): string | undefined {
  const prefix = `${csrfCookie}=`;
  const token = request.headers.cookie
    ?.split(';')
    .map((part) => part.trim())
    .find((part) => part.startsWith(prefix))
    ?.slice(prefix.length);
  return token && /^[a-f0-9]{64}$/.test(token) ? token : undefined;
}
async function readForm(request: IncomingMessage): Promise<URLSearchParams | undefined> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    size += bytes.byteLength;
    if (size > 16_384) return undefined;
    chunks.push(bytes);
  }
  return new URLSearchParams(Buffer.concat(chunks).toString('utf8'));
}
function record(value: unknown): ReadonlyMap<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    throw new Error('invalid response');
  return new Map<string, unknown>(Object.entries(value));
}
function sendPage(response: ServerResponse, status: number, view: WorkspacePageView): void {
  send(response, status, renderDocument(workspacePage(view)), 'text/html; charset=utf-8');
}
function send(
  response: ServerResponse,
  status: number,
  body: string,
  type = 'text/plain; charset=utf-8',
): void {
  if (response.headersSent) return;
  response.writeHead(status, { 'content-type': type, 'cache-control': 'no-store' });
  response.end(body);
}

function readRequest(method: string | undefined, suffix: string | undefined): boolean {
  return method === 'GET' && !suffix;
}
