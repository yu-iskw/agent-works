import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it, vi } from 'vitest';
import * as z from 'zod';

import { createDriveAdapter, DelegatedDriveError } from './drive-adapter.js';

import type { DelegatedCredential, DriveAdapterOptions } from './drive-adapter.js';
import type { Caller } from '../auth/iap.js';
import type { SearchContext } from '@agent-works/domain';

function requestUrl(input: Parameters<typeof fetch>[0]): URL {
  return new URL(input instanceof Request ? input.url : input);
}

const at = Date.parse('2026-10-13T00:00:00Z');
const alice = { sub: 'alice', assertion: 'FAKE_REDACTED_IAP' } as Caller;
const context: SearchContext = {
  userSubject: 'alice',
  enterpriseId: 'agent-works',
  authorizedGroups: ['reviewers'],
  groupsObservedAt: '2026-10-13T00:00:00Z',
  allowedSources: ['drive'],
  taskPurpose: 'ask',
  classificationCeiling: 'INTERNAL',
  allowedRegions: ['asia-northeast1'],
  resultCountLimit: 100,
};
const credential: DelegatedCredential = {
  kind: 'user-delegated',
  callerSubject: 'alice',
  googleSubject: 'alice',
  accessToken: 'FAKE_REDACTED_DELEGATED',
  expiresAt: at + 60_000,
  scopes: ['https://www.googleapis.com/auth/drive.readonly'],
  identityVerified: true,
  domainWideDelegation: false,
};
const policy = {
  enterpriseId: 'agent-works',
  classification: 'INTERNAL',
  region: 'asia-northeast1',
} as const;
const metadata = {
  id: 'alice-private',
  name: 'C04_ALICE_TITLE',
  mimeType: 'application/vnd.google-apps.document',
  version: '1',
  trashed: false,
  capabilities: { canDownload: true },
};

function options(patch: Partial<DriveAdapterOptions> = {}): DriveAdapterOptions {
  return {
    caller: alice,
    credentialFor: () => Promise.resolve(credential),
    policyFor: () => Promise.resolve(policy),
    now: () => at,
    fetch: vi.fn<typeof fetch>().mockResolvedValue(Response.json({ files: [] })),
    ...patch,
  };
}
function responses(bodies: readonly unknown[]) {
  let index = 0;
  return vi.fn<typeof fetch>().mockImplementation(() => {
    const body = bodies[index++];
    if (body instanceof Response) return Promise.resolve(body);
    if (typeof body === 'string') return Promise.resolve(new Response(body));
    return Promise.resolve(Response.json(body));
  });
}
function successful() {
  return responses([{ files: [{ id: 'alice-private' }] }, metadata, 'C04_ALICE_CONTENT', metadata]);
}

const recordingSchema = z.object({
  scenario: z.string(),
  caller: z.string(),
  expectedIds: z.array(z.string()),
  expectedError: z.string().nullable(),
  exchanges: z.array(
    z.object({
      operation: z.string(),
      objectId: z.string().nullable(),
      status: z.number(),
      body: z.unknown(),
    }),
  ),
});
const fixtureRoot = new URL('../../../../spikes/retrieval/drive/fixtures/', import.meta.url);
const recordings = readdirSync(fixtureRoot)
  .filter(
    (name) =>
      name.endsWith('.json') && name !== 'evidence.json' && !name.endsWith('.transcript.json'),
  )
  .sort((a, b) => a.localeCompare(b))
  .map((name) => {
    const raw: unknown = JSON.parse(readFileSync(new URL(name, fixtureRoot), 'utf8'));
    return recordingSchema.parse(raw);
  });

