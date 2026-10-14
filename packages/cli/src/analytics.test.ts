import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { runAnalytics } from './analytics.js';
const directories: string[] = [];
afterEach(() => {
  for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function output() {
  const write = vi.fn();
  return { write };
}
function commandFile(value: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), 'analytics-cli-'));
  directories.push(dir);
  const path = join(dir, 'command.json');
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- isolated test temporary directory
  writeFileSync(path, JSON.stringify(value));
  return path;
}
describe('aw analytics', () => {
  it('shows help without a network call', async () => {
    const stdout = output();
    expect(await runAnalytics(['--help'], stdout)).toBe(0);
    expect(stdout.write).toHaveBeenCalledWith(expect.stringContaining('aw analytics'));
  });
  it('lists metrics with the trusted IAP assertion', async () => {
    const load = vi.fn<typeof fetch>(() =>
      Promise.resolve(new Response(JSON.stringify({ metrics: [] }))),
    );
    expect(
      await runAnalytics(['metrics', '--url', 'http://127.0.0.1:8084'], output(), {
        fetch: load,
        assertion: 'token',
      }),
    ).toBe(0);
    expect(load).toHaveBeenCalledWith(
      new URL('http://127.0.0.1:8084/v1/analytics/metrics'),
      expect.objectContaining({
        method: 'GET',
        redirect: 'error',
        headers: { 'content-type': 'application/json', 'x-goog-iap-jwt-assertion': 'token' },
      }),
    );
  });
  it.each(['query', 'save', 'rerun'])('sends a reviewed JSON %s command', async (command) => {
    const file = commandFile({ versionId: 'version', maxBytes: 1000 });
    const load = vi.fn<typeof fetch>(() => Promise.resolve(new Response('{}')));
    expect(
      await runAnalytics(
        [command, file, '--confirm', '--url', 'https://api.example.invalid'],
        output(),
        { fetch: load },
      ),
    ).toBe(0);
    expect(load.mock.calls[0][1]?.body).toBe(
      JSON.stringify({ versionId: 'version', maxBytes: 1000 }),
    );
  });
  it('requires confirmation for report validation', async () => {
    const load = vi.fn<typeof fetch>();
    expect(
      await runAnalytics(['save', '--url', 'https://api.example.invalid'], output(), {
        fetch: load,
      }),
    ).toBe(1);
    expect(load).not.toHaveBeenCalled();
  });
  it.each([
    'http://remote.example.invalid',
    'ftp://127.0.0.1',
    'https://user:secret@example.invalid',
  ])('rejects unsafe endpoint %s', async (url) => {
    const load = vi.fn<typeof fetch>();
    expect(await runAnalytics(['metrics', '--url', url], output(), { fetch: load })).toBe(2);
    expect(load).not.toHaveBeenCalled();
  });
  it('returns distinct forbidden status without printing server body', async () => {
    const stdout = output();
    expect(
      await runAnalytics(['metrics', '--url', 'http://localhost:8084'], stdout, {
        fetch: () => Promise.resolve(new Response('secret error', { status: 403 })),
      }),
    ).toBe(3);
    expect(stdout.write).toHaveBeenCalledWith('Analytics request failed (403).\n');
  });
  it('does not expose a transport error', async () => {
    const stdout = output();
    expect(
      await runAnalytics(['metrics', '--url', 'https://api.example.invalid'], stdout, {
        fetch: () => Promise.reject(new Error('secret')),
      }),
    ).toBe(2);
    expect(stdout.write).not.toHaveBeenCalledWith(expect.stringContaining('secret'));
  });
  it('rejects a missing command file before sending', async () => {
    const load = vi.fn<typeof fetch>();
    expect(
      await runAnalytics(['query', '--url', 'http://localhost:8084'], output(), { fetch: load }),
    ).toBe(2);
    expect(load).not.toHaveBeenCalled();
  });
});
