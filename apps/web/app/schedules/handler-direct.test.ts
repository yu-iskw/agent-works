import { Readable } from 'node:stream';

import { expect, test, vi } from 'vitest';

import { createSchedulesHandler } from './handler.js';
import { scheduleWebRecord } from './test-fixtures.js';

import type { IncomingMessage, ServerResponse } from 'node:http';

const token = 'a'.repeat(64);
const origin = 'http://web.local';
const cookie = `aw_schedules_csrf=${token}`;

type Reply = { status: number; headers: Record<string, unknown>; body: string };
function invoke(
  load: typeof fetch,
  method = 'GET',
  path = '/schedules',
  body = '',
  headers: IncomingMessage['headers'] = {},
): Promise<Reply> {
  const request = Object.assign(Readable.from([Buffer.from(body)]), {
    method,
    url: path,
    headers: { host: 'web.local', ...headers },
  }) as IncomingMessage;
  return new Promise((resolve) => {
    const reply: Reply = { status: 0, headers: {}, body: '' };
    const response = {
      headersSent: false,
      setHeader(name: string, value: unknown) {
        Object.assign(reply.headers, { [name]: value });
      },
      writeHead(status: number, values: Record<string, unknown>) {
        reply.status = status;
        Object.assign(reply.headers, values);
      },
      end(value: string) {
        reply.body = value;
        resolve(reply);
      },
    } as unknown as ServerResponse;
    createSchedulesHandler({ apiUrl: 'http://api.local', fetch: load })(request, response);
  });
}
function form(values: Record<string, string> = {}): string {
  return new URLSearchParams({ csrfToken: token, ...values }).toString();
}
function authenticated() {
  return { cookie, origin, 'x-goog-iap-jwt-assertion': 'asserted-alice' };
}
const json = (value: unknown, status = 200) => Promise.resolve(Response.json(value, { status }));

test('direct GET renders a list and sets a scoped cookie and security headers', async () => {
  const row = scheduleWebRecord();
  const load = vi.fn<typeof fetch>(() => json({ schedules: [row] }));
  const reply = await invoke(load, 'GET', '/schedules', '', authenticated());
  expect(reply.status).toBe(200);
  expect(reply.body).toContain(row.spec.purpose);
  expect(reply.body).toContain('Pause');
  expect(reply.headers).toMatchObject({
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  });
  expect(reply.headers['set-cookie']).toContain('Path=/schedules; HttpOnly; SameSite=Strict');
  expect(reply.headers['content-security-policy']).toContain("form-action 'self'");
  expect(load.mock.calls[0][1]?.headers).toMatchObject({
    'x-goog-iap-jwt-assertion': 'asserted-alice',
  });
});

test.each(['/schedules/preview', '/schedules/create', '/schedules/change'])(
  '%s direct mutation rejects missing CSRF before API access',
  async (path) => {
    const load = vi.fn<typeof fetch>(() => json({ schedules: [] }));
    const reply = await invoke(load, 'POST', path, form());
    expect(reply.status).toBe(403);
    expect(load).not.toHaveBeenCalled();
  },
);

test.each(['http://evil.local', 'null', 'invalid'])('origin %s fails closed', async (foreign) => {
  const load = vi.fn<typeof fetch>(() => json({ schedules: [] }));
  const reply = await invoke(load, 'POST', '/schedules/create', form(), {
    cookie,
    origin: foreign,
  });
  expect(reply.status).toBe(403);
  expect(load).not.toHaveBeenCalled();
});

test('direct privilege preview has creation form only for an allowed ceiling', async () => {
  const row = scheduleWebRecord();
  for (const allowed of [false, true]) {
    const load = vi.fn<typeof fetch>(() => json({ allowed }));
    const reply = await invoke(
      load,
      'POST',
      '/schedules/preview',
      form({ spec: JSON.stringify(row.spec) }),
      authenticated(),
    );
    expect(reply.status).toBe(200);
    expect(reply.body).toContain('Schedule privilege preview');
    expect(reply.body.includes('Create schedule')).toBe(allowed);
    expect(load).toHaveBeenCalledTimes(1);
    expect(load.mock.calls[0][1]?.body).toBe(JSON.stringify(row.spec));
  }
});

