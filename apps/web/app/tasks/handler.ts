import { IAP_ASSERTION_HEADER, taskSchema } from '@agent-works/domain';
import { z } from 'zod';

import type { IncomingMessage, RequestListener, ServerResponse } from 'node:http';

export type OwnerReadOptions = {
  readonly apiUrl: string;
  readonly fetch?: typeof fetch;
};

const readPath = /^\/(tasks|artifacts)\/([a-zA-Z0-9_-]{1,128})$/;
const artifactSchema = z.strictObject({ text: z.string() });
const denials = new Map([
  [401, 'unauthenticated'],
  [403, 'not found'],
  [404, 'not found'],
]);
const jsonType = 'application/json; charset=utf-8';
const textType = 'text/plain; charset=utf-8';

export function isOwnerReadPath(path: string): boolean {
  return readPath.test(path);
}

/**
 * Read-only, caller-scoped task and artifact reads. The API verifies the IAP
 * assertion and authorizes with the verified subject. This route forwards only
 * the assertion and never derives a subject from ids, query strings, cookies
 * or client identity headers.
 */
export function createOwnerReadHandler(options: OwnerReadOptions): RequestListener {
  const load = options.fetch ?? fetch;
  return (request, response) => {
    void handle(options.apiUrl, load, request, response).catch(() => {
      if (!response.headersSent) send(response, 503, 'unavailable');
    });
  };
}

async function handle(
  apiUrl: string,
  load: typeof fetch,
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  const pathname = URL.parse(request.url ?? '/', 'http://localhost')?.pathname ?? '';
  const match = readPath.exec(pathname);
  if (request.method !== 'GET' || match === null) {
    send(response, 404, 'not found');
    return;
  }
  const assertion = request.headers[IAP_ASSERTION_HEADER.toLowerCase()];
  if (typeof assertion !== 'string' || assertion.length === 0) {
    send(response, 401, 'unauthenticated');
    return;
  }
  const [, kind, id] = match;
  const upstream = await load(new URL(`/v1/${kind}/${id}`, apiUrl), {
    method: 'GET',
    headers: { [IAP_ASSERTION_HEADER]: assertion },
    cache: 'no-store',
    redirect: 'manual',
    signal: AbortSignal.timeout(2500),
  });
  const denial = denials.get(upstream.status);
  if (denial !== undefined) {
    send(response, upstream.status, denial);
    return;
  }
  if (!upstream.ok) {
    send(response, 503, 'unavailable');
    return;
  }
  const body = readBody(kind, id, await upstream.json());
  if (body === undefined) send(response, 502, 'invalid response');
  else send(response, 200, body, jsonType);
}

function readBody(kind: string, id: string, payload: unknown): string | undefined {
  if (kind === 'tasks') {
    const task = taskSchema.safeParse(payload);
    return task.success && task.data.id === id ? JSON.stringify(task.data) : undefined;
  }
  const artifact = artifactSchema.safeParse(payload);
  return artifact.success ? JSON.stringify(artifact.data) : undefined;
}

function send(response: ServerResponse, status: number, body: string, type = textType): void {
  response.writeHead(status, {
    'content-type': type,
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
  });
  response.end(body);
}
