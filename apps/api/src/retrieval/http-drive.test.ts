import { inspect } from 'node:util';

import { IAP_ASSERTION_HEADER } from '@agent-works/domain';
import { createDrive, listen } from '@agent-works/fakes';
import { afterEach, beforeAll, afterAll, describe, expect, it } from 'vitest';

import { RetrievalError } from './drive-port.js';
import { startFakeCallers } from './fake-caller.js';
import { DriveFault, createHttpDrive } from './http-drive.js';

import type { FakeCallers } from './fake-caller.js';
import type { Caller } from '../auth/iap.js';

const group = 'agent-users@company.example';
const bobTitle = 'Bob private notes';
const titleWindow = 'Bob p';

type Closer = () => Promise<void>;
const closers: Closer[] = [];
let callers: FakeCallers;
let alice: Caller;
let bob: Caller;

beforeAll(async () => {
  callers = await startFakeCallers();
  alice = await callers.as('alice');
  bob = await callers.as('bob');
});
afterAll(async () => {
  await callers.close();
});
afterEach(async () => {
  for (const close of closers.splice(0).reverse()) await close();
});

async function serve(handler: Parameters<typeof listen>[0]): Promise<string> {
  const server = await listen(handler, 0);
  closers.push(server.close);
  return server.url;
}

function scriptedDirectory() {
  const groups = new Map<string, string[]>([
    ['alice', [group]],
    ['bob', [group]],
  ]);
  let observed = '2026-01-01T00:00:00.000Z';
  const url = serve((request) => {
    const sub = request.url.pathname.split('/').pop() ?? '';
    const found = groups.get(sub);
    if (found === undefined) return { status: 404, body: {} };
    return { status: 200, body: { sub, groups: found, observedAt: observed } };
  });
  return {
    url,
    revoke(sub: string, name: string) {
      groups.set(
        sub,
        (groups.get(sub) ?? []).filter((item) => item !== name),
      );
      observed = '2026-01-01T00:01:00.000Z';
    },
  };
}

async function stack() {
  const directory = scriptedDirectory();
  const directoryUrl = await directory.url;
  const driveUrl = await serve(createDrive(directoryUrl));
  return {
    directory,
    directoryUrl,
    driveUrl,
    http: createHttpDrive({ baseUrl: driveUrl, directoryUrl }),
  };
}

const titles = (sources: readonly { title: string }[]) => sources.map((source) => source.title);
const dump = (error: unknown) => inspect(error, { depth: null, showHidden: true });

describe('retrieve as the calling user', () => {
  it('keeps citing the triage runbook for Alice when no directory is wired', async () => {
    const driveUrl = await serve(createDrive());
    const sources = await createHttpDrive({ baseUrl: driveUrl }).retrieve(
      alice,
      'What are the triage runbook steps?',
    );
    expect(sources).toEqual([
      {
        id: 'alice-runbook',
        title: 'Triage runbook',
        text: 'Alice triage steps.',
        uri: 'https://drive.fake.test/d/alice-runbook',
      },
    ]);
    expect(
      titles(await createHttpDrive({ baseUrl: driveUrl }).retrieve(alice, 'benefits')),
    ).toEqual([]);
  });

  it('never returns Bob private notes to Alice, even from a Drive that ignores identity', async () => {
    const { driveUrl, directoryUrl } = await stack();
    const aliceDocs = (await (
      await fetch(`${driveUrl}/documents`, { headers: { [IAP_ASSERTION_HEADER]: alice.assertion } })
    ).json()) as unknown[];
    const bobDocs = (await (
      await fetch(`${driveUrl}/documents`, { headers: { [IAP_ASSERTION_HEADER]: bob.assertion } })
    ).json()) as unknown[];
    const leakyUrl = await serve(() => ({ status: 200, body: [...aliceDocs, ...bobDocs] }));
    const leaky = createHttpDrive({ baseUrl: leakyUrl, directoryUrl });
    expect(titles(await leaky.retrieve(alice, 'Bob salary notes'))).toEqual([]);
    expect(titles(await leaky.retrieve(bob, 'Bob salary notes'))).toEqual([bobTitle]);
  });

  it('drops the group document after revocation even when Drive still serves it', async () => {
    const { directory, driveUrl, directoryUrl, http } = await stack();
    const before = await http.retrieve(alice, 'benefits coverage guide');
    expect(titles(before)).toEqual(['Shared benefits guide']);
    const stale = (await (
      await fetch(`${driveUrl}/documents`, { headers: { [IAP_ASSERTION_HEADER]: alice.assertion } })
    ).json()) as unknown[];
    directory.revoke('alice', group);
    expect(await http.retrieve(alice, 'benefits coverage guide')).toEqual([]);
    const staleUrl = await serve(() => ({ status: 200, body: stale }));
    const staleDrive = createHttpDrive({ baseUrl: staleUrl, directoryUrl });
    expect(await staleDrive.retrieve(alice, 'benefits coverage guide')).toEqual([]);
    expect(titles(await staleDrive.retrieve(alice, 'triage runbook'))).toEqual(['Triage runbook']);
  });

  it('opens a scope whose port answers for exactly that caller', async () => {
    const { http } = await stack();
    const scope = await http.open(alice);
    expect(scope.context.userSubject).toBe('alice');
    expect(scope.context.authorizedGroups).toEqual([group]);
    const hits = await scope.port.search(scope.context, 'triage');
    expect(hits.map((hit) => hit.title)).toEqual(['Triage runbook']);
    await expect(
      scope.port.search({ ...scope.context, userSubject: 'bob' }, 'Bob'),
    ).rejects.toThrow('belongs to another caller');
  });
});

