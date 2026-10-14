import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { expect, test, vi } from 'vitest';

import { runSchedule } from './schedule.js';

import { run } from './index.js';
function output() {
  const lines: string[] = [];
  return {
    lines,
    write(value: string) {
      lines.push(value);
    },
  };
}
test.each(['list', 'history', 'triggers'])(
  'schedule %s uses GET and forwards the IAP assertion',
  async (command) => {
    const load = vi.fn<typeof fetch>(() => Promise.resolve(Response.json({ schedules: [] })));
    const stdout = output();
    expect(
      await runSchedule(['node', 'aw', 'schedule', command, '--url', 'http://api.local'], stdout, {
        fetch: load,
        assertion: 'verified',
      }),
    ).toBe(0);
    expect(load.mock.calls[0][1]).toMatchObject({
      method: 'GET',
      headers: { 'x-goog-iap-jwt-assertion': 'verified' },
      redirect: 'error',
    });
    expect(stdout.lines.join('')).toContain('schedules');
  },
);
test('help and argument validation avoid network', async () => {
  const stdout = output();
  expect(await runSchedule(['node', 'aw', 'schedule', '--help'], stdout)).toBe(0);
  expect(await runSchedule(['node', 'aw', 'schedule', 'invalid'], stdout)).toBe(1);
  expect(
    await runSchedule(['node', 'aw', 'schedule', 'list', '--url', 'file:///secret'], stdout),
  ).toBe(1);
});
test.each(['create', 'preview', 'trigger', 'pause', 'resume', 'revoke', 'runs'])(
  'schedule %s posts a command file',
  async (command) => {
    const dir = mkdtempSync(join(tmpdir(), 'schedule-cli-'));
    const file = join(dir, 'command.json');
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- isolated test command file
    writeFileSync(file, JSON.stringify({ id: 'schedule', action: command, expectedRevision: 1 }));
    const load = vi.fn<typeof fetch>(() => Promise.resolve(Response.json({ state: 'active' })));
    try {
      expect(
        await runSchedule(
          ['node', 'aw', 'schedule', command, file, '--url', 'http://api.local'],
          output(),
          { fetch: load },
        ),
      ).toBe(0);
      expect(load.mock.calls[0][1]?.method).toBe('POST');
      expect(load.mock.calls[0][1]?.body).toContain('schedule');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
);
test.each([401, 403, 409, 503])(
  'HTTP %s produces a failure exit code without printing tokens',
  async (status) => {
    const stdout = output();
    const code = await runSchedule(
      ['node', 'aw', 'schedule', 'list', '--url', 'http://api.local'],
      stdout,
      { assertion: 'secret-token', fetch: () => Promise.resolve(Response.json({}, { status })) },
    );
    expect(code).toBe(status === 403 ? 3 : 2);
    expect(stdout.lines.join('')).not.toContain('secret-token');
  },
);
test('CLI handles unreachable service and invalid command file', async () => {
  expect(
    await runSchedule(['node', 'aw', 'schedule', 'list', '--url', 'http://api.local'], output(), {
      fetch: () => Promise.reject(new Error('network')),
    }),
  ).toBe(2);
  expect(
    await runSchedule(['node', 'aw', 'schedule', 'create', '--url', 'http://api.local'], output()),
  ).toBe(2);
});
test('package dispatch reaches schedule command without changing policy explain', async () => {
  const stdout = output();
  expect(await run(['node', 'aw', 'schedule', '--help'], stdout)).toBe(0);
  expect(stdout.lines.join('')).toContain('aw schedule');
});
