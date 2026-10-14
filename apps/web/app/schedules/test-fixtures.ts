import { IncomingMessage, ServerResponse } from 'node:http';
import { Socket } from 'node:net';
import { PassThrough } from 'node:stream';

import { scheduleFixture, scheduleHash } from '@agent-works/domain';

import { createSchedulesHandler } from './handler.js';

export function scheduleWebRecord() {
  const spec = scheduleFixture();
  const at = '2026-10-14T10:00:00.000Z';
  return {
    spec,
    digest: scheduleHash(spec),
    state: 'active' as const,
    revision: 1,
    createdAt: at,
    updatedAt: at,
    cursor: at,
  };
}
// Drive the real Node handler without opening a listening socket.
export function openSchedulesServer(load: typeof fetch) {
  const handler = createSchedulesHandler({ apiUrl: 'http://api.local', fetch: load });
  const url = 'http://schedules.local';
  const fetchPage = async (input: string, init?: RequestInit): Promise<Response> => {
    const page = new Request(input, init);
    const request = new IncomingMessage(new Socket());
    request.method = page.method;
    request.url = new URL(page.url).pathname;
    request.headers = Object.fromEntries(page.headers);
    request.headers.host = new URL(page.url).host;
    const body = Buffer.from(await page.arrayBuffer());
    request.push(body.length === 0 ? null : body);
    if (body.length !== 0) request.push(null);
    const response = new ServerResponse(request);
    response.useChunkedEncodingByDefault = false;
    response.shouldKeepAlive = false;
    const output = new PassThrough();
    const chunks: Buffer[] = [];
    output.on('data', (chunk: Buffer) => chunks.push(chunk));
    // ServerResponse only needs the writable stream interface exercised here.
    response.assignSocket(output as unknown as Socket);
    return new Promise<Response>((resolve, reject) => {
      response.on('error', reject);
      response.on('finish', () => {
        const raw = Buffer.concat(chunks).toString();
        const boundary = raw.indexOf('\r\n\r\n');
        const lines = raw.slice(0, boundary).split('\r\n');
        const headers = new Headers();
        for (const line of lines.slice(1)) {
          const colon = line.indexOf(':');
          headers.append(line.slice(0, colon), line.slice(colon + 1).trim());
        }
        resolve(new Response(raw.slice(boundary + 4), { status: response.statusCode, headers }));
      });
      handler(request, response);
    });
  };
  return Promise.resolve({ url, fetch: fetchPage, close: () => Promise.resolve() });
}
