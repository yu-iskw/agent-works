import { randomBytes } from 'node:crypto';

import { IAP_ASSERTION_HEADER, approvalApiSchema, approvalSchema } from '@agent-works/domain';

import { renderDocument } from '../html.js';

import Page from './page.js';

import type { ApprovalView } from './page.js';
import type { Approval, ApprovalApi } from '@agent-works/domain';
import type { IncomingMessage, RequestListener, ServerResponse } from 'node:http';

export type ApprovalsOptions = {
  readonly apiUrl: string;
  readonly readApproval: (id: string, request: IncomingMessage) => Promise<Approval | undefined>;
  readonly fetch?: typeof fetch;
};

const cookieName = 'approval-csrf';
const notFound = 'Approval not found.';

function routeFor(request: IncomingMessage): { id: string; isDecision: boolean } | undefined {
  const url = new URL(request.url ?? '/', 'http://localhost');
  const match = /^\/approvals\/([^/]+)(\/decide)?$/.exec(url.pathname);
  if (match === null) return undefined;
  const isDecision = request.method === 'POST' && match.at(2) === '/decide';
  if (!isDecision && (request.method !== 'GET' || match.at(2) !== undefined)) return undefined;
  return { id: decodeURIComponent(match[1]), isDecision };
}

export function createApprovalsHandler(options: ApprovalsOptions): RequestListener {
  return (request, response) => {
    void handle(options, request, response).catch(() => {
      if (!response.headersSent) send(response, 503, 'The approval service is unavailable.');
    });
  };
}

async function handle(
  options: ApprovalsOptions,
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  const route = routeFor(request);
  if (route === undefined) {
    send(response, 404, notFound);
    return;
  }
  const { id, isDecision } = route;
  const approval = await options.readApproval(id, request);
  if (approval === undefined) {
    send(response, 404, notFound);
    return;
  }
  const parsed = approvalSchema.parse(approval);
  if (parsed.id !== id) throw new Error('Approval id mismatch');
  const csrfToken = cookieToken(request) ?? randomBytes(32).toString('hex');
  if (isDecision) {
    await decide(options, request, response, { approval: parsed, csrfToken });
    return;
  }
  response.setHeader(
    'set-cookie',
    `${cookieName}=${csrfToken}; Path=/approvals; HttpOnly; SameSite=Strict`,
  );
  sendPage(response, 200, { approval: parsed, csrfToken });
}

async function decide(
  options: ApprovalsOptions,
  request: IncomingMessage,
  response: ServerResponse,
  view: ApprovalView,
): Promise<void> {
  const form = await readForm(request);
  const origin = request.headers.origin;
  if (
    form === undefined ||
    cookieToken(request) !== form.get('csrfToken') ||
    (origin !== undefined && new URL(origin).host !== request.headers.host)
  ) {
    sendPage(response, 403, {
      ...view,
      blocked: true,
      message: 'Reload the approval before deciding.',
    });
    return;
  }
  const command = approvalApiSchema.safeParse({
    kind: 'decide',
    decision: form.get('decision'),
    expectedPayloadSha256: form.get('expectedPayloadSha256'),
  });
  if (!command.success || command.data.kind !== 'decide') {
    sendPage(response, 400, { ...view, blocked: true, message: 'The decision is invalid.' });
    return;
  }
  let result: Response;
  let payload: unknown;
  try {
    result = await postDecision(options, request, view, command.data);
    payload = await result.json();
  } catch {
    sendPage(response, 503, {
      ...view,
      blocked: true,
      message: 'The approval service is unavailable. Reload and try again.',
    });
    return;
  }
  decisionReply(response, view, result, payload);
}

function postDecision(
  options: ApprovalsOptions,
  request: IncomingMessage,
  view: ApprovalView,
  command: ApprovalApi,
): Promise<Response> {
  const assertion = request.headers['x-goog-iap-jwt-assertion'];
  return (options.fetch ?? fetch)(
    new URL(`/v1/approvals/${encodeURIComponent(view.approval.id)}:decide`, options.apiUrl),
    {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-csrf-token': view.csrfToken,
        ...(typeof assertion === 'string' ? { [IAP_ASSERTION_HEADER]: assertion } : {}),
      },
      body: JSON.stringify(command),
      signal: AbortSignal.timeout(1500),
    },
  );
}

function decisionReply(
  response: ServerResponse,
  view: ApprovalView,
  result: Response,
  payload: unknown,
): void {
  const decided = approvalApiSchema.safeParse(payload);
  if (
    result.ok &&
    decided.success &&
    decided.data.kind === 'decided' &&
    decided.data.id === view.approval.id
  ) {
    sendPage(response, 200, {
      ...view,
      approval: {
        ...view.approval,
        state: decided.data.state,
        executionsUsed: decided.data.executionsUsed,
      },
      message: decided.data.state === 'approved' ? 'Approval approved.' : 'Approval rejected.',
    });
    return;
  }
  const stale = result.status === 409 && isStale(payload);
  sendPage(response, result.ok ? 502 : result.status, {
    ...view,
    blocked: true,
    message: stale
      ? 'The payload has changed. Reload and review the current action before deciding.'
      : 'The decision could not be saved. Reload the approval and try again.',
  });
}

function isStale(payload: unknown): boolean {
  return (
    typeof payload === 'object' &&
    payload !== null &&
    'error' in payload &&
    payload.error === 'stale_digest'
  );
}

function cookieToken(request: IncomingMessage): string | undefined {
  const token = request.headers.cookie
    ?.split(';')
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${cookieName}=`))
    ?.slice(cookieName.length + 1);
  return token !== undefined && /^[a-f0-9]{64}$/.test(token) ? token : undefined;
}

async function readForm(request: IncomingMessage): Promise<URLSearchParams | undefined> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    size += bytes.length;
    if (size <= 16_384) chunks.push(bytes);
  }
  return size > 16_384 ? undefined : new URLSearchParams(Buffer.concat(chunks).toString('utf8'));
}

function sendPage(response: ServerResponse, status: number, view: ApprovalView): void {
  send(response, status, renderDocument(Page(view)), 'text/html; charset=utf-8');
}

function send(
  response: ServerResponse,
  status: number,
  body: string,
  type = 'text/plain; charset=utf-8',
): void {
  response.writeHead(status, { 'content-type': type, 'cache-control': 'no-store' });
  response.end(body);
}
