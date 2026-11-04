import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type * as Catalog from '@agent-works/domain/connector-catalog';

// Each test re-imports the gateway, so the catalog mock below applies to a fresh module graph.
describe('gateway load', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.doUnmock('@agent-works/domain/connector-catalog');
  });

  it('loads with the shipped notes MCP manifest', async () => {
    await expect(import('./gateway.js')).resolves.toBeDefined();
  });

  it('fails at load when the notes MCP manifest is missing', async () => {
    vi.doMock('@agent-works/domain/connector-catalog', async (importOriginal) => ({
      ...(await importOriginal<typeof Catalog>()),
      findMcpServer: () => undefined,
    }));
    await expect(import('./gateway.js')).rejects.toThrow('notes MCP manifest');
  });
});
