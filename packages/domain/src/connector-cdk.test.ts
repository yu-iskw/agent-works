import { describe, expect, it } from 'vitest';

import { connectorManifestSchema, defineConnector, defineRegistry } from './connector-cdk.js';
import { CONNECTOR_CATALOG } from './connector-catalog.js';
import { workspaceManifests } from './workspace-tools-manifest.js';

import type { ConnectorManifest } from './connector-cdk.js';

const google = CONNECTOR_CATALOG.find((manifest) => manifest.id === 'google') as ConnectorManifest;
const clone = (): ConnectorManifest => structuredClone(google);

function expectRejected(manifest: unknown, message?: string) {
  const result = connectorManifestSchema.safeParse(manifest);
  expect(result.success).toBe(false);
  if (message) expect(JSON.stringify(result.error?.issues)).toContain(message);
}

describe('connectorManifestSchema', () => {
  it('accepts the first-party manifests', () => {
    for (const manifest of CONNECTOR_CATALOG)
      expect(connectorManifestSchema.parse(manifest)).toEqual(manifest);
  });

  it('rejects unknown keys at every level', () => {
    expectRejected({ ...clone(), extra: 1 });
    const nested = clone();
    Object.assign(nested.capabilities[0] as object, { extra: 1 });
    expectRejected(nested);
    const tool = clone();
    Object.assign(tool.capabilities[0]?.tools[0]?.spec as object, { extra: 1 });
    expectRejected(tool);
  });

  it.each(['1', '1.0', 'v1.0.0', '01.0.0', '1.0.0.0', ''])(
    'rejects malformed semver %j',
    (version) => expectRejected({ ...clone(), version }),
  );

  it('rejects a write tool under a read capability', () => {
    const manifest = clone();
    const tool = manifest.capabilities[0]?.tools[0];
    if (tool) tool.spec.sideEffect = 'WRITE_LOW';
    expectRejected(manifest, 'under read capability');
  });

  it('rejects a read tool under a write capability', () => {
    const manifest = clone();
    const tool = manifest.capabilities[2]?.tools[0];
    if (tool) tool.spec.sideEffect = 'READ';
    expectRejected(manifest, 'under write capability');
  });

  it('rejects duplicate tool names and duplicate capabilities', () => {
    const names = clone();
    const second = names.capabilities[1];
    if (second) second.tools[0] = structuredClone(names.capabilities[0]?.tools[0]) as never;
    expectRejected(names, 'duplicate tool name');
    const capabilities = clone();
    capabilities.capabilities.push(structuredClone(capabilities.capabilities[0]) as never);
    expectRejected(capabilities, 'duplicate capability');
  });

  it('rejects a capability that belongs to another provider', () => {
    const manifest = clone();
    manifest.id = 'github';
    expectRejected(manifest, 'does not belong to provider');
  });

  it('rejects a publisher other than agent-works', () => {
    expectRejected({ ...clone(), publisher: 'someone-else' });
  });
});

describe('defineConnector', () => {
  const handlers = { 'drive.read': 1, 'bigquery.query': 2, 'docs.publish': 3 };

  it('builds a registry keyed by tool name', () => {
    const registry = defineConnector(google, handlers);
    expect([...registry.keys()]).toEqual(['drive.read', 'bigquery.query', 'docs.publish']);
    expect(registry.get('docs.publish')?.handler).toBe(3);
    expect(registry.get('docs.publish')?.manifest.spec.sideEffect).toBe('WRITE_LOW');
  });

  it('fails on a missing handler', () => {
    expect(() => defineConnector(google, { 'drive.read': 1, 'docs.publish': 3 })).toThrow(
      /missing \[bigquery\.query\]/,
    );
  });

  it('fails on an extra handler', () => {
    expect(() => defineConnector(google, { ...handlers, 'gmail.send': 4 })).toThrow(
      /extra \[gmail\.send\]/,
    );
  });

  it('rejects an invalid manifest before binding handlers', () => {
    expect(() => defineConnector({ ...clone(), version: 'nope' }, handlers)).toThrow();
  });
});

describe('defineRegistry', () => {
  const names = workspaceManifests.map((tool) => tool.metadata.name);
  const handlers = Object.fromEntries(names.map((name, index) => [name, index]));

  it('builds a registry over the workspace tool manifests', () => {
    const registry = defineRegistry(workspaceManifests, handlers);
    expect(registry.size).toBe(workspaceManifests.length);
    expect(registry.get('calendar.listEvents')?.handler).toBe(names.indexOf('calendar.listEvents'));
  });

  it('fails on a missing handler', () => {
    const { 'calendar.listEvents': _omitted, ...rest } = handlers;
    expect(() => defineRegistry(workspaceManifests, rest)).toThrow(
      /missing \[calendar\.listEvents\]/,
    );
  });

  it('fails on an extra handler', () => {
    expect(() => defineRegistry(workspaceManifests, { ...handlers, 'unknown.tool': 99 })).toThrow(
      /extra \[unknown\.tool\]/,
    );
  });

  it('fails on duplicate tool names', () => {
    const first = workspaceManifests[0];
    expect(() => defineRegistry([...workspaceManifests, first as never], handlers)).toThrow(
      /duplicate tool names \[/,
    );
  });

  it('rejects an invalid ToolManifest', () => {
    const invalid = { ...workspaceManifests[0], extra: 1 } as never;
    expect(() => defineRegistry([invalid], { [names[0] as string]: 1 })).toThrow();
  });
});
