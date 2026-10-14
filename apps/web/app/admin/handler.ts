import { adminClient, AdminServiceError } from './client.js';
import { csrfCookie, csrfToken, csrfValid } from './csrf.js';
import { parseAdminForm, readAdminForm } from './form.js';
import { adminPage, confirmationPage } from './page.js';

import type { WebAppOptions } from '../web-app.js';
import type { IncomingMessage, RequestListener, ServerResponse } from 'node:http';

export function createAdminHandler(options: WebAppOptions): RequestListener {
  return (request, response) => {
    void handle(options, request, response).catch((error: unknown) => {
      if (!response.headersSent)
        send(
          response,
          error instanceof AdminServiceError ? error.status : 503,
          'Administration is unavailable. Reload before retrying.',
        );
    });
  };
}
async function handle(
  options: WebAppOptions,
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  const path = URL.parse(request.url ?? '/', 'http://localhost')?.pathname;
  const client = adminClient(options, request);
  if (isPageRequest(request.method, path)) {
    const snapshot = await client.snapshot();
    const history = await client.history();
    const token = csrfToken(request);
    response.setHeader('set-cookie', csrfCookie(token));
    send(response, 200, adminPage({ ...snapshot, events: history.events, csrfToken: token }));
    return;
  }
  if (!isChangeRequest(request.method, path)) {
    send(response, 404, 'Not found');
    return;
  }
  const form = await readAdminForm(request);
  if (form === undefined) {
    send(response, 413, 'Form too large');
    return;
  }
  if (!csrfValid(request, form)) {
    send(response, 403, 'Reload administration before changing state.');
    return;
  }
  const command = parseAdminForm(form);
  if (command === undefined) {
    send(response, 400, 'Invalid admin change');
    return;
  }
  // Authorization is rechecked at confirmation and at the mutation API.
  await client.snapshot();
  if (path === '/admin/confirm') {
    send(response, 200, confirmationPage(form));
    return;
  }
  if (form.get('confirmed') !== 'yes') {
    send(response, 400, 'Confirmation required');
    return;
  }
  await client.change(command.kind, command.command);
  const snapshot = await client.snapshot();
  const history = await client.history();
  send(
    response,
    200,
    adminPage({
      ...snapshot,
      events: history.events,
      csrfToken: csrfToken(request),
      message: 'Admin change saved.',
    }),
  );
}
function send(response: ServerResponse, status: number, html: string): void {
  response.writeHead(status, {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-store',
    'content-security-policy': "default-src 'none'; form-action 'self'; frame-ancestors 'none'",
    'x-content-type-options': 'nosniff',
  });
  response.end(html);
}

function isPageRequest(method: string | undefined, path: string | undefined): boolean {
  return method === 'GET' && (path === '/admin' || path === '/admin/');
}
function isChangeRequest(method: string | undefined, path: string | undefined): boolean {
  return method === 'POST' && (path === '/admin/confirm' || path === '/admin/apply');
}
