import { describe, expect, it } from 'vitest';

import { oauthApiSchema, oauthConnectionSchema, oauthStartSchema } from './credentials.js';

const start = {
  provider: 'fake',
  state: 'state-1',
  codeChallenge: 'challenge',
  codeChallengeMethod: 'S256' as const,
  scope: 'ticket.create',
};

const connection = {
  provider: 'fake',
  subject: 'alice',
  scope: 'ticket.create',
  status: 'active' as const,
  expiresAt: '2026-12-31T00:00:00.000Z',
  tokenRef: 'token-1',
};

describe('oauth contracts', () => {
  it('rejects a raw token on a connection', () => {
    expect(
      oauthConnectionSchema.safeParse({ ...connection, token: 'canary-do-not-log' }).success,
    ).toBe(false);
  });

  it('rejects domain-wide delegation on the start request', () => {
    expect(oauthStartSchema.safeParse({ ...start, delegation: 'domain' }).success).toBe(false);
  });

  it('round-trips start, callback, and connection', () => {
    expect(oauthApiSchema.parse({ kind: 'start', ...start })).toEqual({ kind: 'start', ...start });
    expect(
      oauthApiSchema.parse({
        kind: 'callback',
        provider: 'fake',
        state: 'state-1',
        code: 'code-1',
        codeVerifier: 'verifier',
      }),
    ).toEqual({
      kind: 'callback',
      provider: 'fake',
      state: 'state-1',
      code: 'code-1',
      codeVerifier: 'verifier',
    });
    expect(oauthApiSchema.parse({ kind: 'connection', ...connection })).toEqual({
      kind: 'connection',
      ...connection,
    });
  });
});

it('requires a consent URL on the start response', () => {
  const response = { kind: 'started', ...start, authorizationUrl: 'https://oauth.example/consent' };
  expect(oauthApiSchema.parse(response)).toEqual(response);
  expect(oauthApiSchema.safeParse({ kind: 'started', ...start }).success).toBe(false);
  expect(oauthApiSchema.safeParse({ ...response, authorizationUrl: 'invalid' }).success).toBe(
    false,
  );
});

it.each(['code', 'state'] as const)('requires callback %s', (field) => {
  const callback = {
    kind: 'callback',
    provider: 'fake',
    state: 'state-1',
    code: 'code-1',
    codeVerifier: 'verifier',
  };
  expect(oauthApiSchema.safeParse({ ...callback, [field]: undefined }).success).toBe(false);
});
