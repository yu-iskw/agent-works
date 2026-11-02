import { createServer } from 'node:http';

import type { IncomingHttpHeaders, IncomingMessage, ServerResponse } from 'node:http';

const textPlain = 'text/plain; charset=utf-8';

export type Request = {
  method: string;
  url: URL;
  headers: IncomingHttpHeaders;
  body: Buffer;
};

export type ReplyHeaders = Readonly<Record<string, string | readonly string[]>>;

export type Reply = {
  status: number;
  body: unknown;
  headers?: ReplyHeaders;
};

export type Handler = (request: Request) => Reply | Promise<Reply>;

export function header(headers: IncomingHttpHeaders, name: string): string | undefined {
  for (const [key, value] of Object.entries(headers)) {
    if (key === name) return Array.isArray(value) ? value[0] : value;
  }
  return undefined;
}

export function listen(
  handler: Handler,
  port: number,
): Promise<{ url: string; close: () => Promise<void> }> {
  const server = createServer((request, response) => {
    void respond(handler, request, response);
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '0.0.0.0', () => {
      const address = server.address();
      if (address === null || typeof address === 'string') {
        reject(new Error('port'));
        return;
      }
      resolve({
        url: `http://127.0.0.1:${address.port}`,
        close: () =>
          new Promise((done, fail) => {
            server.close((error) => (error ? fail(error) : done()));
          }),
      });
    });
  });
}

export function handlerFetch(handler: Handler): typeof fetch {
  return async (input, init) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    if (request.method === 'GET' && url.pathname === '/healthz') {
      return new Response('ok', { status: 200, headers: { 'content-type': textPlain } });
    }
    const { signal } = request;
    signal.throwIfAborted();
    let abort = () => {};
    const aborted = new Promise<never>((_resolve, reject) => {
      abort = () => reject(signal.reason as Error);
      signal.addEventListener('abort', abort, { once: true });
    });
    try {
      const reply = await Promise.race([
        (async () =>
          handler({
            method: request.method,
            url,
            headers: Object.fromEntries(request.headers),
            body: Buffer.from(await request.arrayBuffer()),
          }))(),
        aborted,
      ]);
      const encoded = encodeBody(reply);
      const headers = new Headers({ 'content-type': encoded.type });
      for (const [name, value] of Object.entries(reply.headers ?? {})) {
        headers.delete(name);
        for (const item of typeof value === 'string' ? [value] : value) headers.append(name, item);
      }
      return new Response(encoded.body, { status: reply.status, headers });
    } catch (error) {
      if (signal.aborted) throw error;
      return new Response('error', { status: 500, headers: { 'content-type': textPlain } });
    } finally {
      signal.removeEventListener('abort', abort);
    }
  };
}

function encodeBody(reply: Reply): { body: string; type: string } {
  return typeof reply.body === 'string'
    ? { body: reply.body, type: textPlain }
    : { body: JSON.stringify(reply.body), type: 'application/json; charset=utf-8' };
}

async function respond(
  handler: Handler,
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  try {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    if (request.method === 'GET' && url.pathname === '/healthz') {
      send(response, 200, 'ok', textPlain);
      return;
    }
    const reply = await handler({
      method: request.method ?? 'GET',
      url,
      headers: request.headers,
      body: await readBody(request),
    });
    const { body, type } = encodeBody(reply);
    send(response, reply.status, body, type, reply.headers);
  } catch {
    if (!response.headersSent) send(response, 500, 'error', textPlain);
  }
}

function send(
  response: ServerResponse,
  status: number,
  body: string,
  type: string,
  headers?: ReplyHeaders,
): void {
  response.statusCode = status;
  response.setHeader('content-type', type);
  if (headers !== undefined) {
    for (const [name, value] of Object.entries(headers)) {
      response.setHeader(name, typeof value === 'string' ? value : [...value]);
    }
  }
  response.end(body);
}

function readBody(request: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  return new Promise((resolve, reject) => {
    request.on('data', (chunk: Buffer) => {
      chunks.push(chunk);
    });
    request.on('end', () => resolve(Buffer.concat(chunks)));
    request.on('error', reject);
  });
}
