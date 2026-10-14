import { describe, expect, it } from 'vitest';

import { memoryCsrf, memoryCookie, memoryCsrfValid } from './csrf.js';

import type { IncomingMessage } from 'node:http';
const token = 'a'.repeat(64);
function request(headers: Record<string, string>): IncomingMessage {
  return { headers } as IncomingMessage;
}
describe('memory mutation CSRF boundary', () => {
  it('uses a path scoped HttpOnly same-site token', () => {
    expect(memoryCookie(token)).toBe(
      `aw_memory_csrf=${token}; Path=/memory; HttpOnly; SameSite=Strict`,
    );
    expect(memoryCsrf(request({ cookie: `aw_memory_csrf=${token}` }))).toBe(token);
  });
  it('mints a random token when none exists', () => {
    expect(memoryCsrf(request({}))).toMatch(/^[a-f0-9]{64}$/);
    expect(memoryCsrf(request({}))).not.toBe(memoryCsrf(request({})));
  });
  it('accepts a matching token and origin host', () => {
    expect(
      memoryCsrfValid(
        request({
          cookie: `aw_memory_csrf=${token}`,
          host: 'localhost:8085',
          origin: 'http://localhost:8085',
        }),
        new URLSearchParams({ csrfToken: token }),
      ),
    ).toBe(true);
  });
  it.each([
    {},
    { cookie: `aw_memory_csrf=${token}`, origin: 'http://evil.local', host: 'localhost' },
    { cookie: 'aw_memory_csrf=bad' },
    { cookie: `aw_memory_csrf=${token}`, origin: 'invalid', host: 'localhost' },
  ])('rejects missing malformed or cross origin tokens %#', (headers) => {
    expect(
      memoryCsrfValid(
        request(headers as Record<string, string>),
        new URLSearchParams({ csrfToken: token }),
      ),
    ).toBe(false);
  });
  it('rejects unequal tokens and length confusion', () => {
    for (const posted of ['b'.repeat(64), token.slice(1), ''])
      expect(
        memoryCsrfValid(
          request({ cookie: `aw_memory_csrf=${token}` }),
          new URLSearchParams({ csrfToken: posted }),
        ),
      ).toBe(false);
  });
});
