import { describe, expect, it } from 'vitest';

import { MemoryDenied } from '../ports/user-memory.js';

import { reviseMemory, deleteMemory } from './manage.js';
import { recallMemory } from './recall.js';
import { memoryFixture, memoryProposal, aliceScope, MEMORY_AT } from './test-fixtures.js';

describe('memory revisions and conflict handling', () => {
  it('appends scrubbed history without modifying the original revision', async () => {
    const f = memoryFixture();
    await f.enable();
    const item = await f.put();
    const edited = await reviseMemory(
      f.store,
      f.policy,
      aliceScope,
      { id: item.id, agent: item.agent, revision: 1, text: 'Contact me at alice@example.com' },
      new Date(MEMORY_AT),
    );
    expect(edited.revision).toBe(2);
    expect(edited.text).toBe('Contact me at [email]');
    expect(edited.expiresAt).toBe(item.expiresAt);
    const history = await f.store.transaction((state) => state.history);
    expect(history.map((row) => row.revision)).toEqual([1, 2]);
    expect(history[0].text).toBe(item.text);
  });
  it('denies edits after tenant disablement without changing state and still allows deletion', async () => {
    const f = memoryFixture();
    await f.enable();
    const item = await f.put();
    const before = await f.store.transaction((state) => state);
    f.setTenant(false);
    const command = { id: item.id, agent: item.agent, revision: item.revision };
    await expect(
      reviseMemory(
        f.store,
        f.policy,
        aliceScope,
        { ...command, text: 'disabled edit' },
        new Date(MEMORY_AT),
      ),
    ).rejects.toBeInstanceOf(MemoryDenied);
    expect(await f.store.transaction((state) => state)).toEqual(before);
    await deleteMemory(f.store, aliceScope, command, new Date(MEMORY_AT));
    expect(await f.store.transaction((state) => state.items)).toEqual([]);
    expect(await f.store.transaction((state) => state.history)).toEqual([]);
  });
  it('stale edits do not overwrite a newer revision', async () => {
    const f = memoryFixture();
    await f.enable();
    const item = await f.put();
    const command = { id: item.id, agent: item.agent, revision: 1, text: 'first edit' };
    await reviseMemory(f.store, f.policy, aliceScope, command, new Date(MEMORY_AT));
    await expect(
      reviseMemory(
        f.store,
        f.policy,
        aliceScope,
        { ...command, text: 'stale edit' },
        new Date(MEMORY_AT),
      ),
    ).rejects.toThrow('conflict');
    expect((await recallMemory(f.store, f.policy, aliceScope))[0].text).toBe('first edit');
    expect(await f.store.transaction((state) => state.history)).toHaveLength(2);
  });
  it('concurrent edits serialize and exactly one wins', async () => {
    const f = memoryFixture();
    await f.enable();
    const item = await f.put();
    const results = await Promise.allSettled(
      ['one', 'two'].map((text) =>
        reviseMemory(
          f.store,
          f.policy,
          aliceScope,
          { id: item.id, agent: item.agent, revision: 1, text },
          new Date(MEMORY_AT),
        ),
      ),
    );
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
    expect(await f.store.transaction((state) => state.history)).toHaveLength(2);
  });
  it('rejects agent mismatch instead of moving a memory between agents', async () => {
    const f = memoryFixture();
    await f.enable();
    const item = await f.put();
    await expect(
      reviseMemory(
        f.store,
        f.policy,
        aliceScope,
        { id: item.id, agent: 'other', revision: 1, text: 'changed' },
        new Date(MEMORY_AT),
      ),
    ).rejects.toBeInstanceOf(MemoryDenied);
    expect((await recallMemory(f.store, f.policy, aliceScope))[0].agent).toBe('assistant');
  });
  it('does not resurrect physically purged ids', async () => {
    const f = memoryFixture();
    await f.enable();
    const proposal = memoryProposal();
    const item = await f.put(proposal);
    await deleteMemory(
      f.store,
      aliceScope,
      { id: item.id, agent: item.agent, revision: 1 },
      new Date(MEMORY_AT),
    );
    await expect(f.put(proposal)).rejects.toBeInstanceOf(MemoryDenied);
    expect(await f.store.transaction((state) => state.history)).toEqual([]);
  });
});
