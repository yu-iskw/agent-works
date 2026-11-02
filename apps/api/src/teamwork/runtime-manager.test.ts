import { CONNECTOR_CATALOG } from '@agent-works/domain/connector-catalog';
import { describe, expect, it } from 'vitest';

import {
  RuntimeError,
  createFakeRuntimeManager,
  unavailableRuntimeManager,
} from './runtime-manager.js';

import type { ManifestLookup } from './runtime-manager.js';
import type { ConnectorManifest } from '@agent-works/domain/connector-cdk';

const DIGEST = `sha256:${'1'.repeat(64)}`;
const OTHER_DIGEST = `sha256:${'2'.repeat(64)}`;

const google = CONNECTOR_CATALOG.find((manifest) => manifest.id === 'google') as ConnectorManifest;
const manifests: readonly ConnectorManifest[] = [
  { ...google, runtime: { artifactDigest: DIGEST } },
  { ...google, version: '2.0.0', runtime: { artifactDigest: OTHER_DIGEST } },
];
const lookup: ManifestLookup = (id, version) =>
  manifests.find(
    (manifest) => manifest.id === id && (version === undefined || manifest.version === version),
  );

const alpha = { segment: 'alpha', connector: 'google' };
const ensureV1 = { ...alpha, version: '1.0.0', artifactDigest: DIGEST };

const codeOf = async (call: Promise<unknown>) =>
  call.then(
    () => null,
    (error: unknown) => (error instanceof RuntimeError ? error.code : 'not_a_runtime_error'),
  );

describe('FakeRuntimeManager', () => {
  it('names resources and identities per segment and connector, deterministically', async () => {
    const one = createFakeRuntimeManager({ segment: 'alpha', manifest: lookup });
    const two = createFakeRuntimeManager({ segment: 'beta', manifest: lookup });
    const first = await one.ensure(ensureV1);
    const second = await two.ensure({ ...ensureV1, segment: 'beta' });
    expect(first).toMatchObject({ state: 'ready', resourceName: 'aw-alpha-google' });
    expect(second).toMatchObject({ state: 'ready', resourceName: 'aw-beta-google' });
    expect(first.identity).not.toBe(second.identity);
    expect(await one.ensure(ensureV1)).toEqual(first);
    expect(await one.status(alpha)).toEqual(first);
  });

  it('refuses a request for another segment before changing anything', async () => {
    const fake = createFakeRuntimeManager({ segment: 'alpha', manifest: lookup });
    const foreign = { ...ensureV1, segment: 'beta' };
    expect(await codeOf(fake.ensure(foreign))).toBe('segment_mismatch');
    expect(await codeOf(fake.remove({ segment: 'beta', connector: 'google' }))).toBe(
      'segment_mismatch',
    );
    expect(await codeOf(fake.status({ segment: 'beta', connector: 'google' }))).toBe(
      'segment_mismatch',
    );
    expect((await fake.status(alpha)).state).toBe('absent');
  });

  it('refuses a digest the manifest for that version does not name', async () => {
    const fake = createFakeRuntimeManager({ segment: 'alpha', manifest: lookup });
    expect(await codeOf(fake.ensure({ ...ensureV1, artifactDigest: OTHER_DIGEST }))).toBe(
      'digest_not_in_manifest',
    );
    expect(
      await codeOf(fake.ensure({ ...ensureV1, artifactDigest: `sha256:${'f'.repeat(64)}` })),
    ).toBe('digest_not_in_manifest');
    expect(await codeOf(fake.ensure({ ...ensureV1, version: '9.9.9' }))).toBe('unknown_version');
    expect((await fake.status(alpha)).state).toBe('absent');
  });

  it('refuses a name Cloud Run could not accept', async () => {
    const fake = createFakeRuntimeManager({ segment: 'alpha', manifest: lookup });
    expect(await codeOf(fake.status({ segment: 'alpha', connector: 'x'.repeat(60) }))).toBe(
      'invalid_name',
    );
    expect(await codeOf(fake.status({ segment: 'alpha', connector: 'Bad_Name' }))).toBe(
      'invalid_name',
    );
  });

  it('removes idempotently', async () => {
    const fake = createFakeRuntimeManager({ segment: 'alpha', manifest: lookup });
    await fake.ensure(ensureV1);
    await fake.remove(alpha);
    await fake.remove(alpha);
    expect((await fake.status(alpha)).state).toBe('absent');
  });

  it('injects failures once by default and only for the matching operation', async () => {
    const fake = createFakeRuntimeManager({ segment: 'alpha', manifest: lookup });
    fake.injectFailure({ operation: 'ensure', code: 'quota_exceeded' });
    expect(await fake.status(alpha)).toMatchObject({ state: 'absent' });
    expect(await codeOf(fake.ensure(ensureV1))).toBe('quota_exceeded');
    expect((await fake.status(alpha)).state).toBe('absent');
    expect((await fake.ensure(ensureV1)).state).toBe('ready');
  });

  it('injects failures per connector and for a set number of calls', async () => {
    const fake = createFakeRuntimeManager({ segment: 'alpha', manifest: lookup });
    fake.injectFailure({ operation: 'ensure', code: 'timeout', times: 2, connector: 'github' });
    expect((await fake.ensure(ensureV1)).state).toBe('ready');
    const github = { segment: 'alpha', connector: 'github' };
    expect(await codeOf(fake.ensure({ ...github, version: '1.0.0', artifactDigest: DIGEST }))).toBe(
      'timeout',
    );
    expect(await codeOf(fake.ensure({ ...github, version: '1.0.0', artifactDigest: DIGEST }))).toBe(
      'timeout',
    );
  });

  it('reports a deployed service as unhealthy while it is marked so', async () => {
    const fake = createFakeRuntimeManager({ segment: 'alpha', manifest: lookup });
    fake.setHealthy('google', false);
    expect((await fake.ensure(ensureV1)).state).toBe('unhealthy');
    fake.setHealthy('google', true);
    expect((await fake.status(alpha)).state).toBe('ready');
  });

  it('records every call that reached it', async () => {
    const fake = createFakeRuntimeManager({ segment: 'alpha', manifest: lookup });
    await fake.ensure(ensureV1);
    await fake.status(alpha);
    expect(fake.calls).toEqual(['ensure:alpha:google', 'status:alpha:google']);
  });
});

describe('unavailableRuntimeManager', () => {
  it('fails closed on every operation', async () => {
    expect(await codeOf(unavailableRuntimeManager.ensure(ensureV1))).toBe('runtime_unavailable');
    expect(await codeOf(unavailableRuntimeManager.remove(alpha))).toBe('runtime_unavailable');
    expect(await codeOf(unavailableRuntimeManager.status(alpha))).toBe('runtime_unavailable');
  });
});
