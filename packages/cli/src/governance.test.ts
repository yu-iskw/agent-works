import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { runGovernance } from './index.js';

describe('governance CLI', () => {
  it('prints help without contacting a service or exposing credentials', async () => {
    const lines: string[] = [];
    expect(
      await runGovernance(
        ['--help'],
        {
          write: (line) => {
            lines.push(line);
          },
        },
        { assertion: 'SECRET_TOKEN' },
      ),
    ).toBe(0);
    expect(lines.join('')).toContain('aw governance');
    expect(lines.join('')).not.toContain('SECRET_TOKEN');
  });
  it('requires command review for mutations', async () => {
    const lines: string[] = [];
    expect(
      await runGovernance(['delete', 'command.json', '--url', 'http://127.0.0.1:8084'], {
        write: (line) => {
          lines.push(line);
        },
      }),
    ).toBe(1);
    expect(lines.join('')).toContain('--confirm');
  });
  it('lists deletion requests with a trusted IAP assertion and no client role', async () => {
    const requests: RequestInit[] = [];
    const urls: string[] = [];
    const lines: string[] = [];
    const load: typeof fetch = (input, init) => {
      urls.push(input instanceof Request ? input.url : String(input));
      requests.push(init ?? {});
      return Promise.resolve(new Response(JSON.stringify({ requests: [] }), { status: 200 }));
    };
    expect(
      await runGovernance(
        ['deletions', '--url', 'http://127.0.0.1:8084'],
        {
          write: (line) => {
            lines.push(line);
          },
        },
        { assertion: 'verified-token', fetch: load },
      ),
    ).toBe(0);
    expect(urls).toEqual(['http://127.0.0.1:8084/v1/admin/governance/deletions']);
    expect(requests[0].method).toBe('GET');
    expect(requests[0].headers).toEqual({
      'content-type': 'application/json',
      'x-goog-iap-jwt-assertion': 'verified-token',
    });
    expect(requests[0].redirect).toBe('error');
    expect(lines.join('')).not.toContain('verified-token');
  });
  it('sends the reviewed JSON hold command without modification', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'governance-cli-'));
    const file = join(directory, 'command.json');
    try {
      const command = {
        commandId: '00000000-0000-4000-8000-000000000139',
        action: 'set',
        target: { kind: 'owner', id: 'alice' },
        reasonRef: 'case',
      };
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- disposable test command
      await writeFile(file, JSON.stringify(command));
      const requests: RequestInit[] = [];
      const load: typeof fetch = (_input, init) => {
        requests.push(init ?? {});
        return Promise.resolve(new Response('{}'));
      };
      expect(
        await runGovernance(
          ['hold', file, '--confirm', '--url', 'http://127.0.0.1:8084'],
          { write: () => {} },
          { fetch: load },
        ),
      ).toBe(0);
      expect(requests[0].method).toBe('POST');
      expect(requests[0].body).toBe(JSON.stringify(command));
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
  it.each([
    ['unknown', 1],
    ['holds', 1],
  ])('reports usage for missing configuration: %s', async (command, code) => {
    expect(await runGovernance([command], { write: () => {} })).toBe(code);
  });
  it.each([
    'file:///private/path',
    'https://user:password@example.test',
    'http://example.test',
    'http://192.168.1.1',
    'http://128.0.0.1',
    'http://127.0.0.1.example.test',
    'http://localhost.example.test',
    'http://[::2]',
    'http://[::ffff:127.0.0.1]',
  ])('rejects unsafe endpoint %s before fetching', async (url) => {
    let fetched = false;
    const load: typeof fetch = () => {
      fetched = true;
      return Promise.resolve(new Response('{}'));
    };
    expect(
      await runGovernance(
        ['holds', '--url', url],
        { write: () => {} },
        { fetch: load, assertion: 'verified-token' },
      ),
    ).toBe(2);
    expect(fetched).toBe(false);
  });
  it.each([
    'http://localhost:8084',
    'http://127.0.0.1:8084',
    'http://127.42.0.9:8084',
    'http://127.255.255.255:8084',
    'http://[::1]:8084',
    'https://example.test',
  ])('accepts secure or loopback endpoint %s', async (apiUrl) => {
    const requests: RequestInit[] = [];
    const load: typeof fetch = (_input, init) => {
      requests.push(init ?? {});
      return Promise.resolve(new Response('{}'));
    };
    expect(
      await runGovernance(
        ['holds'],
        { write: () => {} },
        { apiUrl, fetch: load, assertion: 'verified-token' },
      ),
    ).toBe(0);
    expect(requests).toHaveLength(1);
    expect(requests[0].headers).toHaveProperty('x-goog-iap-jwt-assertion', 'verified-token');
    expect(requests[0].redirect).toBe('error');
  });
  it.each([
    [403, 3],
    [401, 2],
    [503, 2],
  ])(
    'maps HTTP status %i to exit code %i without echoing response content',
    async (status, code) => {
      const lines: string[] = [];
      const load: typeof fetch = () =>
        Promise.resolve(new Response('SECRET_SERVER_ERROR', { status }));
      expect(
        await runGovernance(
          ['holds', '--url', 'http://127.0.0.1:8084'],
          {
            write: (line) => {
              lines.push(line);
            },
          },
          { fetch: load },
        ),
      ).toBe(code);
      expect(lines.join('')).not.toContain('SECRET_SERVER_ERROR');
    },
  );
  it('network failures produce a controlled error', async () => {
    const lines: string[] = [];
    const load: typeof fetch = () => Promise.reject(new Error('SECRET_INTERNAL_ERROR'));
    expect(
      await runGovernance(
        ['holds', '--url', 'http://127.0.0.1:8084'],
        {
          write: (line) => {
            lines.push(line);
          },
        },
        { fetch: load },
      ),
    ).toBe(2);
    expect(lines.join('')).not.toContain('SECRET_INTERNAL_ERROR');
  });
});
