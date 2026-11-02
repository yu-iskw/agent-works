import { describe, expect, it } from 'vitest';

import {
  CONNECTOR_CATALOG,
  PUBLISHED_CONNECTOR_HASHES,
  connectorContentHash,
  findConnector,
  publishedConnectorHash,
} from './connector-catalog.js';
import { WRITE_CAPABILITIES } from './connector-cdk.js';
import { CAPABILITY_PROVIDER } from './teamwork.js';

import type { ConnectorManifest } from './connector-cdk.js';

const byKey = (a: readonly (string | null)[], b: readonly (string | null)[]) =>
  (a[0] ?? '').localeCompare(b[0] ?? '');
const byName = (a: string, b: string) => a.localeCompare(b);
const listCapabilities = (manifest: ConnectorManifest) =>
  manifest.capabilities.map((capability) => [capability.id, manifest.id]);

describe('connector catalog', () => {
  it('maps every provider-backed capability to exactly one first-party connector', () => {
    const listed = CONNECTOR_CATALOG.flatMap(listCapabilities);
    const expected = Object.entries(CAPABILITY_PROVIDER).filter(
      ([, provider]) => provider !== null,
    );
    expect([...listed].sort(byKey)).toEqual([...expected].sort(byKey));
  });

  it('marks docs.publish as the only write capability', () => {
    expect([...WRITE_CAPABILITIES]).toEqual(['docs.publish']);
    const google = findConnector('google');
    const sideEffects = Object.fromEntries(
      google?.capabilities.map((capability) => [
        capability.id,
        capability.tools[0]?.spec.sideEffect,
      ]) ?? [],
    );
    expect(sideEffects).toEqual({
      'drive.read': 'READ',
      'bigquery.query': 'READ',
      'docs.publish': 'WRITE_LOW',
    });
  });

  it('pins one content hash per published version, so a published version is immutable', () => {
    expect(Object.keys(PUBLISHED_CONNECTOR_HASHES).sort(byName)).toEqual(
      CONNECTOR_CATALOG.map((manifest) => `${manifest.id}@${manifest.version}`).sort(byName),
    );
    for (const manifest of CONNECTOR_CATALOG)
      expect(connectorContentHash(manifest), `${manifest.id}@${manifest.version}`).toBe(
        publishedConnectorHash(manifest),
      );
  });

  it('changes the hash when a manifest changes without a version bump', () => {
    const google = structuredClone(findConnector('google'));
    if (!google) throw new Error('google connector missing');
    google.summary = 'changed';
    expect(connectorContentHash(google)).not.toBe(publishedConnectorHash(google));
  });

  it('finds a connector by id and optional version', () => {
    expect(findConnector('github', '1.0.0')?.id).toBe('github');
    expect(findConnector('github', '9.9.9')).toBeUndefined();
    expect(findConnector('unknown')).toBeUndefined();
  });
});