describe('drive failures never carry a title', () => {
  const failures: readonly (readonly [string, Parameters<typeof listen>[0], string])[] = [
    ['status with a body', () => ({ status: 500, body: `forbidden: ${bobTitle}` }), 'drive status'],
    [
      'body that is not json',
      () => ({ status: 200, body: `${bobTitle} is not json` }),
      'drive body',
    ],
    [
      'truncated json',
      () => ({ status: 200, body: `[{"title":"${bobTitle}","text":` }),
      'drive body',
    ],
    ['wrong shape', () => ({ status: 200, body: [{ id: 1, title: bobTitle }] }), 'drive shape'],
    [
      'unsafe link',
      () => ({
        status: 200,
        body: [
          {
            id: 'x',
            folder: 'alice',
            title: bobTitle,
            text: 't',
            webViewLink: 'javascript:alert(1)',
          },
        ],
      }),
      'drive shape',
    ],
  ];
  for (const [name, handler, kind] of failures) {
    it(`for ${name}`, async () => {
      const url = await serve(handler);
      const error = await createHttpDrive({ baseUrl: url })
        .retrieve(alice, 'notes')
        .catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(RetrievalError);
      expect(error).toMatchObject({ kind, message: kind });
      expect((error as Error).cause).toBeUndefined();
      expect(dump(error)).not.toContain(titleWindow);
    });
  }

  it('for an unreachable drive', async () => {
    const url = await serve(() => ({ status: 200, body: [] }));
    await closers.pop()?.();
    const error = await createHttpDrive({ baseUrl: url })
      .retrieve(alice, 'notes')
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(DriveFault);
    expect(error).toMatchObject({ kind: 'drive unreachable' });
  });

  it('for a drive that never answers', async () => {
    const url = await serve(() => new Promise(() => undefined));
    const started = Date.now();
    const error = await createHttpDrive({ baseUrl: url, timeoutMs: 50 })
      .retrieve(alice, 'notes')
      .catch((caught: unknown) => caught);
    expect(error).toMatchObject({ kind: 'drive timeout' });
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it('treats an unknown directory user as no groups', async () => {
    const driveUrl = await serve(createDrive());
    const directoryUrl = await serve(() => ({ status: 404, body: { error: bobTitle } }));
    const http = createHttpDrive({ baseUrl: driveUrl, directoryUrl });
    expect(titles(await http.retrieve(alice, 'benefits'))).toEqual([]);
    expect(titles(await http.retrieve(alice, 'triage runbook'))).toEqual(['Triage runbook']);
    const error = await createHttpDrive({
      baseUrl: await serve(() => ({ status: 500, body: bobTitle })),
      directoryUrl,
    })
      .retrieve(alice, 'notes')
      .catch((caught: unknown) => caught);
    expect(dump(error)).not.toContain(bobTitle);
  });

  it('for a directory that names someone else', async () => {
    const driveUrl = await serve(createDrive());
    const directoryUrl = await serve(() => ({
      status: 200,
      body: { sub: 'bob', groups: [group], observedAt: '2026-01-01T00:00:00.000Z' },
    }));
    const error = await createHttpDrive({ baseUrl: driveUrl, directoryUrl })
      .retrieve(alice, 'notes')
      .catch((caught: unknown) => caught);
    expect(error).toMatchObject({ kind: 'directory identity' });
  });
});
