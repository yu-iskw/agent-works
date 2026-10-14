import { describe, expect, it } from 'vitest';

import { changeConsent } from './consent.js';
import { holdMemory, revokeMemorySource } from './lifecycle.js';
import { deleteMemory } from './manage.js';
import { recallMemory } from './recall.js';
import { memoryFixture, memoryProposal, aliceScope, bobScope, MEMORY_AT } from './test-fixtures.js';

describe('legal hold preservation and release', () => {
  it('blocks direct deletion while held', async () => {
    const f = memoryFixture();
    await f.enable();
    const item = await f.put();
    await holdMemory(f.store, aliceScope, item.id, true, new Date(MEMORY_AT));
    await expect(
      deleteMemory(
        f.store,
        aliceScope,
        { id: item.id, agent: item.agent, revision: 1 },
        new Date(MEMORY_AT),
      ),
    ).rejects.toThrow('legal hold');
    expect(await f.store.transaction((state) => state.history)).toHaveLength(1);
  });
  it('opt-out seals held rows and release completes physical purge', async () => {
    const f = memoryFixture();
    await f.enable();
    const item = await f.put();
    await holdMemory(f.store, aliceScope, item.id, true, new Date(MEMORY_AT));
    await changeConsent(
      f.store,
      aliceScope,
      { enabled: false, revision: 1, noticeVersion: 'memory-v1' },
      new Date(MEMORY_AT),
    );
    expect((await f.store.transaction((state) => state.items))[0].state).toBe('sealed');
    expect(await recallMemory(f.store, f.policy, aliceScope)).toEqual([]);
    await changeConsent(
      f.store,
      aliceScope,
      { enabled: true, revision: 2, noticeVersion: 'memory-v1' },
      new Date(MEMORY_AT),
    );
    expect(await recallMemory(f.store, f.policy, aliceScope)).toEqual([]);
    await holdMemory(f.store, aliceScope, item.id, false, new Date(MEMORY_AT));
    expect(await f.store.transaction((state) => state.items)).toEqual([]);
    expect(await f.store.transaction((state) => state.history)).toEqual([]);
  });
  it('source revocation seals held rows permanently until release', async () => {
    const f = memoryFixture();
    await f.enable();
    const proposal = memoryProposal();
    proposal.origin.sourceRef = 'doc';
    const item = await f.put(proposal);
    await holdMemory(f.store, aliceScope, item.id, true, new Date(MEMORY_AT));
    await revokeMemorySource(f.store, 'doc', new Date(MEMORY_AT));
    expect(await recallMemory(f.store, f.policy, aliceScope)).toEqual([]);
    expect((await f.store.transaction((state) => state.items))[0].state).toBe('sealed');
    await holdMemory(f.store, aliceScope, item.id, false, new Date(MEMORY_AT));
    expect(await f.store.transaction((state) => state.items)).toEqual([]);
  });
  it('cannot hold another user memory through a guessed id', async () => {
    const f = memoryFixture();
    await f.enable();
    const item = await f.put();
    await expect(
      holdMemory(f.store, bobScope, item.id, true, new Date(MEMORY_AT)),
    ).rejects.toThrow();
    expect((await f.store.transaction((state) => state.items))[0].legalHold).toBe(false);
  });
});
