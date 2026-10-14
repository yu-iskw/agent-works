import { IncomingMessage, ServerResponse, createServer } from 'node:http';
import { Socket } from 'node:net';

import type { RequestListener } from 'node:http';

/** Server-level request dispatch, independent of localhost socket permissions. */
export function listenerFetch(listener: RequestListener): typeof fetch {
  const server = createServer(listener);
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
        resolve(
          new Response(chunk === undefined ? '' : String(chunk), { status: response.statusCode }),
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

function bodyText(body: BodyInit): string {
  if (typeof body === 'string') return body;
  if (body instanceof URLSearchParams) return body.toString();
  throw new Error('Unsupported test request body');
}
