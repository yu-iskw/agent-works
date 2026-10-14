import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { expect, test, vi } from 'vitest';

import { runAdmin } from './admin.js';
import { run } from './run.js';

test.each(['list', 'history'])(
  'aw admin %s forwards assertion without accepting client roles',
  async (sub) => {
    const load = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ events: [] }));
    const write = vi.fn();
    expect(
      await runAdmin(
        ['node', 'aw', 'admin', sub, '--url', 'http://localhost:8084'],
        { write },
        { fetch: load, assertion: 'signed' },
      ),
    ).toBe(0);
    expect(load).toHaveBeenCalledWith(
      new URL(
        sub === 'list'
          ? 'http://localhost:8084/v1/admin/suspensions'
          : 'http://localhost:8084/v1/admin/history',
      ),
      expect.objectContaining({
        method: 'GET',
        headers: { 'content-type': 'application/json', 'x-goog-iap-jwt-assertion': 'signed' },
      }),
    );
    expect(write).toHaveBeenCalledOnce();
  },
);
test.each(['suspend', 'resume', 'version'])(
  '%s requires explicit confirmation before any network call',
  async (sub) => {
    const load = vi.fn<typeof fetch>();
    expect(
      await runAdmin(
        ['node', 'aw', 'admin', sub, 'command.json', '--url', 'http://localhost'],
        { write: () => {} },
        { fetch: load },
      ),
    ).toBe(1);
    expect(load).not.toHaveBeenCalled();
  },
);
test('suspend command file is sent exactly as reviewed', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'aw-admin-'));
  const file = join(directory, 'command.json');
  const command = {
    action: 'suspend',
    target: { scope: 'global', id: '*', version: null },
    reason: 'Stop',
  };
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- disposable command fixture
  writeFileSync(file, JSON.stringify(command));
  const load = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ replay: false }));
  try {
    expect(
      await runAdmin(
        ['node', 'aw', 'admin', 'suspend', file, '--confirm', '--url', 'http://localhost'],
        { write: () => {} },
        { fetch: load },
      ),
    ).toBe(0);
    expect(load).toHaveBeenCalledWith(
      new URL('http://localhost/v1/admin/suspensions'),
      expect.objectContaining({ method: 'POST', body: JSON.stringify(command), redirect: 'error' }),
    );
  } finally {
    rmSync(directory, { recursive: true });
  }
});
test.each([403, 409, 503])('HTTP %s is a controlled non-zero result', async (status) => {
  const write = vi.fn();
  expect(
    await runAdmin(
      ['node', 'aw', 'admin', 'list', '--url', 'http://localhost'],
      { write },
      { fetch: () => Promise.resolve(new Response(null, { status })) },
    ),
  ).toBe(status === 403 ? 3 : 2);
  expect(write).toHaveBeenCalledExactlyOnceWith(`Admin request failed (${status}).\n`);
});
test('network failure does not print bearer assertions or raw provider errors', async () => {
  const write = vi.fn();
  expect(
    await runAdmin(
      ['node', 'aw', 'admin', 'list', '--url', 'http://localhost'],
      { write },
      { assertion: 'secret', fetch: () => Promise.reject(new Error('secret')) },
    ),
  ).toBe(2);
  expect(write.mock.calls.flat().join('')).not.toContain('secret');
});
test('admin dispatch coexists with synchronous policy command', async () => {
  const write = vi.fn();
  expect(await run(['node', 'aw', 'admin', '--help'], { write })).toBe(0);
  expect(run(['node', 'aw', 'unknown'], { write })).toBe(1);
});
