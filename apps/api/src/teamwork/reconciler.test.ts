import { CONNECTOR_CATALOG } from '@agent-works/domain/connector-catalog';
import { describe, expect, it } from 'vitest';

import { createReconciler } from './reconciler.js';
import { createFakeRuntimeManager } from './runtime-manager.js';

import type { Installation } from './installations.js';
import type { InstallationStore } from './reconciler.js';
import type { ManifestLookup, RuntimeManager } from './runtime-manager.js';
import type { ConnectorManifest } from '@agent-works/domain/connector-cdk';

const D1 = `sha256:${'1'.repeat(64)}`;
const D2 = `sha256:${'2'.repeat(64)}`;

const google = CONNECTOR_CATALOG.find((manifest) => manifest.id === 'google') as ConnectorManifest;
const inProcess: ConnectorManifest = google;
const v1: ConnectorManifest = { ...google, runtime: { artifactDigest: D1 } };
const v2: ConnectorManifest = { ...google, version: '2.0.0', runtime: { artifactDigest: D2 } };

const catalog =
  (...manifests: readonly ConnectorManifest[]): ManifestLookup =>
  (id, version) =>
    manifests.find(
      (manifest) => manifest.id === id && (version === undefined || manifest.version === version),
    );

const BASE_MS = 1000;
const MAX_MS = 4000;
const LEASE_MS = 60_000;
let nowMs = 1_000_000;
const now = () => new Date(nowMs);
const advance = (ms: number) => {
  nowMs += ms;
};

const row = (patch: Partial<Installation> = {}): Installation => ({
  item_id: 'google',
  version: '1.0.0',
  previous_version: null,
  capabilities: ['drive.read'],
  desired_state: 'enabled',
  observed_state: 'pending',
  observed_detail: null,
  generation: 1,
  updated_by: 'alice@local.test',
  updated_at: now(),
  ...patch,
});

/** Same compare-and-swap contract as `updateInstallation`, with the swap at a microtask boundary. */
function memoryStore(initial: Installation) {
  let current = initial;
  const store: InstallationStore & { current(): Installation } = {
    current: () => current,
    list: () => Promise.resolve([current]),
    update: (input) =>
      Promise.resolve().then(() => {
        if (current.generation !== input.expectedGeneration) return undefined;
        const { change } = input;
        current = {
          ...current,
          version: change.version ?? current.version,
          previous_version:
            change.previousVersion === undefined
              ? current.previous_version
              : change.previousVersion,
          desired_state: change.desiredState ?? current.desired_state,
          observed_state: change.observedState ?? current.observed_state,
          observed_detail:
            change.observedDetail === undefined ? current.observed_detail : change.observedDetail,
          generation: current.generation + 1,
          updated_by: input.actor,
          updated_at: now(),
        };
        return current;
      }),
  };
  return store;
}

function setup(
  initial: Installation,
  options: { manifests?: ManifestLookup; runtime?: RuntimeManager; segment?: string } = {},
) {
  const manifests = options.manifests ?? catalog(v1, v2);
  const fake = createFakeRuntimeManager({ segment: 'alpha', manifest: manifests });
  const store = memoryStore(initial);
  const errors: unknown[] = [];
  const reconciler = createReconciler(store, {
    segment: options.segment ?? 'alpha',
    runtime: options.runtime ?? fake,
    manifest: manifests,
    now,
    onError: (error) => errors.push(error),
    leaseMs: LEASE_MS,
    backoff: { baseMs: BASE_MS, maxMs: MAX_MS },
  });
  return { fake, store, reconciler, errors };
}

const outcomes = async (reconciler: ReturnType<typeof createReconciler>) =>
  (await reconciler.tick()).map((result) => result.outcome);
const ensures = (fake: ReturnType<typeof createFakeRuntimeManager>) =>
  fake.calls.filter((call) => call.startsWith('ensure:'));

