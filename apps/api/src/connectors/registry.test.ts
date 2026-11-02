import { defineRegistry } from '@agent-works/domain/connector-cdk';
import { workspaceManifests } from '@agent-works/domain/workspace-tools';
import { expect, it } from 'vitest';

import { createWorkspaceRegistry } from './ports.js';

import type { CallerCredential } from './google-http.js';
import type { WorkspaceAdapters, WorkspaceHandler } from './ports.js';

const credential: CallerCredential = { subject: 'alice', token: 'token', scopes: [] };
const receipt = { id: 'receipt-1' } as Awaited<
  ReturnType<WorkspaceAdapters['docs']['createDraft']>
>;
const adapters: WorkspaceAdapters = {
  docs: { createDraft: () => Promise.resolve(receipt) },
  calendar: {
    listEvents: () => Promise.resolve([]),
    createEvent: () => Promise.resolve(receipt),
  },
  gmail: {
    searchThreads: () => Promise.resolve([]),
    createDraft: () => Promise.resolve(receipt),
  },
};
const call = { credential, payload: {}, idempotencyKey: 'key-1' };

it('binds one handler per manifest and the handler kind matches the manifest side effect', () => {
  const registry = createWorkspaceRegistry(adapters);
  expect([...registry.keys()]).toEqual(workspaceManifests.map((tool) => tool.metadata.name));
  for (const [name, entry] of registry)
    if (name !== 'gmail.send')
      expect(entry.handler.kind === 'read').toBe(entry.manifest.spec.sideEffect === 'READ');
});

it('denies the send tool through its handler', async () => {
  const send = createWorkspaceRegistry(adapters).get('gmail.send');
  await expect(send?.handler.run(call)).rejects.toMatchObject({ code: 'POLICY_DENIED' });
});

it('adds a second google adapter with only a manifest and a handler entry', async () => {
  const base = createWorkspaceRegistry(adapters);
  const handlers = Object.fromEntries([...base].map(([name, entry]) => [name, entry.handler]));
  const extra: WorkspaceHandler = { kind: 'read', run: () => Promise.resolve([]) };
  const manifest = {
    ...structuredClone(workspaceManifests[1]),
    metadata: { ...workspaceManifests[1].metadata, name: 'drive.listFiles' },
  };
  const next = defineRegistry<WorkspaceHandler>([...workspaceManifests, manifest], {
    ...handlers,
    'drive.listFiles': extra,
  });
  expect(next.size).toBe(base.size + 1);
  expect(next.get('drive.listFiles')?.handler).toBe(extra);
  for (const [name, entry] of base) expect(next.get(name)?.handler).toBe(entry.handler);
  expect(() =>
    defineRegistry<WorkspaceHandler>([...workspaceManifests, manifest], handlers),
  ).toThrow(/missing \[drive.listFiles\]/);
});
