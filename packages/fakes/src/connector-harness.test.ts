import { describe, expect, it } from 'vitest';

import { createConnectorHarness } from './connector-harness.js';

import type { HarnessHandler } from './connector-harness.js';
import type { ToolManifest } from '@agent-works/domain';
import type { ConnectorRegistry } from '@agent-works/domain/connector-cdk';

// The manifest is opaque to the harness, so a stub stands in for a parsed ToolManifest.
const manifest = {} as ToolManifest;
const registry: ConnectorRegistry<HarnessHandler> = new Map([
  ['drive.read', { manifest, handler: (input: unknown) => input }],
  ['docs.publish', { manifest, handler: () => 'doc-1' }],
]);

describe('connector harness', () => {
  it('records calls that reach a handler', async () => {
    const harness = createConnectorHarness(registry);
    await expect(harness.invoke('drive.read', { fileId: 'f1' })).resolves.toEqual({ fileId: 'f1' });
    await expect(harness.invoke('docs.publish', {})).resolves.toBe('doc-1');
    expect(harness.calls.map((call) => call.tool)).toEqual(['drive.read', 'docs.publish']);
  });

  it('fails closed on an unknown tool without reaching a handler', async () => {
    const harness = createConnectorHarness(registry);
    await expect(harness.invoke('gmail.send', {})).rejects.toThrow('unknown tool gmail.send');
    expect(harness.calls).toEqual([]);
  });
});
