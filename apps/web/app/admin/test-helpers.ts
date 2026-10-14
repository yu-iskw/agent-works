import { IncomingMessage, ServerResponse, createServer } from 'node:http';
import { Socket } from 'node:net';

import { createWebApp } from '../web-app.js';

import type { WebAppOptions } from '../web-app.js';
import type { Server } from 'node:http';

/** Exercise a real server's request listener without requiring a kernel listening socket. */
export function serverFetch(server: Server): typeof fetch {
  return (input, init) =>
    new Promise((resolve, reject) => {
      const url = new URL(
        typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
      );
      const request = new IncomingMessage(new Socket());
      request.url = url.pathname;
      request.method = init?.method ?? 'GET';
      request.headers = Object.fromEntries(new Headers(init?.headers).entries());
      request.headers.host = url.host;
      const response = new ServerResponse(request);
      response.end = ((chunk?: string | Buffer) => {
        const headers = new Headers();
        for (const [key, value] of Object.entries(response.getHeaders())) {
          if (value !== undefined)
            headers.set(key, Array.isArray(value) ? value.join(',') : String(value));
        }
        resolve(
          new Response(chunk === undefined ? '' : String(chunk), {
            status: response.statusCode,
            headers,
          }),
        );
        return response;
      }) as typeof response.end;
      request.on('error', reject);
      response.on('error', reject);
      server.emit('request', request, response);
      if (init?.body !== undefined && init.body !== null) request.push(bodyText(init.body));
      request.push(null);
    });
}
export function adminWeb(options: WebAppOptions) {
  const server = createServer(createWebApp(options));
  return Promise.resolve({
    url: 'http://127.0.0.1:8085',
    fetch: serverFetch(server),
    close: () => Promise.resolve(),
  });
}
export const emptySnapshot = { suspensions: [], versions: [] };
export const commandId = '00000000-0000-4000-8000-000000000001';
export function stopForm(token: string) {
  return new URLSearchParams({
    csrfToken: token,
    commandId,
    kind: 'suspension',
    action: 'suspend',
    scope: 'global',
    id: '*',
    version: '',
    reason: 'Local stop',
    expectedRevision: '0',
    expiresAt: '',
  });
}

function bodyText(body: BodyInit): string {
  if (typeof body === 'string') return body;
  if (body instanceof URLSearchParams) return body.toString();
  throw new Error('Unsupported test request body');
}
