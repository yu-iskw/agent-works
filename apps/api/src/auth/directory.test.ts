import { listen } from '@agent-works/fakes';
import { afterEach, describe, expect, it } from 'vitest';

import { createRoleResolver } from './directory.js';

import type { AppRole } from './directory.js';

const users = 'agent-users@company.example';
const reviewers = 'agent-reviewers@company.example';
const admins = 'agent-admins@company.example';
const observedAt = '2026-01-01T00:00:00.000Z';
const observedMs = Date.parse(observedAt);
const fiveMinutesMs = 300_000;

type Handler = Parameters<typeof listen>[0];

describe('createRoleResolver', () => {
  const closers: (() => Promise<void>)[] = [];

  afterEach(async () => {
    const open = closers.splice(0);
    for (const close of open) await close();
  });

  async function serve(handler: Handler): Promise<string> {
    const server = await listen(handler, 0);
    closers.push(server.close);
    return server.url;
  }

  async function rolesFor(
    sub: string,
    body: unknown,
    nowMs: number,
    status = 200,
  ): Promise<readonly AppRole[]> {
    const baseUrl = await serve(() => ({ status, body }));
    return createRoleResolver({ baseUrl, now: () => nowMs })(sub);
  }

  it('maps the agent-users group to Employee when the snapshot is fresh', async () => {
    const body = { sub: 'bob', groups: [users], observedAt };
    await expect(rolesFor('bob', body, observedMs)).resolves.toEqual(['Employee']);
  });

  it('maps each role group and ignores order, duplicates, and unknown groups', async () => {
    const body = {
      sub: 'alice',
      groups: [admins, 'other@company.example', users, admins, reviewers],
      observedAt,
    };
    await expect(rolesFor('alice', body, observedMs)).resolves.toEqual([
      'Employee',
      'Reviewer',
      'Admin',
    ]);
  });

  it('does not infer lower roles from the admin group', async () => {
    const body = { sub: 'alice', groups: [admins], observedAt };
    await expect(rolesFor('alice', body, observedMs)).resolves.toEqual(['Admin']);
  });

  it('matches group addresses exactly', async () => {
    const body = { sub: 'bob', groups: [users.toUpperCase()], observedAt };
    await expect(rolesFor('bob', body, observedMs)).resolves.toEqual([]);
  });

  it('returns no roles after a revocation drops the group, even when fresh', async () => {
    const body = { sub: 'bob', groups: [], observedAt: '2026-01-01T00:01:00.000Z' };
    await expect(rolesFor('bob', body, observedMs + 60_000)).resolves.toEqual([]);
  });

  describe('freshness', () => {
    const body = { sub: 'bob', groups: [users], observedAt };

    it('accepts a snapshot exactly five minutes old', async () => {
      await expect(rolesFor('bob', body, observedMs + fiveMinutesMs)).resolves.toEqual([
        'Employee',
      ]);
    });

    it('rejects a snapshot one millisecond past five minutes', async () => {
      await expect(rolesFor('bob', body, observedMs + fiveMinutesMs + 1)).resolves.toEqual([]);
    });

    it('accepts a snapshot stamped 30 seconds ahead of the local clock', async () => {
      await expect(rolesFor('bob', body, observedMs - 30_000)).resolves.toEqual(['Employee']);
    });

    it('rejects a snapshot stamped more than 30 seconds ahead of the local clock', async () => {
      await expect(rolesFor('bob', body, observedMs - 30_001)).resolves.toEqual([]);
    });

    it('reads the wall clock by default', async () => {
      const current = await serve(() => ({
        status: 200,
        body: { sub: 'bob', groups: [users], observedAt: new Date().toISOString() },
      }));
      await expect(createRoleResolver({ baseUrl: current })('bob')).resolves.toEqual(['Employee']);
      const seeded = await serve(() => ({ status: 200, body }));
      await expect(createRoleResolver({ baseUrl: seeded })('bob')).resolves.toEqual([]);
    });
  });

  describe('failing closed', () => {
    const good = { sub: 'bob', groups: [users], observedAt };

    it.each([
      ['unknown subject', 404, { error: 'not found' }],
      ['directory error', 500, { error: 'boom' }],
      ['not an object', 200, 'ok'],
      ['groups is not a list', 200, { sub: 'bob', groups: users, observedAt }],
      ['a group is not a string', 200, { sub: 'bob', groups: [1], observedAt }],
      ['observedAt is not a date', 200, { sub: 'bob', groups: [users], observedAt: 'yesterday' }],
      [
        'observedAt carries an offset',
        200,
        { sub: 'bob', groups: [users], observedAt: '2026-01-01T09:00:00.000+09:00' },
      ],
      ['observedAt is missing', 200, { sub: 'bob', groups: [users] }],
      ['the snapshot belongs to another subject', 200, { ...good, sub: 'alice' }],
    ])('returns no roles when %s', async (_name, status, body) => {
      await expect(rolesFor('bob', body, observedMs, status)).resolves.toEqual([]);
    });

    it('returns no roles when the directory is unreachable', async () => {
      const server = await listen(() => ({ status: 200, body: good }), 0);
      await server.close();
      const resolve = createRoleResolver({ baseUrl: server.url, now: () => observedMs });
      await expect(resolve('bob')).resolves.toEqual([]);
    });

    it('returns no roles when the directory does not answer in time', async () => {
      const baseUrl = await serve(() => new Promise(() => undefined));
      const resolve = createRoleResolver({ baseUrl, now: () => observedMs, timeoutMs: 50 });
      await expect(resolve('bob')).resolves.toEqual([]);
    });

    it('returns no roles when the directory redirects', async () => {
      const target = await serve(() => ({ status: 200, body: good }));
      const baseUrl = await serve(() => ({
        status: 302,
        body: '',
        headers: { location: `${target}/snapshots/bob` },
      }));
      const resolve = createRoleResolver({ baseUrl, now: () => observedMs });
      await expect(resolve('bob')).resolves.toEqual([]);
    });
  });

  it('rejects a base URL that is not a URL when it is created', () => {
    expect(() => createRoleResolver({ baseUrl: 'directory' })).toThrow(TypeError);
  });

  it('asks for the subject as one encoded path segment', async () => {
    const seen: string[] = [];
    const baseUrl = await serve((request) => {
      seen.push(request.url.pathname);
      return { status: 404, body: {} };
    });
    await createRoleResolver({ baseUrl })('../revocations');
    expect(seen).toEqual(['/snapshots/..%2Frevocations']);
  });
});
