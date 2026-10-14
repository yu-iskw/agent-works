import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { expect, test, vi } from 'vitest';

import { runSchedule } from './schedule.js';

function output() {
  const values: string[] = [];
  return {
    values,
    write(value: string) {
      values.push(value);
    },
  };
}

function commandFile(body: string) {
  const directory = mkdtempSync(join(tmpdir(), 'schedule-errors-'));
  const path = join(directory, 'command.json');
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- isolated test command file
  writeFileSync(path, body);
  return {
    path,
    close() {
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

test.each(['null', '[]', 'true', '"text"', 'not-json'])(
  'command file %s is rejected before network access',
  async (body) => {
    const file = commandFile(body);
    const load = vi.fn<typeof fetch>(() => Promise.resolve(Response.json({})));
    try {
      expect(
        await runSchedule(
          ['node', 'aw', 'schedule', 'create', file.path, '--url', 'http://api.local'],
          output(),
          { fetch: load },
        ),
      ).toBe(2);
      expect(load).not.toHaveBeenCalled();
    } finally {
      file.close();
    }
  },
);

test.each(['pause', 'resume', 'revoke'])(
  '%s command cannot send a conflicting action',
  async (command) => {
    const file = commandFile(JSON.stringify({ id: 'one', action: 'other', expectedRevision: 1 }));
    const load = vi.fn<typeof fetch>(() => Promise.resolve(Response.json({})));
    try {
      expect(
        await runSchedule(
          ['node', 'aw', 'schedule', command, file.path, '--url', 'http://api.local'],
          output(),
          { fetch: load },
        ),
      ).toBe(2);
      expect(load).not.toHaveBeenCalled();
    } finally {
      file.close();
    }
  },
);

test.each(['list', 'history', 'triggers'])(
  '%s command resolves the expected API route',
  async (command) => {
    const load = vi.fn<typeof fetch>(() => Promise.resolve(Response.json({})));
    expect(
      await runSchedule(['node', 'aw', 'schedule', command], output(), {
        apiUrl: 'https://api.local/base',
        fetch: load,
      }),
    ).toBe(0);
    const value = load.mock.calls[0][0];
    expect(value).toBeInstanceOf(URL);
    const path = new URL(value instanceof Request ? value.url : value.toString()).pathname;
    expect(path).toBe(command === 'list' ? '/v1/schedules' : `/v1/schedules/${command}`);
    expect(load.mock.calls[0][1]?.signal).toBeInstanceOf(AbortSignal);
  },
);

test('explicit URL overrides configured service URL', async () => {
  const load = vi.fn<typeof fetch>(() => Promise.resolve(Response.json({})));
  expect(
    await runSchedule(
      ['node', 'aw', 'schedule', 'list', '--url', 'https://chosen.local'],
      output(),
      { apiUrl: 'http://default.local', fetch: load },
    ),
  ).toBe(0);
  const input = load.mock.calls[0][0];
  expect(input instanceof Request ? input.url : input.toString()).toBe(
    'https://chosen.local/v1/schedules',
  );
});

test.each(['file:///tmp/config', 'ftp://api.local', 'not a URL', ''])(
  'URL %s is rejected without invoking fetch',
  async (url) => {
    const load = vi.fn<typeof fetch>(() => Promise.resolve(Response.json({})));
    expect(
      await runSchedule(['node', 'aw', 'schedule', 'list', '--url', url], output(), {
        fetch: load,
      }),
    ).toBe(1);
    expect(load).not.toHaveBeenCalled();
  },
);

test('malformed successful response fails without printing its body', async () => {
  const stdout = output();
  expect(
    await runSchedule(['node', 'aw', 'schedule', 'list', '--url', 'https://api.local'], stdout, {
      fetch: () => Promise.resolve(new Response('secret-canary')),
    }),
  ).toBe(2);
  expect(stdout.values.join('')).not.toContain('secret-canary');
});

test('service rejection does not print a diagnostic response body or assertion', async () => {
  const stdout = output();
  expect(
    await runSchedule(['node', 'aw', 'schedule', 'list', '--url', 'https://api.local'], stdout, {
      assertion: 'assertion-canary',
      fetch: () => Promise.resolve(Response.json({ token: 'body-canary' }, { status: 403 })),
    }),
  ).toBe(3);
  expect(stdout.values.join('')).toContain('403');
  expect(stdout.values.join('')).not.toContain('assertion-canary');
  expect(stdout.values.join('')).not.toContain('body-canary');
});
