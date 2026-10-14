import { expect, test, vi } from 'vitest';

import { adminClient } from './client.js';

import type { IncomingMessage } from 'node:http';

test('client forwards only the trusted assertion, not role or cookie headers', async () => {
  const load = vi
    .fn<typeof fetch>()
    .mockResolvedValue(Response.json({ suspensions: [], versions: [] }));
  const client = adminClient({ apiUrl: 'http://localhost:8084', fetch: load }, {
    headers: { 'x-goog-iap-jwt-assertion': 'signed', 'x-role': 'Admin', cookie: 'secret' },
  } as unknown as IncomingMessage);
  await expect(client.snapshot()).resolves.toEqual({ suspensions: [], versions: [] });
  expect(load).toHaveBeenCalledWith(
    new URL('http://localhost:8084/v1/admin/suspensions'),
    expect.objectContaining({
      headers: { 'content-type': 'application/json', 'x-goog-iap-jwt-assertion': 'signed' },
      redirect: 'error',
    }),
  );
});
test.each([401, 403, 409, 503])('client preserves controlled status %s', async (status) => {
  const client = adminClient(
    { apiUrl: 'http://localhost', fetch: () => Promise.resolve(new Response(null, { status })) },
    { headers: {} } as IncomingMessage,
  );
  await expect(client.snapshot()).rejects.toMatchObject({ status });
});
test('client rejects invalid API payload rather than rendering it', async () => {
  const client = adminClient(
    { apiUrl: 'http://localhost', fetch: () => Promise.resolve(Response.json({ role: 'Admin' })) },
    { headers: {} } as IncomingMessage,
  );
  await expect(client.snapshot()).rejects.toThrow();
});
