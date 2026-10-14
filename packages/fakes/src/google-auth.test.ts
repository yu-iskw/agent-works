import { describe, expect, it } from 'vitest';

import { googleIdentity } from './google-auth.js';

import type { Request } from './http.js';
const options = {
  tokens: new Map([
    ['opaque', { subject: 'alice', scopes: ['read'] }],
    ['revoked', { subject: 'bob', scopes: ['read'], revoked: true }],
  ]),
};
function request(authorization?: string): Request {
  return {
    method: 'GET',
    url: new URL('http://127.0.0.1/users/me/threads'),
    headers: { authorization, 'x-fake-user': 'bob' },
    body: Buffer.from('{}'),
  };
}
describe('fake Google authentication', () => {
  it('uses server-side token identity and ignores forged user headers', () => {
    expect(googleIdentity(request('Bearer opaque'), options, 'read')).toEqual({
      subject: 'alice',
      scopes: ['read'],
    });
  });
  it.each([undefined, '', 'opaque', 'Basic opaque', 'Bearer unknown', 'Bearer revoked'])(
    'rejects unauthorized bearer %s',
    (authorization) => {
      expect(googleIdentity(request(authorization), options, 'read')).toMatchObject({
        status: 401,
      });
    },
  );
  it('rejects missing scopes', () => {
    expect(googleIdentity(request('Bearer opaque'), options, 'write')).toMatchObject({
      status: 403,
    });
  });
});
