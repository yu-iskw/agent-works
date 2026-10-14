import { Readable } from 'node:stream';

import { describe, expect, it, vi } from 'vitest';

import { createApp } from '../app.js';
import { createMemoryAuditLog } from '../audit/write.js';

import type { Route } from '../http.js';
import type { IncomingMessage, ServerResponse } from 'node:http';

describe('API connector mount', () => {
  it('dispatches connector commands through the application with the original assertion and body', async () => {
    const route = vi.fn<Route>(() =>
      Promise.resolve({ status: 201, body: { approval: 'prepared' } }),
    );
    const listener = createApp({
      connectors: { 'POST /v1/connectors/approvals/prepare': route },
      verify: () => Promise.reject(new Error('unused')),
      drive: { retrieve: () => Promise.resolve([]) },
      runner: { run: () => Promise.reject(new Error('unused')) },
      audit: createMemoryAuditLog(),
      now: () => new Date(),
    });
    const body = Buffer.from('{"tool":"docs.createDraft"}');
    const request = Object.assign(Readable.from([body]), {
      method: 'POST',
      url: '/v1/connectors/approvals/prepare',
      headers: { 'x-goog-iap-jwt-assertion': 'alice' },
    }) as unknown as IncomingMessage;
    let status = 0;
    const result = await new Promise<string>((resolve) => {
      const response = {
        headersSent: false,
        writeHead: (code: number) => {
          status = code;
        },
        end: resolve,
      } as unknown as ServerResponse;
      listener(request, response);
    });
    expect(status).toBe(201);
    expect(JSON.parse(result)).toEqual({ approval: 'prepared' });
    expect(route).toHaveBeenCalledWith({
      method: 'POST',
      path: request.url,
      headers: request.headers,
      body,
    });
  });
});
