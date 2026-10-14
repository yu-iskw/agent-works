import { expect, test } from 'vitest';

import { csrfCookie, csrfToken, csrfValid } from './csrf.js';

import type { IncomingMessage } from 'node:http';

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
