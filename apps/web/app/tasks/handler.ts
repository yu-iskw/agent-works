import { IAP_ASSERTION_HEADER, taskSchema } from '@agent-works/domain';

import type { IncomingMessage, RequestListener, ServerResponse } from 'node:http';

type TaskDetailsOptions = {
  readonly apiUrl: string;
  readonly fetch?: typeof fetch;
};

const taskPath = /^\/tasks\/([a-zA-Z0-9_-]{1,128})$/;
const jsonType = 'application/json; charset=utf-8';
const textType = 'text/plain; charset=utf-8';

/**
 * Read-only, caller-scoped task snapshot. The API verifies the IAP assertion and
 * reads the ledger using the verified subject; this web route must not infer a
 * subject from task identifiers, URL parameters or other client headers.
 *
 * Requires AW_TASKS_READ=real on the API. No task is created by this route.
 */
export function createTaskDetailsHandler(options: TaskDetailsOptions): RequestListener {
  const load = options.fetch ?? fetch;
  return (request, response) => {
    void handle(options.apiUrl, load, request, response).catch(() => {
      if (!response.headersSent) send(response, 503, 'Task service unavailable.');
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
  const match = taskPath.exec(pathname);
  if (request.method !== 'GET' || match === null) {
    send(response, 404, 'not found');
    return;
  }

  const assertion = request.headers['x-goog-iap-jwt-assertion'];
  if (typeof assertion !== 'string' || assertion.length === 0) {
    send(response, 401, 'unauthenticated');
    return;
  }

  await readTask(apiUrl, load, match[1], assertion, response);
}

/** Keep response handling separate from request parsing to make denial paths explicit. */
async function readTask(
  apiUrl: string,
  load: typeof fetch,
  id: string,
  assertion: string,
  response: ServerResponse,
): Promise<void> {
  // Only a fixed API route and the IAP assertion cross this boundary. Do not
  // forward client Authorization, cookies, user identifiers or query strings.
  const upstream = await load(new URL(`/v1/tasks/${id}`, apiUrl), {
    method: 'GET',
    headers: { [IAP_ASSERTION_HEADER]: assertion },
    cache: 'no-store',
    redirect: 'manual',
    signal: AbortSignal.timeout(2500),
  });

  if (upstream.status === 401 || upstream.status === 403 || upstream.status === 404) {
    // Never reflect an upstream denial body, which might contain private data.
    send(response, upstream.status, upstream.status === 401 ? 'unauthenticated' : 'not found');
    return;
  }
  if (!upstream.ok) {
    send(response, 503, 'Task service unavailable.');
    return;
  }

  const payload: unknown = await upstream.json();
  const parsed = taskSchema.safeParse(payload);
  if (!parsed.success || parsed.data.id !== id) {
    send(response, 502, 'Invalid task response.');
    return;
  }
  // Re-serialize only the known task schema fields, rather than leaking any
  // extra fields accidentally returned by the API.
  send(response, 200, JSON.stringify(parsed.data), jsonType);
}

function send(
  response: ServerResponse,
  status: number,
  body: string,
  contentType = textType,
): void {
  response.writeHead(status, {
    'content-type': contentType,
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
  });
  response.end(body);
}