test('direct creation posts the pinned spec then reloads current schedule state', async () => {
  const row = scheduleWebRecord();
  const load = vi.fn<typeof fetch>((_input, init) =>
    json(init?.method === 'POST' ? row : { schedules: [row] }),
  );
  const reply = await invoke(
    load,
    'POST',
    '/schedules/create',
    form({ spec: JSON.stringify(row.spec) }),
    authenticated(),
  );
  expect(reply.status).toBe(200);
  expect(reply.body).toContain('Schedule created.');
  expect(load).toHaveBeenCalledTimes(2);
  expect(load.mock.calls[0][1]?.method).toBe('POST');
  expect(load.mock.calls[1][1]?.method).toBe('GET');
});

test.each(['pause', 'resume'])('direct %s carries the optimistic revision', async (action) => {
  const row = scheduleWebRecord();
  const load = vi.fn<typeof fetch>((_input, init) =>
    json(init?.method === 'POST' ? row : { schedules: [row] }),
  );
  const reply = await invoke(
    load,
    'POST',
    '/schedules/change',
    form({ id: row.spec.id, revision: '7', action }),
    authenticated(),
  );
  expect(reply.status).toBe(200);
  expect(reply.body).toContain('Schedule updated.');
  expect(load.mock.calls[0][1]?.body).toBe(
    JSON.stringify({ id: row.spec.id, expectedRevision: 7, action }),
  );
});

test.each(['', '0', '-1', '1.5', '9007199254740992'])(
  'revision %s cannot mutate',
  async (revision) => {
    const load = vi.fn<typeof fetch>(() => json({ schedules: [] }));
    const row = scheduleWebRecord();
    const reply = await invoke(
      load,
      'POST',
      '/schedules/change',
      form({ id: row.spec.id, revision, action: 'pause' }),
      authenticated(),
    );
    expect(reply.status).toBe(400);
    expect(load).not.toHaveBeenCalled();
  },
);

test.each(['not-json', '{}', '[]', 'null'])('invalid schedule %s cannot mutate', async (spec) => {
  const load = vi.fn<typeof fetch>(() => json({ schedules: [] }));
  const reply = await invoke(load, 'POST', '/schedules/create', form({ spec }), authenticated());
  expect(reply.status).toBe(400);
  expect(load).not.toHaveBeenCalled();
});

test('oversized form is rejected without contacting the API', async () => {
  const load = vi.fn<typeof fetch>(() => json({ schedules: [] }));
  const reply = await invoke(load, 'POST', '/schedules/create', 'x'.repeat(32769), authenticated());
  expect(reply.status).toBe(413);
  expect(load).not.toHaveBeenCalled();
});

test.each([401, 403, 409, 503])(
  'API %s is retained without exposing service response content',
  async (status) => {
    const reply = await invoke(() => json({ secret: 'canary' }, status));
    expect(reply.status).toBe(status);
    expect(reply.body).toContain('Schedules are unavailable');
    expect(reply.body).not.toContain('canary');
  },
);

test.each([null, {}, { schedules: 'bad' }, { schedules: [{}] }])(
  'malformed list %# fails closed',
  async (body) => {
    const reply = await invoke(() => json(body));
    expect(reply.status).toBe(503);
    expect(reply.body).not.toContain('No schedules yet');
  },
);

test('network errors render a retry message without exposing thrown secrets', async () => {
  const reply = await invoke(() => Promise.reject(new Error('secret-canary')));
  expect(reply.status).toBe(503);
  expect(reply.body).toContain('Reload before retrying');
  expect(reply.body).not.toContain('secret-canary');
});

test.each([
  ['DELETE', '/schedules'],
  ['POST', '/elsewhere'],
  ['GET', '/schedules/change'],
])('unsupported request %s %s returns 404 without API access', async (method, path) => {
  const load = vi.fn<typeof fetch>(() => json({ schedules: [] }));
  expect((await invoke(load, method, path)).status).toBe(404);
  expect(load).not.toHaveBeenCalled();
});
