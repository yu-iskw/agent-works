import { describe, expect, it } from 'vitest';

import { holdMemory, sweepMemory } from './lifecycle.js';
import { recallMemory } from './recall.js';
import { memoryFixture, memoryProposal, aliceScope, MEMORY_AT } from './test-fixtures.js';

describe('TTL and retention sweeping', () => {
  it('stops recalling at the exact expiry boundary', async () => {
    const f = memoryFixture();
    await f.enable();
    const item = await f.put(memoryProposal({ ttlSeconds: 60 }));
    f.setTime(new Date(Date.parse(item.expiresAt) - 1));
    expect(await recallMemory(f.store, f.policy, aliceScope)).toHaveLength(1);
    f.setTime(new Date(item.expiresAt));
    expect(await recallMemory(f.store, f.policy, aliceScope)).toEqual([]);
  });
  it('sweeper physically removes expired history and is idempotent', async () => {
    const f = memoryFixture();
    await f.enable();
    const item = await f.put(memoryProposal({ ttlSeconds: 60 }));
    expect(await sweepMemory(f.store, new Date(item.expiresAt))).toBe(1);
    expect(await sweepMemory(f.store, new Date(item.expiresAt))).toBe(0);
    const state = await f.store.transaction((state) => state);
    expect(state.items).toEqual([]);
    expect(state.history).toEqual([]);
    expect(state.tombstones[0].reason).toBe('expiry');
  });
  it('retains held expired memory without recalling it', async () => {
    const f = memoryFixture();
    await f.enable();
    const item = await f.put(memoryProposal({ ttlSeconds: 60 }));
    await holdMemory(f.store, aliceScope, item.id, true, new Date(MEMORY_AT));
    f.setTime(new Date(item.expiresAt));
    expect(await sweepMemory(f.store, f.policy.now())).toBe(0);
    expect(await recallMemory(f.store, f.policy, aliceScope)).toEqual([]);
    expect(await f.store.transaction((state) => state.items)).toHaveLength(1);
    await holdMemory(f.store, aliceScope, item.id, false, f.policy.now());
    expect(await sweepMemory(f.store, f.policy.now())).toBe(1);
  });
  it('preserves unexpired memory when sweeping other items', async () => {
    const f = memoryFixture();
    await f.enable();
    const short = await f.put(memoryProposal({ ttlSeconds: 60 }));
    const long = await f.put(memoryProposal({ ttlSeconds: 3600 }));
    expect(await sweepMemory(f.store, new Date(short.expiresAt))).toBe(1);
    expect((await f.store.transaction((state) => state.items)).map((row) => row.id)).toEqual([
      long.id,
    ]);
  });
});
