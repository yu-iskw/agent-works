import { scheduleClient, ScheduleServiceError } from './client.js';
import { scheduleCookie, scheduleCsrf, scheduleCsrfValid } from './csrf.js';
import { parseScheduleChange, parseScheduleForm, readScheduleForm } from './form.js';
import { schedulesPage, schedulePreviewPage } from './page.js';

import type { WebAppOptions } from '../web-app.js';
import type { IncomingMessage, RequestListener, ServerResponse } from 'node:http';
export function createSchedulesHandler(options: WebAppOptions): RequestListener {
  return (request, response) => {
    void handle(options, request, response).catch((error: unknown) => {
      if (!response.headersSent)
        send(
          response,
          error instanceof ScheduleServiceError ? error.status : 503,
          'Schedules are unavailable. Reload before retrying.',
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
  const client = scheduleClient(options, request);
  const token = scheduleCsrf(request);
  if (request.method === 'GET' && (path === '/schedules' || path === '/schedules/')) {
    const rows = await client.list();
    response.setHeader('set-cookie', scheduleCookie(token));
    send(response, 200, schedulesPage(rows, token));
    return;
  }
  if (
    request.method !== 'POST' ||
    !['/schedules/preview', '/schedules/create', '/schedules/change'].includes(path ?? '')
  ) {
    send(response, 404, 'Not found');
    return;
  }
  const form = await readScheduleForm(request);
  if (form === undefined) {
    send(response, 413, 'Form too large');
    return;
  }
  if (!scheduleCsrfValid(request, form)) {
    send(response, 403, 'Reload schedules before changing state.');
    return;
  }
  await mutate(client, path, form, token, response);
}
async function mutate(
  client: ReturnType<typeof scheduleClient>,
  path: string | undefined,
  form: URLSearchParams,
  token: string,
  response: ServerResponse,
): Promise<void> {
  if (path === '/schedules/change') {
    const command = parseScheduleChange(form);
    if (command === undefined) {
      send(response, 400, 'Invalid change');
      return;
    }
    await client.change(command);
    send(response, 200, schedulesPage(await client.list(), token, 'Schedule updated.'));
    return;
  }
  const spec = parseScheduleForm(form);
  if (spec === undefined) {
    send(response, 400, 'Invalid schedule specification');
    return;
  }
  if (path === '/schedules/preview') {
    send(response, 200, schedulePreviewPage(spec, await client.preview(spec), token));
    return;
  }
  await client.create(spec);
  send(response, 200, schedulesPage(await client.list(), token, 'Schedule created.'));
}
function send(response: ServerResponse, status: number, body: string): void {
  response.writeHead(status, {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-store',
    'content-security-policy': "default-src 'none'; form-action 'self'; frame-ancestors 'none'",
    'x-content-type-options': 'nosniff',
  });
  response.end(body);
}
