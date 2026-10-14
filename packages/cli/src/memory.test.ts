import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { runMemory } from './memory.js';
function output() {
  const lines: string[] = [];
  return {
    lines,
    write: (line: string) => {
      lines.push(line);
    },
  };
}
describe('aw memory CLI', () => {
  it('prints help without contacting services or printing assertions', async () => {
    const out = output();
    expect(await runMemory(['--help'], out, { assertion: 'SECRET' })).toBe(0);
    expect(out.lines.join('')).toContain('aw memory');
    expect(out.lines.join('')).not.toContain('SECRET');
  });
  it.each(['list', 'export', 'consent'])('reads %s with an authenticated request', async (sub) => {
    const out = output();
    const requests: { url: string; options: RequestInit }[] = [];
    const load: typeof fetch = (input, options) => {
      requests.push({
        url: input instanceof Request ? input.url : input.toString(),
        options: options ?? {},
      });
      return Promise.resolve(Response.json({ items: [] }));
    };
    expect(
      await runMemory([sub, '--url', 'http://api.local'], out, {
        assertion: 'trusted',
        fetch: load,
      }),
    ).toBe(0);
    expect(requests).toHaveLength(1);
    expect(requests[0].options.method).toBe('GET');
    expect(requests[0].options.headers).toMatchObject({ 'x-goog-iap-jwt-assertion': 'trusted' });
    expect(requests[0].options.redirect).toBe('error');
    expect(out.lines.join('')).toContain('items');
  });
  it.each(['ftp://api.local', 'not-a-url', 'http://user:pass@api.local'])(
    'rejects unsafe endpoint %s',
    async (url) => {
      const out = output();
      expect(await runMemory(['list', '--url', url], out)).toBe(1);
      expect(out.lines.join('')).toContain('valid --url');
    },
  );
  it('requires an endpoint and known command', async () => {
    expect(await runMemory(['list'], output())).toBe(1);
    expect(await runMemory(['unknown', '--url', 'http://api.local'], output())).toBe(1);
  });
  it.each([401, 403, 409, 503])('prints safe status for backend %s', async (status) => {
    const out = output();
    const code = await runMemory(['list', '--url', 'http://api.local'], out, {
      fetch: () => Promise.resolve(Response.json({ secret: 'PRIVATE_CONTENT' }, { status })),
    });
    expect(code).toBe(status === 403 ? 3 : 2);
    expect(out.lines.join('')).toContain(String(status));
    expect(out.lines.join('')).not.toContain('PRIVATE_CONTENT');
  });
  it('does not expose exception details or tokens', async () => {
    const out = output();
    expect(
      await runMemory(['list', '--url', 'http://api.local'], out, {
        assertion: 'SECRET',
        fetch: () => Promise.reject(new Error('SECRET_DATABASE_URI')),
      }),
    ).toBe(2);
    expect(out.lines.join('')).not.toContain('SECRET');
  });
  it('sends a reviewed consent file and rejects action mismatch', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'aw-memory-'));
    const file = join(dir, 'consent.json');
    try {
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- isolated temporary command fixture
      await writeFile(
        file,
        JSON.stringify({ enabled: true, revision: 0, noticeVersion: 'memory-v1' }),
      );
      const seen: unknown[] = [];
      const load: typeof fetch = (_input, options) => {
        seen.push(JSON.parse(typeof options?.body === 'string' ? options.body : '') as unknown);
        return Promise.resolve(Response.json({ consent: { enabled: true } }));
      };
      expect(
        await runMemory(['opt-in', file, '--url', 'http://api.local'], output(), { fetch: load }),
      ).toBe(0);
      expect(seen).toEqual([{ enabled: true, revision: 0, noticeVersion: 'memory-v1' }]);
      expect(
        await runMemory(['opt-out', file, '--url', 'http://api.local'], output(), { fetch: load }),
      ).toBe(2);
      expect(seen).toHaveLength(1);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
  it('mutation without a command file cannot contact the backend', async () => {
    let calls = 0;
    expect(
      await runMemory(['delete', '--url', 'http://api.local'], output(), {
        fetch: () => {
          calls++;
          return Promise.resolve(Response.json({}));
        },
      }),
    ).toBe(2);
    expect(calls).toBe(0);
  });
});
