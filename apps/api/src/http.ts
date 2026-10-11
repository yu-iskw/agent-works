import type {
  IncomingHttpHeaders,
  IncomingMessage,
  RequestListener,
  ServerResponse,
} from 'node:http';

type ApiRequest = {
  readonly method: string;
  readonly path: string;
  readonly headers: IncomingHttpHeaders;
  readonly body: Buffer;
};

export type ApiReply = { readonly status: number; readonly body: unknown };

export type Route = (request: ApiRequest) => Promise<ApiReply>;

const maxBodyBytes = 16_384;

const textPlain = 'text/plain; charset=utf-8';
const jsonType = 'application/json; charset=utf-8';

export function createListener(routes: Readonly<Record<string, Route>>): RequestListener {
  const table = new Map(Object.entries(routes));
  return (request, response) => {
    void handle(table, request, response);
  };
}

export function headerValue(headers: IncomingHttpHeaders, name: string): string | undefined {
  const wanted = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() !== wanted) continue;
    if (Array.isArray(value)) return value[0];
    return value;
  }
  return undefined;
}

async function handle(
  routes: ReadonlyMap<string, Route>,
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  try {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    if (request.method === 'GET' && url.pathname === '/healthz') {
      send(response, 200, 'ok', textPlain);
      return;
    }
    const body = await readLimited(request);
    if (body === undefined) {
      send(response, 413, JSON.stringify({ error: 'too_large' }), jsonType);
      return;
    }
    const route = routes.get(`${request.method ?? 'GET'} ${url.pathname}`);
    if (route === undefined) {
      send(response, 404, JSON.stringify({ error: 'not_found' }), jsonType);
      return;
    }
    const reply = await route({
      method: request.method ?? 'GET',
      path: url.pathname,
      headers: request.headers,
      body,
    });
    const payload = typeof reply.body === 'string' ? reply.body : JSON.stringify(reply.body);
    const type = typeof reply.body === 'string' ? textPlain : jsonType;
    send(response, reply.status, payload, type);
  } catch {
    if (!response.headersSent) send(response, 500, 'error', textPlain);
  }
}

function send(response: ServerResponse, status: number, body: string, type: string): void {
  response.writeHead(status, { 'content-type': type });
  response.end(body);
}

export function readLimited(
  request: IncomingMessage,
  max = maxBodyBytes,
): Promise<Buffer | undefined> {
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
