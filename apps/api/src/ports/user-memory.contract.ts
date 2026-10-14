import { describe, expect, it } from 'vitest';

import { changeConsent } from '../memory/consent.js';
import { sweepMemory, holdMemory } from '../memory/lifecycle.js';
import { deleteMemory, reviseMemory } from '../memory/manage.js';
import { recallMemory } from '../memory/recall.js';
import {
  memoryFixture,
  memoryProposal,
  aliceScope,
  bobScope,
  MEMORY_AT,
} from '../memory/test-fixtures.js';

import type { MemoryStore } from './user-memory.js';
/** The same behavior suite runs against memory and disposable Postgres. */
export function userMemoryContract(getStore: () => MemoryStore): void {
  describe('MemoryStore lifecycle contract', () => {
    it('commits and returns detached results', async () => {
      const f = memoryFixture(getStore());
      await f.enable();
      const item = await f.put();
      item.text = 'changed outside transaction';
      expect((await recallMemory(f.store, f.policy, aliceScope))[0].text).toBe(
        'I prefer concise answers',
      );
    });
    it('rolls back failed transactions', async () => {
      const store = getStore();
      await expect(
        store.transaction((state) => {
          state.revokedSources.push('rollback');
          throw new Error('abort');
        }),
      ).rejects.toThrow('abort');
      expect(await store.transaction((state) => state.revokedSources)).toEqual([]);
    });
    it('defaults both users off', async () => {
      const f = memoryFixture(getStore());
      await expect(f.put()).rejects.toThrow();
      expect(await recallMemory(f.store, f.policy, aliceScope)).toEqual([]);
      expect(await recallMemory(f.store, f.policy, bobScope)).toEqual([]);
    });
    it('persists consent, origin, TTL and revisions', async () => {
      const f = memoryFixture(getStore());
      await f.enable();
      const item = await f.put();
      await reviseMemory(
        f.store,
        f.policy,
        aliceScope,
        { id: item.id, agent: item.agent, revision: 1, text: 'Prefer diagrams' },
        new Date(MEMORY_AT),
      );
      const state = await f.store.transaction((state) => state);
      expect(state.consents[0].enabled).toBe(true);
      expect(state.items[0].origin.subject).toBe('alice');
      expect(state.items[0].revision).toBe(2);
      expect(state.history).toHaveLength(2);
    });
    it('serializes concurrent duplicate ids without losing evidence', async () => {
      const f = memoryFixture(getStore());
      await f.enable();
      const proposal = memoryProposal();
      const results = await Promise.allSettled([f.put(proposal), f.put(proposal)]);
      expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
      expect(await f.store.transaction((state) => state.items)).toHaveLength(1);
    });
    it('opt-out erases all revisions and leaves minimal tombstones', async () => {
      const f = memoryFixture(getStore());
      await f.enable();
      const item = await f.put();
      await reviseMemory(
        f.store,
        f.policy,
        aliceScope,
        { id: item.id, agent: item.agent, revision: 1, text: 'Changed preference' },
        new Date(MEMORY_AT),
      );
      await changeConsent(
        f.store,
        aliceScope,
        { enabled: false, revision: 1, noticeVersion: 'memory-v1' },
        new Date(MEMORY_AT),
      );
      const state = await f.store.transaction((state) => state);
      expect(state.items).toEqual([]);
      expect(state.history).toEqual([]);
      expect(state.tombstones).toHaveLength(1);
      expect(JSON.stringify(state.audit)).not.toContain('Changed preference');
    });
    it('does not reveal foreign memory by id or agent confusion', async () => {
      const f = memoryFixture(getStore());
      await f.enable();
      const item = await f.put();
      expect(await recallMemory(f.store, f.policy, bobScope)).toEqual([]);
      expect(await recallMemory(f.store, f.policy, { ...aliceScope, agent: 'other' })).toEqual([]);
      await expect(
        deleteMemory(
          f.store,
          bobScope,
          { id: item.id, agent: item.agent, revision: 1 },
          new Date(MEMORY_AT),
        ),
      ).rejects.toThrow();
      expect(await recallMemory(f.store, f.policy, aliceScope)).toHaveLength(1);
    });
    it('sweeps expired items and historical text', async () => {
      const f = memoryFixture(getStore());
      await f.enable();
      const item = await f.put(memoryProposal({ ttlSeconds: 60 }));
      expect(await sweepMemory(f.store, new Date(item.expiresAt))).toBe(1);
      expect(await f.store.transaction((state) => state.history)).toEqual([]);
    });
    it('seals held opt-out rows until release', async () => {
      const f = memoryFixture(getStore());
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
      await holdMemory(f.store, aliceScope, item.id, false, new Date(MEMORY_AT));
      expect(await f.store.transaction((state) => state.history)).toEqual([]);
    });
  });
}
