import { randomUUID } from 'node:crypto';

import {
  IAP_ASSERTION_HEADER,
  askErrorSchema,
  askRequestSchema,
  askResponseSchema,
  sourceCitationSchema,
} from '@agent-works/domain';

import { webTraceparent } from '../src/telemetry.js';

import { createAdminHandler } from './admin/handler.js';
import CitationList from './citations/citation-list.js';
import { h, Fragment, renderDocument } from './html.js';
import Page from './page.js';
import { createSchedulesHandler } from './schedules/handler.js';

import type { Html } from './html.js';
import type { PageView } from './page.js';
import type { AskErrorCode } from '@agent-works/domain';
import type { IncomingMessage, RequestListener, ServerResponse } from 'node:http';

export type WebAppOptions = {
  readonly apiUrl: string;
  readonly allowedApiHosts?: readonly string[];
  readonly fetch?: typeof fetch;
  readonly newRequestId?: () => string;
};

const textPlain = 'text/plain; charset=utf-8';
const textHtml = 'text/html; charset=utf-8';
const maxBodyBytes = 16_384;

export function createWebApp(options: WebAppOptions): RequestListener {
  const admin = createAdminHandler(options);
  const schedules = createSchedulesHandler(options);
  const load = options.fetch ?? fetch;
  const newRequestId = options.newRequestId ?? randomUUID;
  return (request, response) => {
    const path = URL.parse(request.url ?? '/', 'http://localhost')?.pathname;
    if (path === '/schedules' || path?.startsWith('/schedules/') === true)
      schedules(request, response);
    else if (path === '/admin' || path?.startsWith('/admin/') === true) admin(request, response);
    else void handle(options.apiUrl, load, newRequestId, request, response);
  };
}

async function handle(
  apiUrl: string,
  load: typeof fetch,
  newRequestId: () => string,
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  try {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    if (request.method === 'GET' && url.pathname === '/healthz') {
      send(response, 200, 'ok', textPlain);
      return;
    }
    if (request.method === 'GET' && url.pathname === '/') {
      sendPage(response, 200, { kind: 'ready', requestId: newRequestId() });
      return;
    }
    if (request.method === 'POST' && url.pathname === '/citations') {
      await postCitations(request, response);
      return;
    }
    if (request.method === 'POST' && url.pathname === '/') {
      await postAsk(apiUrl, load, newRequestId, request, response);
      return;
    }
    send(response, 404, 'not found', textPlain);
  } catch {
    if (!response.headersSent) send(response, 500, 'error', textPlain);
  }
}

async function postCitations(request: IncomingMessage, response: ServerResponse): Promise<void> {
  const body = await readLimited(request, maxBodyBytes);
  if (body === undefined) {
    send(response, 400, 'too large', textPlain);
    return;
  }
  const parsed = sourceCitationSchema.array().safeParse(readJson(body));
  if (!parsed.success) {
    send(response, 400, 'invalid citation', textPlain);
    return;
  }
  sendHtml(response, 200, CitationList({ citations: parsed.data }));
}

function readJson(body: Buffer): unknown {
  try {
    return JSON.parse(body.toString('utf8')) as unknown;
  } catch {
    return undefined;
  }
}

async function postAsk(
  apiUrl: string,
  load: typeof fetch,
  newRequestId: () => string,
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  const body = await readLimited(request, maxBodyBytes);
  if (body === undefined) {
    send(response, 400, 'too large', textPlain);
    return;
  }
  const form = readForm(body);
  const parsed = askRequestSchema.safeParse(form);
  if (!parsed.success) {
    sendPage(response, 400, {
      kind: 'failed',
      requestId: newRequestId(),
      question: form.question ?? '',
      message: 'Enter a question.',
    });
    return;
  }
  const view = await ask(
    apiUrl,
    load,
    newRequestId,
    parsed.data,
    headerValue(request, IAP_ASSERTION_HEADER),
  );
  sendPage(response, 200, view);
}

async function ask(
  apiUrl: string,
  load: typeof fetch,
  newRequestId: () => string,
  body: { requestId: string; question: string },
  assertion: string | undefined,
): Promise<PageView> {
  const requestId = newRequestId();
  const traceparent = webTraceparent(body.requestId);
  let response: Response;
  try {
    response = await load(new URL('/v1/ask', apiUrl), {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(assertion === undefined ? {} : { [IAP_ASSERTION_HEADER]: assertion }),
        ...(traceparent === undefined ? {} : { traceparent }),
      },
      body: JSON.stringify(body),
    });
  } catch {
    return {
      kind: 'failed',
      requestId,
      question: body.question,
      message: 'The service is unavailable.',
    };
  }
  const payload = await readPayload(response);
  const answered = askResponseSchema.safeParse(payload);
  if (answered.success) {
    return { kind: 'answered', requestId, question: body.question, response: answered.data };
  }
  const error = askErrorSchema.safeParse(payload);
  const message = error.success ? messageFor(error.data.error) : 'The ask failed.';
  return { kind: 'failed', requestId, question: body.question, message };
}

async function readPayload(response: Response): Promise<unknown> {
  try {
    return JSON.parse(await response.text()) as unknown;
  } catch {
    return undefined;
  }
}

function messageFor(code: AskErrorCode): string {
  switch (code) {
    case 'unauthenticated':
      return 'Sign in required.';
    case 'unavailable':
      return 'The service is unavailable.';
    case 'invalid_request':
      return 'That question is not valid.';
    case 'conflict':
      return 'That request was already used.';
    case 'retrieval_failed':
      return 'Retrieval failed.';
    case 'runner_failed':
      return 'The answer could not be produced.';
    case 'audit_failed':
      return 'The answer could not be recorded.';
    default: {
      const unexpected: never = code;
      return unexpected;
    }
  }
}

function readForm(body: Buffer): { question?: string; requestId?: string } {
  const params = new URLSearchParams(body.toString('utf8'));
  const question = params.get('question');
  const requestId = params.get('requestId');
  return {
    ...(question === null ? {} : { question }),
    ...(requestId === null ? {} : { requestId }),
  };
}

function sendPage(response: ServerResponse, status: number, view: PageView): void {
  sendHtml(
    response,
    status,
    Fragment(
      null,
      h('nav', { 'aria-label': 'Main' }, h('a', { href: '/schedules' }, 'Schedules')),
      Page({ view }),
    ),
  );
}

function sendHtml(response: ServerResponse, status: number, root: Html): void {
  send(response, status, renderDocument(root), textHtml);
}

function send(response: ServerResponse, status: number, body: string, type: string): void {
  response.writeHead(status, { 'content-type': type });
  response.end(body);
}

export function headerValue(request: IncomingMessage, name: string): string | undefined {
  const wanted = name.toLowerCase();
  for (const [key, value] of Object.entries(request.headers)) {
    if (key.toLowerCase() !== wanted) continue;
    if (Array.isArray(value)) return value[0];
    return value;
  }
  return undefined;
}

function readLimited(request: IncomingMessage, max: number): Promise<Buffer | undefined> {
  const chunks: Buffer[] = [];
  let size = 0;
  let settled = false;
  return new Promise((resolve, reject) => {
    const finish = (value: Buffer | undefined) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    request.on('data', (chunk: Buffer) => {
      if (settled) return;
      size += chunk.length;
      if (size > max) return;
      chunks.push(chunk);
    });
    request.on('end', () => finish(size > max ? undefined : Buffer.concat(chunks)));
    request.on('error', (error: unknown) => {
      if (settled) return;
      settled = true;
      reject(error instanceof Error ? error : new Error('request body'));
    });
  });
}
