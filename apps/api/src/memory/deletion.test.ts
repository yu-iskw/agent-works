import { describe, expect, it } from 'vitest';

import { changeConsent } from './consent.js';
import { holdMemory, deleteOwnerMemories } from './lifecycle.js';
import { recallMemory } from './recall.js';
import { memoryFixture, memoryProposal, aliceScope, MEMORY_AT } from './test-fixtures.js';
import { proposeMemory } from './write.js';

describe('owner deletion fan-out', () => {
  it('removes all owner agents and history with minimal evidence', async () => {
    const f = memoryFixture();
    await f.enable();
    await f.put();
    const proposal = memoryProposal();
    await proposeMemory(f.store, f.policy, { ...aliceScope, agent: 'other' }, proposal);
    expect(await deleteOwnerMemories(f.store, aliceScope, new Date(MEMORY_AT))).toEqual({
      held: [],
    });
    const state = await f.store.transaction((state) => state);
    expect(state.items).toEqual([]);
    expect(state.history).toEqual([]);
    expect(state.tombstones).toHaveLength(2);
    expect(JSON.stringify(state.tombstones)).not.toContain('alice');
    expect(JSON.stringify(state.audit)).not.toContain('concise answers');
  });
  it('does not delete another tenant or another owner', async () => {
    const f = memoryFixture();
    await f.enable();
    await f.put();
    const other = { ...aliceScope, tenant: 'tenant-b' };
    await changeConsent(
      f.store,
      other,
      { enabled: true, revision: 0, noticeVersion: 'memory-v1' },
      new Date(MEMORY_AT),
    );
    await proposeMemory(f.store, f.policy, other, memoryProposal());
    await deleteOwnerMemories(f.store, aliceScope, new Date(MEMORY_AT));
    expect(await recallMemory(f.store, f.policy, other)).toHaveLength(1);
  });
  it('reports held ids and purges remaining rows', async () => {
    const f = memoryFixture();
    await f.enable();
    const held = await f.put();
    await f.put();
    await holdMemory(f.store, aliceScope, held.id, true, new Date(MEMORY_AT));
    expect(await deleteOwnerMemories(f.store, aliceScope, new Date(MEMORY_AT))).toEqual({
      held: [held.id],
    });
    expect((await f.store.transaction((state) => state.items))[0].state).toBe('sealed');
    expect(await recallMemory(f.store, f.policy, aliceScope)).toEqual([]);
  });
  it('repeated deletion does not recreate history or duplicate tombstones', async () => {
    const f = memoryFixture();
    await f.enable();
    await f.put();
    await deleteOwnerMemories(f.store, aliceScope, new Date(MEMORY_AT));
    await deleteOwnerMemories(f.store, aliceScope, new Date(MEMORY_AT));
    expect(await f.store.transaction((state) => state.tombstones)).toHaveLength(1);
  });
});