describe('reconciler', () => {
  it('reports an in-process connector as not_required and never calls the runtime', async () => {
    const { fake, store, reconciler } = setup(row(), { manifests: catalog(inProcess) });
    expect(await outcomes(reconciler)).toEqual(['converged']);
    expect(store.current()).toMatchObject({ observed_state: 'not_required', generation: 2 });
    expect(await outcomes(reconciler)).toEqual(['unchanged']);
    expect(store.current().generation).toBe(2);
    expect(fake.calls).toEqual([]);
  });

  it('deploys a runtime-backed connector and is then idempotent', async () => {
    const { fake, store, reconciler } = setup(row());
    expect(await outcomes(reconciler)).toEqual(['converged']);
    expect(store.current()).toMatchObject({ observed_state: 'healthy', observed_detail: null });
    expect(await fake.status({ segment: 'alpha', connector: 'google' })).toMatchObject({
      state: 'ready',
      resourceName: 'aw-alpha-google',
      artifactDigest: D1,
    });
    const generation = store.current().generation;
    expect(await outcomes(reconciler)).toEqual(['unchanged']);
    expect(store.current().generation).toBe(generation);
    expect(ensures(fake)).toHaveLength(1);
  });

  it('gives two segments distinct resource names and identities', async () => {
    const alpha = setup(row());
    const betaStore = memoryStore(row());
    const betaFake = createFakeRuntimeManager({ segment: 'beta', manifest: catalog(v1, v2) });
    const betaReconciler = createReconciler(betaStore, {
      segment: 'beta',
      runtime: betaFake,
      manifest: catalog(v1, v2),
      now,
      onError: (error) => {
        throw error;
      },
    });
    await alpha.reconciler.tick();
    await betaReconciler.tick();
    const first = await alpha.fake.status({ segment: 'alpha', connector: 'google' });
    const second = await betaFake.status({ segment: 'beta', connector: 'google' });
    expect([first.resourceName, second.resourceName]).toEqual([
      'aw-alpha-google',
      'aw-beta-google',
    ]);
    expect(first.identity).not.toBe(second.identity);
    expect(betaStore.current().observed_state).toBe('healthy');
  });

  it('fails closed on a segment mismatch', async () => {
    const { fake, store, reconciler } = setup(row(), { segment: 'beta' });
    expect(await outcomes(reconciler)).toEqual(['failed']);
    expect(store.current()).toMatchObject({
      observed_state: 'failed',
      observed_detail: 'segment_mismatch',
    });
    expect((await fake.status({ segment: 'alpha', connector: 'google' })).state).toBe('absent');
  });

  it('fails closed on a digest the runtime does not find in its manifest', async () => {
    const forged: ConnectorManifest = { ...v1, runtime: { artifactDigest: D2 } };
    const fake = createFakeRuntimeManager({ segment: 'alpha', manifest: catalog(v1) });
    const { store, reconciler } = setup(row(), { manifests: catalog(forged), runtime: fake });
    expect(await outcomes(reconciler)).toEqual(['failed']);
    expect(store.current()).toMatchObject({
      observed_state: 'failed',
      observed_detail: 'digest_not_in_manifest',
    });
    expect((await fake.status({ segment: 'alpha', connector: 'google' })).state).toBe('absent');
  });

  it('fails closed on a version that is not in the catalog, without a runtime call', async () => {
    const { fake, store, reconciler } = setup(row({ version: '9.9.9' }));
    expect(await outcomes(reconciler)).toEqual(['failed']);
    expect(store.current()).toMatchObject({
      observed_state: 'failed',
      observed_detail: 'unknown_version',
    });
    expect(await outcomes(reconciler)).toEqual(['unchanged']);
    expect(fake.calls).toEqual([]);
  });

  it('upgrades and rolls back through the runtime, keeping previous_version, and repeats are no-ops', async () => {
    const { fake, store, reconciler } = setup(row());
    await reconciler.tick();
    const ref = { segment: 'alpha', connector: 'google' };

    const upgrade = store.current();
    await store.update({
      id: 'google',
      expectedGeneration: upgrade.generation,
      actor: 'alice@local.test',
      action: 'installation.upgrade',
      change: {
        version: '2.0.0',
        previousVersion: '1.0.0',
        observedState: 'pending',
        observedDetail: null,
      },
    });
    expect(await outcomes(reconciler)).toEqual(['converged']);
    expect(store.current()).toMatchObject({
      version: '2.0.0',
      previous_version: '1.0.0',
      observed_state: 'healthy',
    });
    expect(await fake.status(ref)).toMatchObject({ version: '2.0.0', artifactDigest: D2 });
    expect(await outcomes(reconciler)).toEqual(['unchanged']);

    await store.update({
      id: 'google',
      expectedGeneration: store.current().generation,
      actor: 'alice@local.test',
      action: 'installation.rollback',
      change: {
        version: '1.0.0',
        previousVersion: null,
        observedState: 'pending',
        observedDetail: null,
      },
    });
    expect(await outcomes(reconciler)).toEqual(['converged']);
    expect(await fake.status(ref)).toMatchObject({ version: '1.0.0', artifactDigest: D1 });
    expect(await outcomes(reconciler)).toEqual(['unchanged']);
    expect(ensures(fake)).toHaveLength(3);
  });

  it('marks a failed health check as failed and keeps previous_version', async () => {
    const { fake, store, reconciler } = setup(row({ version: '2.0.0', previous_version: '1.0.0' }));
    fake.setHealthy('google', false);
    expect(await outcomes(reconciler)).toEqual(['failed']);
    expect(store.current()).toMatchObject({
      version: '2.0.0',
      previous_version: '1.0.0',
      desired_state: 'enabled',
      observed_state: 'failed',
      observed_detail: 'health_check_failed',
    });
  });

  it('reports only a safe code when the runtime throws something else', async () => {
    const runtime: RuntimeManager = {
      ensure: () => Promise.reject(new Error('token=secret-value')),
      remove: () => Promise.resolve(),
      status: () => Promise.reject(new Error('token=secret-value')),
    };
    const { store, reconciler } = setup(row(), { runtime });
    expect(await outcomes(reconciler)).toEqual(['failed']);
    expect(store.current().observed_detail).toBe('runtime_error');
  });

  it('backs off in bounded, doubling steps and recovers once the failure clears', async () => {
    const { fake, store, reconciler } = setup(row());
    fake.injectFailure({ operation: 'ensure', code: 'quota_exceeded', times: 4 });
    expect(await outcomes(reconciler)).toEqual(['failed']);
    expect(await outcomes(reconciler)).toEqual(['skipped']);
    expect(ensures(fake)).toHaveLength(1);

    advance(BASE_MS);
    expect(await outcomes(reconciler)).toEqual(['failed']);
    advance(BASE_MS);
    expect(await outcomes(reconciler)).toEqual(['skipped']);
    advance(BASE_MS);
    expect(await outcomes(reconciler)).toEqual(['failed']);
    expect(ensures(fake)).toHaveLength(3);

    // The third wait would be 4 s and the fourth 8 s, which the cap holds at MAX_MS.
    advance(MAX_MS);
    expect(await outcomes(reconciler)).toEqual(['failed']);
    advance(MAX_MS);
    expect(await outcomes(reconciler)).toEqual(['converged']);
    expect(store.current()).toMatchObject({ observed_state: 'healthy', observed_detail: null });
  });

  it('restarts the backoff when an admin changes the row', async () => {
    const { fake, store, reconciler } = setup(row());
    fake.injectFailure({ operation: 'ensure', code: 'deploy_failed' });
    await reconciler.tick();
    expect(await outcomes(reconciler)).toEqual(['skipped']);
    await store.update({
      id: 'google',
      expectedGeneration: store.current().generation,
      actor: 'alice@local.test',
      action: 'installation.upgrade',
      change: { version: '2.0.0', previousVersion: '1.0.0', observedState: 'pending' },
    });
    expect(await outcomes(reconciler)).toEqual(['converged']);
  });

  it('lets exactly one of two concurrent reconcilers deploy', async () => {
    const { fake, store, reconciler } = setup(row());
    const second = createReconciler(store, {
      segment: 'alpha',
      runtime: fake,
      manifest: catalog(v1, v2),
      now,
      onError: (error) => {
        throw error;
      },
    });
    const results = await Promise.all([reconciler.tick(), second.tick()]);
    expect(
      results
        .flat()
        .map((result) => result.outcome)
        .sort((a, b) => a.localeCompare(b)),
    ).toEqual(['converged', 'skipped']);
    expect(ensures(fake)).toHaveLength(1);
    expect(store.current().observed_state).toBe('healthy');
  });

  it('converges after a reconciler died mid-claim, once the lease has expired', async () => {
    const { fake, store, reconciler } = setup(row());
    // The first reconciler claimed the row and died before calling the runtime.
    await store.update({
      id: 'google',
      expectedGeneration: 1,
      actor: 'system:reconciler',
      action: 'installation.reconcile.claim',
      change: { observedState: 'provisioning', observedDetail: null },
    });
    advance(LEASE_MS - 1);
    expect(await outcomes(reconciler)).toEqual(['skipped']);
    expect(fake.calls).toEqual([]);
    advance(1);
    expect(await outcomes(reconciler)).toEqual(['converged']);
    expect(store.current().observed_state).toBe('healthy');
    expect(ensures(fake)).toHaveLength(1);
  });

  it('drops its result when an admin changed the row during the runtime call, then converges', async () => {
    const { fake, store } = setup(row());
    const racing: RuntimeManager = {
      ...fake,
      ensure: async (request) => {
        const status = await fake.ensure(request);
        await store.update({
          id: 'google',
          expectedGeneration: store.current().generation,
          actor: 'alice@local.test',
          action: 'installation.disable',
          change: { desiredState: 'disabled' },
        });
        return status;
      },
    };
    const reconciler = createReconciler(store, {
      segment: 'alpha',
      runtime: racing,
      manifest: catalog(v1, v2),
      now,
      onError: (error) => {
        throw error;
      },
    });
    expect(await outcomes(reconciler)).toEqual(['skipped']);
    expect(store.current()).toMatchObject({
      desired_state: 'disabled',
      observed_state: 'provisioning',
    });
    advance(LEASE_MS);
    expect(await outcomes(reconciler)).toEqual(['converged']);
    expect(store.current().observed_state).toBe('disabled');
    expect((await fake.status({ segment: 'alpha', connector: 'google' })).state).toBe('absent');
  });

  it('removes a disabled connector, redeploys when re-enabled, and rebuilds a deleted service', async () => {
    const { fake, store, reconciler } = setup(row());
    const ref = { segment: 'alpha', connector: 'google' };
    await reconciler.tick();

    await store.update({
      id: 'google',
      expectedGeneration: store.current().generation,
      actor: 'alice@local.test',
      action: 'installation.disable',
      change: { desiredState: 'disabled' },
    });
    expect(await outcomes(reconciler)).toEqual(['converged']);
    expect(store.current().observed_state).toBe('disabled');
    expect((await fake.status(ref)).state).toBe('absent');
    expect(await outcomes(reconciler)).toEqual(['unchanged']);

    await store.update({
      id: 'google',
      expectedGeneration: store.current().generation,
      actor: 'alice@local.test',
      action: 'installation.enable',
      change: { desiredState: 'enabled' },
    });
    expect(await outcomes(reconciler)).toEqual(['converged']);
    expect((await fake.status(ref)).state).toBe('ready');

    await fake.remove(ref);
    expect(await outcomes(reconciler)).toEqual(['converged']);
    expect((await fake.status(ref)).state).toBe('ready');
  });

  it('reports runtime errors from a drift check without failing the row', async () => {
    const { fake, store, reconciler, errors } = setup(row());
    await reconciler.tick();
    fake.injectFailure({ operation: 'status', code: 'timeout' });
    expect(await outcomes(reconciler)).toEqual(['skipped']);
    expect(store.current().observed_state).toBe('healthy');
    expect(errors).toHaveLength(1);
  });
});
