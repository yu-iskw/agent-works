import { readFile } from 'node:fs/promises';
import { extname, resolve as resolvePath, sep } from 'node:path';

import {
  askErrorSchema,
  askRequestSchema,
  askResponseSchema,
  IAP_ASSERTION_HEADER,
} from '@agent-works/domain';

import { webTraceparent } from '../src/telemetry.js';

import type { AskErrorCode, AskRequest, AskResponse } from '@agent-works/domain';
import type { IncomingMessage, RequestListener, ServerResponse } from 'node:http';

export type WebAppOptions = {
  readonly apiUrl: string;
  readonly clientDir: string;
  readonly fetch?: typeof fetch;
};

type HttpFailure = {
  readonly status: number;
  readonly message: string;
};

type AskOutcome =
  | { readonly ok: true; readonly body: AskResponse }
  | { readonly ok: false; readonly failure: HttpFailure };

const textPlain = 'text/plain; charset=utf-8';
const jsonType = 'application/json; charset=utf-8';
const maxBodyBytes = 16_384;

const askFailures = {
  unauthenticated: { status: 401, message: 'Sign in required.' },
  unavailable: { status: 503, message: 'The service is unavailable.' },
  invalid_request: { status: 400, message: 'That question is not valid.' },
  conflict: { status: 409, message: 'That request was already used.' },
  retrieval_failed: { status: 502, message: 'Retrieval failed.' },
  runner_failed: { status: 502, message: 'The answer could not be produced.' },
  audit_failed: { status: 502, message: 'The answer could not be recorded.' },
} as const satisfies Record<AskErrorCode, HttpFailure>;

const fetchFailed: HttpFailure = { status: 503, message: 'The service is unavailable.' };
const upstreamFailed: HttpFailure = { status: 502, message: 'The ask failed.' };
const invalidQuestion: HttpFailure = { status: 400, message: 'That question is not valid.' };
const questionTooLong: HttpFailure = { status: 413, message: 'That question is too long.' };

const fileTypes = new Map<string, string>([
  ['.css', 'text/css; charset=utf-8'],
  ['.html', 'text/html; charset=utf-8'],
  ['.ico', 'image/x-icon'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.json', jsonType],
  ['.png', 'image/png'],
  ['.svg', 'image/svg+xml; charset=utf-8'],
  ['.woff2', 'font/woff2'],
]);

export function createWebApp(options: WebAppOptions): RequestListener {
  const load = options.fetch ?? fetch;
  return (request, response) => {
    void handle(options.apiUrl, options.clientDir, load, request, response);
  };
}

async function handle(
  apiUrl: string,
  clientDir: string,
  load: typeof fetch,
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  try {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    if (request.method === 'GET' && url.pathname === '/healthz') {
      send(response, 200, 'ok', textPlain);
      return;
    }
    if (request.method === 'POST' && url.pathname === '/api/ask') {
      await postAsk(apiUrl, load, request, response);
      return;
    }
    if (request.method === 'GET') {
      await serveFile(clientDir, request, response);
      return;
    }
    sendNotFound(response);
  } catch {
    if (response.headersSent) return;
    const raw = request.url ?? '/';
    const pathname = raw.split(/[?#]/, 1)[0] ?? '/';
    if (request.method === 'POST' && pathname === '/api/ask') {
      sendFailure(response, { status: 500, message: 'The ask failed.' });
      return;
    }
    send(response, 500, 'error', textPlain);
  }
}

async function postAsk(
  apiUrl: string,
  load: typeof fetch,
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  const body = await readLimited(request, maxBodyBytes);
  if (body === undefined) {
    sendFailure(response, questionTooLong);
    return;
  }
  const parsed = askRequestSchema.safeParse(readJson(body));
  if (!parsed.success) {
    sendFailure(response, invalidQuestion);
    return;
  }
  const outcome = await ask(apiUrl, load, parsed.data, headerValue(request, IAP_ASSERTION_HEADER));
  if (!outcome.ok) {
    sendFailure(response, outcome.failure);
    return;
  }
  sendJson(response, 200, outcome.body);
}

async function ask(
  apiUrl: string,
  load: typeof fetch,
  body: AskRequest,
  assertion: string | undefined,
): Promise<AskOutcome> {
  const traceparent = webTraceparent(body.requestId);
  let upstream: Response;
  try {
    upstream = await load(new URL('/v1/ask', apiUrl), {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(assertion === undefined ? {} : { [IAP_ASSERTION_HEADER]: assertion }),
        ...(traceparent === undefined ? {} : { traceparent }),
      },
      body: JSON.stringify(body),
    });
  } catch {
    return { ok: false, failure: fetchFailed };
  }
  const payload = await readPayload(upstream);
  const answered = askResponseSchema.safeParse(payload);
  if (answered.success) return { ok: true, body: answered.data };
  const error = askErrorSchema.safeParse(payload);
  if (error.success) return { ok: false, failure: failureFor(error.data.error) };
  return { ok: false, failure: upstreamFailed };
}

function failureFor(code: AskErrorCode): HttpFailure {
  // eslint-disable-next-line security/detect-object-injection -- parsed AskErrorCode
  return askFailures[code];
}

async function serveFile(
  clientDir: string,
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  const file = clientFile(clientDir, request.url ?? '/');
  if (file === undefined) {
    sendNotFound(response);
    return;
  }
  try {
    const bytes = await readClientFile(file);
    send(
      response,
      200,
      bytes,
      fileTypes.get(extname(file).toLowerCase()) ?? 'application/octet-stream',
    );
  } catch (error: unknown) {
    if (isMissingFile(error)) {
      sendNotFound(response);
      return;
    }
    throw error;
  }
}

function clientFile(clientDir: string, rawUrl: string): string | undefined {
  const cut = rawUrl.search(/[?#]/);
  const pathOnly = cut === -1 ? rawUrl : rawUrl.slice(0, cut);
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathOnly);
  } catch {
    return undefined;
  }
  const relative = decoded === '/' ? 'index.html' : decoded.replace(/^\/+/, '');
  if (relative === '') return undefined;
  const root = resolvePath(clientDir);
  const resolved = resolvePath(root, relative);
  if (!resolved.startsWith(`${root}${sep}`)) return undefined;
  return resolved;
}

function readClientFile(file: string): Promise<Buffer> {
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- path stays inside clientDir
  return readFile(file);
}

function isMissingFile(error: unknown): boolean {
  const code =
    typeof error === 'object' && error !== null && 'code' in error ? error.code : undefined;
  return code === 'ENOENT' || code === 'EISDIR' || code === 'ENOTDIR';
}

async function readPayload(response: Response): Promise<unknown> {
  try {
    return JSON.parse(await response.text()) as unknown;
  } catch {
    return undefined;
  }
}

function readJson(body: Buffer): unknown {
  try {
    return JSON.parse(body.toString('utf8')) as unknown;
  } catch {
    return undefined;
  }
}

function sendFailure(response: ServerResponse, failure: HttpFailure): void {
  sendJson(response, failure.status, { message: failure.message });
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  send(response, status, JSON.stringify(body), jsonType);
}

function sendNotFound(response: ServerResponse): void {
  send(response, 404, 'not found', textPlain);
}

function send(response: ServerResponse, status: number, body: string | Buffer, type: string): void {
  response.writeHead(status, { 'content-type': type });
  response.end(body);
}

function headerValue(request: IncomingMessage, name: string): string | undefined {
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