describe('caller-delegated Drive adapter recordings', () => {
  it.each(recordings)('$scenario', async (recording) => {
    const queue = [...recording.exchanges];
    const load = vi.fn<typeof fetch>().mockImplementation((input, init) => {
      const step = queue.shift();
      if (!step) throw new Error('unexpected request');
      const url = requestUrl(input);
      expect(url.origin).toBe('https://www.googleapis.com');
      expect(new Headers(init?.headers).get('authorization')).toBe(
        'Bearer FAKE_REDACTED_DELEGATED',
      );
      expect(init?.redirect).toBe('error');
      const operation =
        url.pathname === '/drive/v3/files'
          ? 'list'
          : url.pathname.endsWith('/export') || url.searchParams.get('alt') === 'media'
            ? 'content'
            : 'metadata';
      expect(operation).toBe(step.operation);
      if (step.objectId) expect(url.pathname).toContain(`/${step.objectId}`);
      return Promise.resolve(
        typeof step.body === 'string'
          ? new Response(step.body, { status: step.status })
          : Response.json(step.body, { status: step.status }),
      );
    });
    const caller = { sub: recording.caller, assertion: 'FAKE_REDACTED_IAP' } as Caller;
    const events: unknown[] = [];
    const adapter = createDriveAdapter(
      options({
        caller,
        fetch: load,
        onAccess: (event) => events.push(event),
        credentialFor: () =>
          Promise.resolve({ ...credential, callerSubject: caller.sub, googleSubject: caller.sub }),
      }),
    );
    const result = adapter.search({ ...context, userSubject: caller.sub }, 'bundle-b-corpus');
    if (recording.expectedError) {
      await expect(result).rejects.toMatchObject({ code: recording.expectedError });
    } else {
      const hits = await result;
      expect(hits.map((hit) => hit.sourceObjectId)).toEqual(recording.expectedIds);
      // Every denied case includes all three forbidden markers in the upstream error.
      if (recording.expectedIds.length === 0) {
        expect(JSON.stringify(hits)).not.toMatch(/C04_(?:ALICE|BOB)_(?:TITLE|SNIPPET|CONTENT)/);
      }
      for (const hit of hits) {
        expect(hit.etag).toBe('1');
        expect(hit.accessDecisionId).toMatch(/^drive-delegated:[a-f0-9]{64}$/);
        expect(hit.retrievedAt).toBe('2026-10-13T00:00:00.000Z');
        expect(hit.sourceUri).toContain(hit.sourceObjectId);
      }
    }
    expect(queue).toHaveLength(0);
    expect(JSON.stringify(events)).not.toMatch(/C04_|FAKE_REDACTED|Bearer/);
  });
});

describe('delegated credential boundary', () => {
  it.each([
    ['missing', undefined],
    ['null', null],
    ['expired', { ...credential, expiresAt: at }],
    ['NaN expiry', { ...credential, expiresAt: Number.NaN }],
    ['empty token', { ...credential, accessToken: '' }],
    ['header injection', { ...credential, accessToken: 'bad\r\nvalue' }],
    ['blanket', { ...credential, kind: 'blanket' }],
    ['service account', { ...credential, kind: 'service-account' }],
    ['domain wide delegation', { ...credential, domainWideDelegation: true }],
    ['unverified identity', { ...credential, identityVerified: false }],
    ['another caller', { ...credential, callerSubject: 'bob' }],
    ['another Google user', { ...credential, googleSubject: 'bob' }],
    ['service principal', { ...credential, googleSubject: 'agent@example.gserviceaccount.com' }],
    [
      'metadata only scope',
      { ...credential, scopes: ['https://www.googleapis.com/auth/drive.metadata.readonly'] },
    ],
    ['undeclared grant fields', { ...credential, impersonate: 'alice' }],
  ])('rejects %s before calling Drive', async (_name, supplied) => {
    const load = vi.fn<typeof fetch>();
    const adapter = createDriveAdapter(
      options({ fetch: load, credentialFor: () => Promise.resolve(supplied) }),
    );
    await expect(adapter.search(context, 'bundle-b')).rejects.toMatchObject({ code: 'credential' });
    expect(load).not.toHaveBeenCalled();
  });

  it('fails closed when the credential store is unavailable without echoing the token', async () => {
    const adapter = createDriveAdapter(
      options({ credentialFor: () => Promise.reject(new Error('FAKE_SECRET')) }),
    );
    await expect(adapter.search(context, 'bundle-b')).rejects.toThrow(
      'delegated Drive retrieval denied: credential',
    );
  });

  it('rejects a context belonging to a different caller', async () => {
    const supplied = vi.fn().mockResolvedValue(credential);
    await expect(
      createDriveAdapter(options({ credentialFor: supplied })).search(
        { ...context, userSubject: 'bob' },
        'bundle-b',
      ),
    ).rejects.toMatchObject({ code: 'identity' });
    expect(supplied).not.toHaveBeenCalled();
  });

  it('rejects an invalid context and empty authenticated assertion', async () => {
    await expect(
      createDriveAdapter(options()).search({ ...context, resultCountLimit: 0 }, 'bundle-b'),
    ).rejects.toMatchObject({ code: 'identity' });
    await expect(
      createDriveAdapter(options({ caller: { ...alice, assertion: '' } })).search(
        context,
        'bundle-b',
      ),
    ).rejects.toMatchObject({ code: 'identity' });
  });

  it('rechecks credentials on each search after token revocation', async () => {
    const store = vi.fn().mockResolvedValueOnce(credential).mockResolvedValueOnce(undefined);
    const adapter = createDriveAdapter(options({ credentialFor: store }));
    await expect(adapter.search(context, 'bundle-b')).resolves.toEqual([]);
    await expect(adapter.search(context, 'bundle-b')).rejects.toMatchObject({ code: 'credential' });
    expect(store).toHaveBeenCalledTimes(2);
  });

  it('rejects expiry between the listing and the metadata fetch', async () => {
    let clock = at;
    const load = vi.fn<typeof fetch>().mockImplementation(() => {
      clock = at + 60_001;
      return Promise.resolve(Response.json({ files: [{ id: 'alice-private' }] }));
    });
    await expect(
      createDriveAdapter(options({ fetch: load, now: () => clock })).search(context, 'bundle-b'),
    ).rejects.toMatchObject({ code: 'credential' });
    expect(load).toHaveBeenCalledTimes(1);
  });
});

