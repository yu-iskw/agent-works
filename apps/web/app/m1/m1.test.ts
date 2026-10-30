import { createServer } from 'node:http';

import { afterEach, describe, expect, it } from 'vitest';

import { parseSegments, readWebConfig } from './config.js';
import { SignInError, createAssertionSigner } from './identity.js';
import { createInternalHandler } from './internal.js';

import type { AddressInfo } from 'node:net';

const servers: ReturnType<typeof createServer>[] = [];
afterEach(() => {
  for (const server of servers.splice(0)) server.close();
});

async function serve(e2eSecret: string | undefined): Promise<string> {
  const handler = createInternalHandler({
    config: {
      e2eSecret,
      members: new Map([['alpha', new Set(['one@example.test', 'two@example.test'])]]),
    },
    identity: {
      e2eAuthorize: (secret) =>
        secret === e2eSecret ? Promise.resolve() : Promise.reject(new SignInError('forbidden')),
      e2eSession: (secret) =>
        secret === e2eSecret
          ? Promise.reject(new SignInError('reauth_required'))
          : Promise.reject(new SignInError('forbidden')),
    },
    signer: createAssertionSigner('google'),
  });
  const server = createServer(handler);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

describe('e2e session endpoint', () => {
  it('is disabled by default: no AW_E2E_MODE means no secret and a 404', () => {
    const config = readWebConfig({ AW_SEGMENTS: '', AW_ALLOWED_BACKEND_HOSTS: '' });
    expect(config.e2eSecret).toBeUndefined();
  });

  it('stays disabled when the mode flag is not exactly 1', () => {
    expect(readWebConfig({ AW_E2E_MODE: 'true' }).e2eSecret).toBeUndefined();
    expect(readWebConfig({ AW_E2E_MODE: '0' }).e2eSecret).toBeUndefined();
  });

  it('answers 404 like an unknown route when disabled', async () => {
    const url = await serve(undefined);
    const response = await fetch(`${url}/internal/e2e/session`, {
      method: 'POST',
      body: '{"email":"a@b.c"}',
      headers: { 'x-e2e-secret': 'x'.repeat(64) },
    });
    expect(response.status).toBe(404);
  });

  it('rejects a wrong secret and reaches identity only with the right one', async () => {
    const secret = 's'.repeat(64);
    const url = await serve(secret);
    const wrong = await fetch(`${url}/internal/e2e/session`, {
      method: 'POST',
      body: '{"email":"a@b.c"}',
      headers: { 'x-e2e-secret': 'w'.repeat(64) },
    });
    expect(wrong.status).toBe(403);
    const right = await fetch(`${url}/internal/e2e/session`, {
      method: 'POST',
      body: '{"email":"a@b.c"}',
      headers: { 'x-e2e-secret': secret },
    });
    expect(right.status).toBe(409);
    const multibyte = await fetch(`${url}/internal/e2e/session`, {
      method: 'POST',
      body: '{"email":"a@b.c"}',
      headers: { 'x-e2e-secret': encodeURIComponent('é'.repeat(64)) },
    });
    expect(multibyte.status, 'a same-length multibyte secret is refused, not a crash').toBe(403);
    expect(await right.json()).toEqual({ error: 'reauth_required' });
  });

  it('lists configured members only with the secret, and only when e2e mode is on', async () => {
    const off = await serve(undefined);
    expect(
      (await fetch(`${off}/internal/e2e/members`, { headers: { 'x-e2e-secret': 's'.repeat(64) } }))
        .status,
    ).toBe(404);
    const secret = 's'.repeat(64);
    const on = await serve(secret);
    expect(
      (await fetch(`${on}/internal/e2e/members`, { headers: { 'x-e2e-secret': 'w'.repeat(64) } }))
        .status,
    ).toBe(403);
    const listed = await fetch(`${on}/internal/e2e/members`, {
      headers: { 'x-e2e-secret': secret },
    });
    expect(await listed.json()).toEqual({ alpha: ['one@example.test', 'two@example.test'] });
  });

  it('serves the assertion JWKS without private key material', async () => {
    const url = await serve(undefined);
    const body = (await (await fetch(`${url}/internal/jwks`)).json()) as {
      keys: Record<string, unknown>[];
    };
    expect(body.keys[0]).toMatchObject({ kty: 'EC', crv: 'P-256', alg: 'ES256' });
    expect(body.keys[0]).not.toHaveProperty('d');
  });
});

describe('segment registry', () => {
  it('accepts only allowlisted backend hosts', () => {
    expect(parseSegments('alpha=http://api-alpha:8080|Alpha', ['api-alpha'])).toEqual([
      { id: 'alpha', url: 'http://api-alpha:8080', name: 'Alpha' },
    ]);
    expect(() => parseSegments('alpha=http://evil.example:8080|Alpha', ['api-alpha'])).toThrow(
      /not allowed/,
    );
    expect(() => parseSegments('Alpha!=http://api-alpha:8080|A', ['api-alpha'])).toThrow(/invalid/);
    expect(() =>
      parseSegments('a1=http://api-alpha:8080|A,a1=http://api-alpha:8080|B', ['api-alpha']),
    ).toThrow(/duplicate/);
  });
});

describe('member assertions', () => {
  it('are short-lived and bound to one segment audience', () => {
    const signer = createAssertionSigner('google');
    const token = signer.mint({ sub: 's', email: 'e@x.y' }, 'alpha', 1_000_000);
    const claims = JSON.parse(
      Buffer.from(token.split('.')[1] ?? '', 'base64url').toString(),
    ) as Record<string, unknown>;
    expect(claims).toMatchObject({
      aud: 'segment:alpha',
      iss: 'https://aw-m1-web.local/google',
      iat: 1000,
      exp: 1060,
    });
  });
});
