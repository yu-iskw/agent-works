import { describe, expect, it, vi } from 'vitest';

import { runConnectors } from './connectors.js';
function writer() {
  const lines: string[] = [];
  return {
    write: (line: string) => {
      lines.push(line);
    },
    text: () => lines.join(''),
  };
}
describe('aw connectors', () => {
  it('lists only safe connection status and scopes', async () => {
    const out = writer();
    const load: typeof fetch = () =>
      Promise.resolve(
        Response.json({
          connections: [
            {
              provider: 'google',
              scope: 'scope-b scope-a',
              status: 'active',
              tokenRef: 'PRIVATE_REF',
              token: 'PRIVATE_TOKEN',
            },
          ],
        }),
      );
    expect(await runConnectors(['list'], out, { assertion: 'SECRET_ASSERTION', fetch: load })).toBe(
      0,
    );
    expect(out.text()).toContain('google\tactive\tscope-a scope-b');
    expect(out.text()).not.toContain('PRIVATE');
    expect(out.text()).not.toContain('SECRET_ASSERTION');
  });
  it('passes only the trusted assertion to the existing status endpoint', async () => {
    const out = writer();
    const calls: Request[] = [];
    const load: typeof fetch = (url, init) => {
      calls.push(new Request(url, init));
      return Promise.resolve(Response.json({ connections: [] }));
    };
    expect(await runConnectors([], out, { assertion: 'caller-token', fetch: load })).toBe(0);
    expect(calls[0].url).toBe('http://127.0.0.1:8084/v1/oauth/connections');
    expect(calls[0].headers.get('x-goog-iap-jwt-assertion')).toBe('caller-token');
    expect(calls[0].headers.get('x-fake-user')).toBeNull();
    expect(out.text()).toContain('No connected providers.');
  });
  it('requires authentication before sending HTTP', async () => {
    const out = writer();
    const load = vi.fn<typeof fetch>();
    expect(await runConnectors([], out, { fetch: load })).toBe(1);
    expect(load).not.toHaveBeenCalled();
    expect(out.text()).toBe('Authentication required.\n');
  });
  it.each([['send'], ['list', 'extra'], ['--subject', 'bob']])(
    'rejects unsupported arguments %j',
    async (...args) => {
      const out = writer();
      const load = vi.fn<typeof fetch>();
      expect(await runConnectors(args, out, { assertion: 'caller', fetch: load })).toBe(2);
      expect(load).not.toHaveBeenCalled();
    },
  );
  it.each([401, 403, 500])('redacts upstream status %s error bodies', async (status) => {
    const out = writer();
    expect(
      await runConnectors([], out, {
        assertion: 'caller',
        fetch: () => Promise.resolve(new Response('UPSTREAM_SECRET', { status })),
      }),
    ).toBe(1);
    expect(out.text()).not.toContain('UPSTREAM_SECRET');
  });
  it('rejects a real Google endpoint without contacting it', async () => {
    const out = writer();
    const load = vi.fn<typeof fetch>();
    expect(
      await runConnectors([], out, {
        assertion: 'caller',
        apiUrl: 'https://www.googleapis.com',
        fetch: load,
      }),
    ).toBe(1);
    expect(load).not.toHaveBeenCalled();
  });
  it('redacts terminal control characters in provider labels and scope names', async () => {
    const out = writer();
    const load: typeof fetch = () =>
      Promise.resolve(
        Response.json({
          connections: [{ provider: 'google\u001b', status: 'revoked', scope: 'read\u0000' }],
        }),
      );
    expect(await runConnectors([], out, { assertion: 'caller', fetch: load })).toBe(0);
    expect(out.text()).not.toContain('\u001b');
    expect(out.text()).not.toContain('\u0000');
  });
  it('rejects malformed connection responses', async () => {
    const out = writer();
    expect(
      await runConnectors([], out, {
        assertion: 'caller',
        fetch: () =>
          Promise.resolve(
            Response.json({
              connections: [{ provider: 'google', status: 'invented', scope: 'read' }],
            }),
          ),
      }),
    ).toBe(1);
    expect(out.text()).toBe('Connectors unavailable.\n');
  });
});