describe('source policy and response safety', () => {
  it.each([
    undefined,
    { ...policy, enterpriseId: 'other' },
    { ...policy, region: 'us' },
    { ...policy, classification: 'RESTRICTED' as const },
  ])('omits all document surfaces when inventory denies the source', async (documentPolicy) => {
    const load = responses([{ files: [{ id: 'alice-private' }] }, metadata]);
    const adapter = createDriveAdapter(
      options({ fetch: load, policyFor: () => Promise.resolve(documentPolicy) }),
    );
    await expect(adapter.search(context, 'bundle-b')).resolves.toEqual([]);
    expect(load).toHaveBeenCalledTimes(2);
  });

  it('fails closed on policy lookup errors', async () => {
    const load = responses([{ files: [{ id: 'alice-private' }] }, metadata]);
    const adapter = createDriveAdapter(
      options({ fetch: load, policyFor: () => Promise.reject(new Error('offline')) }),
    );
    await expect(adapter.search(context, 'bundle-b')).rejects.toMatchObject({ code: 'policy' });
  });

  it('returns no results for excluded source or empty query without a token', async () => {
    const supplied = vi.fn().mockResolvedValue(undefined);
    const adapter = createDriveAdapter(options({ credentialFor: supplied }));
    await expect(adapter.search({ ...context, allowedSources: [] }, 'bundle-b')).resolves.toEqual(
      [],
    );
    await expect(adapter.search(context, ' ')).resolves.toEqual([]);
    expect(supplied).not.toHaveBeenCalled();
  });

  it('fetches plaintext media and constructs its source URI without trusting web links', async () => {
    const plain = {
      ...metadata,
      mimeType: 'text/plain',
      webViewLink: 'https://evil.example/FAKE_SECRET',
    };
    const load = responses([{ files: [{ id: 'alice-private' }] }, plain, 'content', plain]);
    const hits = await createDriveAdapter(options({ fetch: load })).search(context, 'bundle-b');
    expect(hits[0].sourceUri).toBe('https://drive.google.com/file/d/alice-private/view');
    expect(requestUrl(load.mock.calls[2][0]).toString()).toContain('alt=media');
  });

  it('does not cache a previous result across a source permission revoke', async () => {
    const load = responses([
      { files: [{ id: 'alice-private' }] },
      metadata,
      'C04_ALICE_CONTENT',
      metadata,
      { files: [{ id: 'alice-private' }] },
      new Response('C04_ALICE_TITLE', { status: 403 }),
    ]);
    const adapter = createDriveAdapter(options({ fetch: load }));
    expect(await adapter.search(context, 'bundle-b')).toHaveLength(1);
    await expect(adapter.search(context, 'bundle-b')).resolves.toEqual([]);
  });

  it('rechecks classification after reading content', async () => {
    const inventory = vi
      .fn()
      .mockResolvedValueOnce(policy)
      .mockResolvedValueOnce({ ...policy, classification: 'RESTRICTED' });
    await expect(
      createDriveAdapter(options({ fetch: successful(), policyFor: inventory })).search(
        context,
        'bundle-b',
      ),
    ).resolves.toEqual([]);
  });

  it('rejects malformed and mismatched provenance metadata', async () => {
    const load = responses([
      { files: [{ id: 'alice-private' }] },
      { ...metadata, id: 'bob-private' },
    ]);
    await expect(
      createDriveAdapter(options({ fetch: load })).search(context, 'bundle-b'),
    ).rejects.toMatchObject({ code: 'response' });
  });

  it('does not return partial results after an upstream failure', async () => {
    const load = responses([
      { files: [{ id: 'alice-private' }, { id: 'bob-private' }] },
      metadata,
      'content',
      metadata,
      new Response('C04_BOB_TITLE', { status: 503 }),
    ]);
    await expect(
      createDriveAdapter(options({ fetch: load })).search(context, 'bundle-b'),
    ).rejects.toMatchObject({ code: 'transport' });
  });

  it('bounds result count and request size', async () => {
    const adapter = createDriveAdapter(options());
    await expect(adapter.search(context, 'x'.repeat(4097))).rejects.toMatchObject({
      code: 'limit',
    });
    await expect(adapter.search({ ...context, resultCountLimit: 101 }, 'x')).rejects.toMatchObject({
      code: 'limit',
    });
  });

  it('bounds response bytes', async () => {
    const load = successful();
    await expect(
      createDriveAdapter(options({ fetch: load, maxContentBytes: 2 })).search(context, 'bundle-b'),
    ).rejects.toMatchObject({ code: 'limit' });
  });

  it('escapes Drive fullText query values', async () => {
    const load = responses([{ files: [] }]);
    await createDriveAdapter(options({ fetch: load })).search(context, "quote'back\\slash");
    expect(requestUrl(load.mock.calls[0][0]).searchParams.get('q')).toBe(
      "trashed = false and fullText contains 'quote\\'back\\\\slash'",
    );
    expect(requestUrl(load.mock.calls[0][0]).searchParams.get('fields')).toBe(
      'files(id),nextPageToken,incompleteSearch',
    );
  });

  it('deduplicates pages and honors result limits', async () => {
    const load = responses([
      { files: [{ id: 'alice-private' }], nextPageToken: 'page-2' },
      { files: [{ id: 'alice-private' }] },
      metadata,
      'content',
      metadata,
    ]);
    expect(
      await createDriveAdapter(options({ fetch: load })).search(
        { ...context, resultCountLimit: 1 },
        'bundle-b',
      ),
    ).toHaveLength(1);
    expect(requestUrl(load.mock.calls[1][0]).searchParams.get('pageToken')).toBe('page-2');
  });

  it.each([
    [{ files: [], incompleteSearch: true }],
    [
      { files: [], nextPageToken: 'same' },
      { files: [], nextPageToken: 'same' },
    ],
    [new Response('not-json')],
    [{ files: [{ id: '../redirect' }] }],
  ])('refuses incomplete, cyclic or malformed listings', async (...bodies) => {
    await expect(
      createDriveAdapter(options({ fetch: responses(bodies) })).search(context, 'bundle-b'),
    ).rejects.toBeInstanceOf(DelegatedDriveError);
  });

  it('bounds page count', async () => {
    const load = responses([{ files: [], nextPageToken: 'more' }]);
    await expect(
      createDriveAdapter(options({ fetch: load, maxPages: 1 })).search(context, 'bundle-b'),
    ).rejects.toMatchObject({ code: 'limit' });
  });

  it('fails closed on network failures without leaking upstream error details', async () => {
    const load = vi.fn<typeof fetch>().mockRejectedValue(new Error('FAKE_SECRET C04_BOB_CONTENT'));
    await expect(
      createDriveAdapter(options({ fetch: load })).search(context, 'bundle-b'),
    ).rejects.toThrow('delegated Drive retrieval denied: transport');
  });
});

// Root Vitest excludes spikes/. Run the node:test suites through this discovered
// test so existing pnpm test / CI executes the entire offline harness unchanged.
it('runs all offline retrieval spike suites through the existing Vitest gate', () => {
  const repository = fileURLToPath(new URL('../../../../', import.meta.url));
  const output = execFileSync(
    process.execPath,
    [
      '--test',
      '--test-reporter=tap',
      'spikes/retrieval/drive/replay.test.mjs',
      'spikes/retrieval/managed/replay.test.mjs',
      'spikes/retrieval/compare/evaluate.test.mjs',
    ],
    { cwd: repository, encoding: 'utf8', timeout: 60_000 },
  );
  expect(output).toContain('# fail 0');
}, 65_000);
