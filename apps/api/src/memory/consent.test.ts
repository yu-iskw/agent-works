import { describe, expect, it } from 'vitest';

import { MemoryDenied } from '../ports/user-memory.js';

import { changeConsent, readConsent } from './consent.js';
import { reviseMemory } from './manage.js';
import { recallMemory } from './recall.js';
import { memoryFixture, aliceScope, bobScope, MEMORY_AT } from './test-fixtures.js';

describe('memory consent defaults and transitions', () => {
  it('defaults off with a visible notice version and no fabricated revision', async () => {
    const f = memoryFixture();
    const consent = await readConsent(f.store, aliceScope, new Date(MEMORY_AT));
    expect(consent.enabled).toBe(false);
    expect(consent.revision).toBe(0);
    expect(consent.noticeVersion).toBe('memory-v1');
    await expect(f.put()).rejects.toBeInstanceOf(MemoryDenied);
    expect(await recallMemory(f.store, f.policy, aliceScope)).toEqual([]);
    expect(await f.store.transaction((state) => state.items)).toEqual([]);
  });
  it('requires both tenant activation and user opt-in', async () => {
    const f = memoryFixture();
    await f.enable();
    f.setTenant(false);
    await expect(f.put()).rejects.toBeInstanceOf(MemoryDenied);
    f.setTenant(true);
    await f.put();
    f.setTenant(false);
    expect(await recallMemory(f.store, f.policy, aliceScope)).toEqual([]);
  });
  it('rejects stale consent commands without changing evidence', async () => {
    const f = memoryFixture();
    await f.enable();
    const before = await f.store.transaction((state) => state);
    await expect(f.enable()).rejects.toThrow('conflict');
    expect(await f.store.transaction((state) => state)).toEqual(before);
  });
  it('purges current and historical content on opt-out', async () => {
    const f = memoryFixture();
    await f.enable();
    const item = await f.put();
    await reviseMemory(
      f.store,
      f.policy,
      aliceScope,
      { id: item.id, agent: item.agent, revision: 1, text: 'Use bullet points' },
      new Date(MEMORY_AT),
    );
    const consent = await changeConsent(
      f.store,
      aliceScope,
      { enabled: false, revision: 1, noticeVersion: 'memory-v1' },
      new Date(MEMORY_AT),
    );
    expect(consent.revision).toBe(2);
    expect(consent.enabled).toBe(false);
    const state = await f.store.transaction((state) => state);
    expect(state.items).toEqual([]);
    expect(state.history).toEqual([]);
    expect(state.tombstones).toHaveLength(1);
    expect(JSON.stringify(state.audit)).not.toContain('bullet points');
    expect(await recallMemory(f.store, f.policy, aliceScope)).toEqual([]);
  });
  it('consent covers owner agents but not other tenants or users', async () => {
    const f = memoryFixture();
    await f.enable();
    expect(
      (await readConsent(f.store, { ...aliceScope, agent: 'another' }, new Date(MEMORY_AT)))
        .enabled,
    ).toBe(true);
    expect((await readConsent(f.store, bobScope, new Date(MEMORY_AT))).enabled).toBe(false);
    expect(
      (await readConsent(f.store, { ...aliceScope, tenant: 'tenant-b' }, new Date(MEMORY_AT)))
        .enabled,
    ).toBe(false);
  });
  it.each([
    { enabled: true, revision: 0, noticeVersion: 'old' },
    { enabled: 'true', revision: 0, noticeVersion: 'memory-v1' },
    { enabled: true, revision: -1, noticeVersion: 'memory-v1' },
    { enabled: true, revision: 0, noticeVersion: 'memory-v1', owner: 'bob' },
  ])('rejects malformed consent %#', async (command) => {
    const f = memoryFixture();
    await expect(
      changeConsent(f.store, aliceScope, command, new Date(MEMORY_AT)),
    ).rejects.toThrow();
    expect(await f.store.transaction((state) => state.consents)).toEqual([]);
  });
});
