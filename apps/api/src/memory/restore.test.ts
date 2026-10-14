import { describe, expect, it } from 'vitest';

import { createInMemoryUserMemoryStore } from '../ports/memory/user-memory.js';

import { changeConsent } from './consent.js';
import { revokeMemorySource, holdMemory } from './lifecycle.js';
import { deleteMemory } from './manage.js';
import { recallMemory } from './recall.js';
import { restoreUserMemory } from './restore.js';
import { memoryFixture, memoryProposal, aliceScope, MEMORY_AT } from './test-fixtures.js';
describe('restore replay before traffic opens', () => {
  it('applies a hold established after the backup to an otherwise active row', async () => {
    const f = memoryFixture();
    await f.enable();
    const item = await f.put();
    const backup = await f.store.transaction((state) => state);
    await holdMemory(f.store, aliceScope, item.id, true, new Date(MEMORY_AT));
    const restored = createInMemoryUserMemoryStore(backup);
    await restoreUserMemory(
      restored,
      await f.store.transaction((state) => state),
      new Date(MEMORY_AT),
    );
    expect((await restored.transaction((state) => state.items))[0]).toMatchObject({
      legalHold: true,
      state: 'active',
    });
    await expect(
      deleteMemory(
        restored,
        aliceScope,
        { id: item.id, agent: item.agent, revision: 1 },
        new Date(MEMORY_AT),
      ),
    ).rejects.toThrow('hold');
  });
  it('keeps opt-out-sealed memory sealed after a fresh opt-in and stale backup restore', async () => {
    const f = memoryFixture();
    await f.enable();
    const item = await f.put();
    const backup = await f.store.transaction((state) => state);
    await holdMemory(f.store, aliceScope, item.id, true, new Date(MEMORY_AT));
    await changeConsent(
      f.store,
      aliceScope,
      { enabled: false, revision: 1, noticeVersion: 'memory-v1' },
      new Date(MEMORY_AT),
    );
    await changeConsent(
      f.store,
      aliceScope,
      { enabled: true, revision: 2, noticeVersion: 'memory-v1' },
      new Date(MEMORY_AT),
    );
    const restored = createInMemoryUserMemoryStore(backup);
    await restoreUserMemory(
      restored,
      await f.store.transaction((state) => state),
      new Date(MEMORY_AT),
    );
    expect((await restored.transaction((state) => state.items))[0]).toMatchObject({
      legalHold: true,
      state: 'sealed',
    });
    expect(await recallMemory(restored, f.policy, aliceScope)).toEqual([]);
  });
  it('re-purges deleted content and history from stale backup', async () => {
    const f = memoryFixture();
    await f.enable();
    const item = await f.put();
    const backup = await f.store.transaction((state) => state);
    await deleteMemory(
      f.store,
      aliceScope,
      { id: item.id, agent: item.agent, revision: 1 },
      new Date(MEMORY_AT),
    );
    const evidence = await f.store.transaction((state) => state);
    const restored = createInMemoryUserMemoryStore(backup);
    expect(await restoreUserMemory(restored, evidence, new Date(MEMORY_AT))).toBe(1);
    expect(await recallMemory(restored, f.policy, aliceScope)).toEqual([]);
    expect(await restored.transaction((state) => state.history)).toEqual([]);
    expect(await restoreUserMemory(restored, evidence, new Date(MEMORY_AT))).toBe(0);
  });
  it('current opt-out overrides backed up enabled consent', async () => {
    const f = memoryFixture();
    await f.enable();
    await f.put();
    const backup = await f.store.transaction((state) => state);
    await changeConsent(
      f.store,
      aliceScope,
      { enabled: false, revision: 1, noticeVersion: 'memory-v1' },
      new Date(MEMORY_AT),
    );
    const restored = createInMemoryUserMemoryStore(backup);
    await restoreUserMemory(
      restored,
      await f.store.transaction((state) => state),
      new Date(MEMORY_AT),
    );
    expect(await restored.transaction((state) => state.items)).toEqual([]);
    expect(await recallMemory(restored, f.policy, aliceScope)).toEqual([]);
  });
  it('revocation evidence purges backed up source-linked rows', async () => {
    const f = memoryFixture();
    await f.enable();
    const proposal = memoryProposal();
    proposal.origin.sourceRef = 'doc';
    await f.put(proposal);
    const backup = await f.store.transaction((state) => state);
    await revokeMemorySource(f.store, 'doc', new Date(MEMORY_AT));
    const restored = createInMemoryUserMemoryStore(backup);
    expect(
      await restoreUserMemory(
        restored,
        await f.store.transaction((state) => state),
        new Date(MEMORY_AT),
      ),
    ).toBe(1);
    expect(await restored.transaction((state) => state.revokedSources)).toEqual(['doc']);
  });
  it('preserves unexpired active rows with current consent', async () => {
    const f = memoryFixture();
    await f.enable();
    const item = await f.put();
    const backup = await f.store.transaction((state) => state);
    const restored = createInMemoryUserMemoryStore(backup);
    expect(await restoreUserMemory(restored, backup, new Date(MEMORY_AT))).toBe(0);
    expect(await recallMemory(restored, f.policy, aliceScope)).toEqual([item]);
  });
  it('seals held memory when current consent is off', async () => {
    const f = memoryFixture();
    await f.enable();
    const item = await f.put();
    await holdMemory(f.store, aliceScope, item.id, true, new Date(MEMORY_AT));
    const backup = await f.store.transaction((state) => state);
    await changeConsent(
      f.store,
      aliceScope,
      { enabled: false, revision: 1, noticeVersion: 'memory-v1' },
      new Date(MEMORY_AT),
    );
    const restored = createInMemoryUserMemoryStore(backup);
    await restoreUserMemory(
      restored,
      await f.store.transaction((state) => state),
      new Date(MEMORY_AT),
    );
    expect((await restored.transaction((state) => state.items))[0].state).toBe('sealed');
    expect(await recallMemory(restored, f.policy, aliceScope)).toEqual([]);
  });
});

it('merges current immutable audit evidence while replaying erasure', async () => {
  const f = memoryFixture();
  await f.enable();
  const item = await f.put();
  const backup = await f.store.transaction((state) => state);
  await deleteMemory(
    f.store,
    aliceScope,
    { id: item.id, agent: item.agent, revision: 1 },
    new Date(MEMORY_AT),
  );
  const evidence = await f.store.transaction((state) => state);
  const restored = createInMemoryUserMemoryStore(backup);
  await restoreUserMemory(restored, evidence, new Date(MEMORY_AT));
  const audit = await restored.transaction((state) => state.audit);
  for (const event of evidence.audit) expect(audit).toContainEqual(event);
});
it('rejects rewritten current audit evidence and rolls replay back', async () => {
  const f = memoryFixture();
  await f.enable();
  await f.put();
  const backup = await f.store.transaction((state) => state);
  const evidence = structuredClone(backup);
  evidence.audit[0].action = 'delete';
  const restored = createInMemoryUserMemoryStore(backup);
  await expect(restoreUserMemory(restored, evidence, new Date(MEMORY_AT))).rejects.toThrow(
    'audit evidence conflict',
  );
  expect(await restored.transaction((state) => state)).toEqual(backup);
});
