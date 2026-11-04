import { describe, expect, it } from 'vitest';

import {
  CONNECTOR_CATALOG,
  MCP_SERVER_CATALOG,
  PUBLISHED_CONNECTOR_HASHES,
  connectorContentHash,
  findConnector,
  findMcpServer,
  publishedConnectorHash,
} from './connector-catalog.js';
import { WRITE_CAPABILITIES } from './connector-cdk.js';
import { CAPABILITY_PROVIDER, DEFAULT_SEGMENT_CAPABILITIES } from './teamwork.js';

import type { ConnectorManifest } from './connector-cdk.js';

const byKey = (a: readonly (string | null)[], b: readonly (string | null)[]) =>
  (a[0] ?? '').localeCompare(b[0] ?? '');
const byName = (a: string, b: string) => a.localeCompare(b);
const ALL_MANIFESTS = [...CONNECTOR_CATALOG, ...MCP_SERVER_CATALOG];
const listCapabilities = (manifest: ConnectorManifest) =>
  manifest.capabilities.map((capability) => [capability.id, manifest.id]);

describe('connector catalog', () => {
  it('maps every provider-backed capability to exactly one first-party connector', () => {
    const listed = ALL_MANIFESTS.flatMap(listCapabilities);
    const expected = Object.entries(CAPABILITY_PROVIDER).filter(
      ([, provider]) => provider !== null,
    );
    expect([...listed].sort(byKey)).toEqual([...expected].sort(byKey));
  });

  it('marks docs.publish and notes.write as the only write capabilities', () => {
    expect([...WRITE_CAPABILITIES]).toEqual(['docs.publish', 'notes.write']);
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
      ALL_MANIFESTS.map((manifest) => `${manifest.id}@${manifest.version}`).sort(byName),
    );
    for (const manifest of ALL_MANIFESTS)
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

  it('keeps the existing native pins byte-identical', () => {
    expect(PUBLISHED_CONNECTOR_HASHES['google@1.0.0']).toBe(
      '78267e1d575805ce43db4eaced62a97b83c93965cd011721edd7e0abd4b86300',
    );
    expect(PUBLISHED_CONNECTOR_HASHES['github@1.0.0']).toBe(
      '4e3f9b8b64261253bad80358f6496deaa78e97060a9f67793496a4d79bb0da77',
    );
  });
});

describe('MCP server catalog', () => {
  const notes = findMcpServer('notes', '1.0.0');

  it('keeps the MCP server out of the native catalog', () => {
    expect(findConnector('notes')).toBeUndefined();
    expect(findMcpServer('google')).toBeUndefined();
    expect(findMcpServer('notes', '9.9.9')).toBeUndefined();
    expect(CONNECTOR_CATALOG.map((manifest) => manifest.id)).toEqual(['google', 'github']);
  });

  it('describes the notes server: one read tool, one approval-gated write tool', () => {
    expect(notes?.transport).toBe('mcp');
    const tools = notes?.capabilities.flatMap((capability) => capability.tools) ?? [];
    expect(
      tools.map((item) => [
        item.metadata.name,
        item.spec.executor,
        item.spec.sideEffect,
        item.spec.approval.policy,
        item.spec.permissions.workloadCapability,
      ]),
    ).toEqual([
      ['notes.search', 'mcp://notes/notes.search', 'READ', 'none', 'notes.read'],
      ['notes.append', 'mcp://notes/notes.append', 'WRITE_LOW', 'mcp-write-v1', 'notes.write'],
    ]);
    expect(tools[1]?.spec.approval.required).toBe(true);
  });

  it('is opt-in: the default segment allowlist holds no notes capability', () => {
    expect(DEFAULT_SEGMENT_CAPABILITIES.filter((id) => id.startsWith('notes.'))).toEqual([]);
    expect(DEFAULT_SEGMENT_CAPABILITIES).toContain('docs.publish');
  });
});
