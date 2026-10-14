import { afterEach, beforeEach, expect, test, vi } from 'vitest';

import { csrfCookie, csrfToken, csrfValid } from './csrf.js';

import type { IncomingMessage } from 'node:http';

beforeEach(() => {
  vi.stubEnv('NODE_ENV', 'development');
  vi.stubEnv('ADMIN_TRUSTED_ORIGINS', undefined);
});
afterEach(() => vi.unstubAllEnvs());

const token = 'a'.repeat(64);
function request(headers: Record<string, string | undefined>): IncomingMessage {
  return { headers } as IncomingMessage;
}
test('CSRF tokens have 256 bits of random entropy and restrictive cookies', () => {
  const first = csrfToken(request({}));
  expect(first).toMatch(/^[a-f0-9]{64}$/);
  expect(first).not.toBe(csrfToken(request({})));
  expect(csrfCookie(first)).toContain('HttpOnly; SameSite=Strict');
  expect(csrfCookie(first)).toContain('Path=/admin');
});
test('same-origin cookie and form token permit submission', () => {
  const req = request({
    cookie: `other=1; aw_admin_csrf=${token}`,
    origin: 'http://localhost:8085',
    host: 'localhost:8085',
  });
  expect(csrfToken(req)).toBe(token);
  expect(csrfValid(req, new URLSearchParams({ csrfToken: token }))).toBe(true);
});
test.each([
  {},
  { cookie: 'aw_admin_csrf=bad' },
  { cookie: `aw_admin_csrf=${token}`, origin: 'https://evil.example', host: 'localhost' },
  { cookie: `aw_admin_csrf=${token}`, origin: 'not a URL' },
])('rejects missing, malformed or cross-origin tokens', (headers) => {
  expect(csrfValid(request(headers), new URLSearchParams({ csrfToken: token }))).toBe(false);
});
test('different same-length tokens are rejected', () => {
  expect(
    csrfValid(
      request({ cookie: `aw_admin_csrf=${token}` }),
      new URLSearchParams({ csrfToken: 'b'.repeat(64) }),
    ),
  ).toBe(false);
});

test.each([
  ['http://127.0.0.1:8081', true],
  ['https://evil.example', false],
  ['http://web:8080', false],
  ['https://127.0.0.1:8081', false],
])('proxied CSRF submission from %s is accepted: %s', (origin, valid) => {
  expect(
    csrfValid(
      request({ cookie: `aw_admin_csrf=${token}`, origin, host: 'web:8080' }),
      new URLSearchParams({ csrfToken: token }),
    ),
  ).toBe(valid);
});
test('forging Host to match an untrusted Origin does not permit submission', () => {
  expect(
    csrfValid(
      request({
        cookie: `aw_admin_csrf=${token}`,
        origin: 'https://evil.example',
        host: 'evil.example',
      }),
      new URLSearchParams({ csrfToken: token }),
    ),
  ).toBe(false);
});
test('production requires an explicit public origin allowlist', () => {
  vi.stubEnv('NODE_ENV', 'production');
  const form = new URLSearchParams({ csrfToken: token });
  const headers = { cookie: `aw_admin_csrf=${token}`, host: 'web:8080' };
  expect(csrfValid(request({ ...headers, origin: 'http://127.0.0.1:8081' }), form)).toBe(false);
  vi.stubEnv('ADMIN_TRUSTED_ORIGINS', 'https://admin.example, https://other.example');
  for (const origin of ['https://admin.example', 'https://other.example'])
    expect(csrfValid(request({ ...headers, origin }), form)).toBe(true);
  for (const origin of [
    'http://127.0.0.1:8081',
    'http://admin.example',
    'https://admin.example.evil',
    'null',
  ])
    expect(csrfValid(request({ ...headers, origin }), form)).toBe(false);
});
