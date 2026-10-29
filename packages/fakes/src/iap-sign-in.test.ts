import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { listen } from './http.js';
import { createIapProxy } from './iap-proxy.js';

let upstream: Awaited<ReturnType<typeof listen>>;
let withSignIn: Awaited<ReturnType<typeof listen>>;
let without: Awaited<ReturnType<typeof listen>>;

beforeAll(async () => {
  upstream = await listen(
    (request) => ({
      status: 200,
      body: request.headers['x-goog-iap-jwt-assertion'] === undefined ? 'no-assertion' : 'signed',
      headers: {
        'content-type': 'text/plain',
        'x-task-version': '7',
        'x-backend-header': 'kept',
        'content-encoding': 'identity',
      },
    }),
    0,
  );
  withSignIn = await listen(createIapProxy(upstream.url, { signIn: true }), 0);
  without = await listen(createIapProxy(upstream.url), 0);
});

afterAll(async () => {
  await Promise.all([upstream.close(), withSignIn.close(), without.close()]);
});

describe('fake IAP local sign-in', () => {
  it('is off by default: no cookie identity and no redirect', async () => {
    const response = await fetch(`${without.url}/`, {
      headers: { cookie: 'aw_fake_user=alice' },
      redirect: 'manual',
    });
    expect(response.status).toBe(401);
    expect((await fetch(`${without.url}/_auth/sign-in`, { redirect: 'manual' })).status).toBe(401);
  });

  it('redirects browsers to sign in and accepts only known users', async () => {
    const anonymous = await fetch(`${withSignIn.url}/tasks`, { redirect: 'manual' });
    expect(anonymous.status).toBe(303);
    expect(anonymous.headers.get('location')).toBe('/_auth/sign-in');
    const bad = await fetch(`${withSignIn.url}/_auth/sign-in`, {
      method: 'POST',
      body: 'user=mallory',
      redirect: 'manual',
    });
    expect(bad.status).toBe(400);
    const good = await fetch(`${withSignIn.url}/_auth/sign-in`, {
      method: 'POST',
      body: 'user=bob',
      redirect: 'manual',
    });
    expect(good.status).toBe(303);
    expect(good.headers.get('set-cookie')).toContain(
      'aw_fake_user=bob; Path=/; HttpOnly; SameSite=Lax',
    );
  });

  it('signs requests for a cookie identity and forwards backend headers like IAP', async () => {
    const response = await fetch(`${withSignIn.url}/tasks`, {
      headers: { cookie: 'aw_fake_user=alice' },
    });
    expect(await response.text()).toBe('signed');
    expect(response.headers.get('x-task-version')).toBe('7');
    expect(response.headers.get('x-backend-header')).toBe('kept');
    // The body is re-framed by the proxy, so upstream framing headers must not survive.
    expect(response.headers.get('content-encoding')).toBeNull();
  });
});
