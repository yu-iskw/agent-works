import { createServer } from 'node:http';

import type { IncomingHttpHeaders, IncomingMessage, ServerResponse } from 'node:http';

const textPlain = 'text/plain; charset=utf-8';

export type Request = {
  method: string;
  url: URL;
  headers: IncomingHttpHeaders;
  body: Buffer;
};

export type Reply = {
  status: number;
  body: unknown;
  headers?: Record<string, string>;
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
    const body = typeof reply.body === 'string' ? reply.body : JSON.stringify(reply.body);
    const type = typeof reply.body === 'string' ? textPlain : 'application/json; charset=utf-8';
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
  headers?: Record<string, string>,
): void {
  response.writeHead(status, { 'content-type': type, ...headers });
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
