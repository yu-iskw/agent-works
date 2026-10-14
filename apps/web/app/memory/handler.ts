import { memoryClient } from './client.js';
import { memoryCookie, memoryCsrf, memoryCsrfValid } from './csrf.js';
import { memoryCommand, readMemoryForm } from './form.js';
import { memoryPage } from './page.js';

import type { WebAppOptions } from '../web-app.js';
import type { IncomingMessage, RequestListener, ServerResponse } from 'node:http';
export function createMemoryHandler(options: WebAppOptions): RequestListener {
  return (request, response) => {
    void handle(options, request, response).catch(() => {
      if (!response.headersSent)
        send(response, 503, 'Memory is unavailable. Reload before retrying.');
    });
  };
}
async function handle(
  options: WebAppOptions,
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  const path = URL.parse(request.url ?? '/', 'http://localhost')?.pathname;
  const client = memoryClient(options, request);
  const token = memoryCsrf(request);
  if (request.method === 'GET' && path === '/memory/export') {
    send(response, 200, JSON.stringify(await client.export(), null, 2), 'application/json');
    return;
  }

  if (
    request.method === 'POST' &&
    ['/memory/consent', '/memory/edit', '/memory/delete'].includes(path ?? '')
  ) {
    const form = await readMemoryForm(request);
    if (form === undefined) {
      send(response, 413, 'Form too large');
      return;
    }
    if (!memoryCsrfValid(request, form)) {
      send(response, 403, 'Reload memory before changing state.');
      return;
    }
    const action = path!.slice('/memory/'.length);
    let command: unknown;
    try {
      command = memoryCommand(action, form);
    } catch {
      send(response, 400, 'Invalid memory command');
      return;
    }
    await client.change(action, command);
  } else if (request.method !== 'GET' || !['/memory', '/memory/'].includes(path ?? '')) {
    send(response, 404, 'Not found');
    return;
  }
  const consent = await client.consent();
  const list = await client.list();
  response.setHeader('set-cookie', memoryCookie(token));
  send(
    response,
    200,
    memoryPage(consent.consent, list.items, token, consent.notice, {
      tenantEnabled: consent.tenantEnabled,
      message: memoryStatus(request),
    }),
  );
}
function send(
  response: ServerResponse,
  status: number,
  body: string,
  type = 'text/html; charset=utf-8',
): void {
  response.writeHead(status, {
    'content-type': type,
    'cache-control': 'no-store',
    'content-security-policy': "default-src 'none'; form-action 'self'; frame-ancestors 'none'",
    'x-content-type-options': 'nosniff',
  });
  response.end(body);
}

function memoryStatus(request: IncomingMessage): string {
  return request.method === 'POST' ? 'Memory updated.' : '';
}
