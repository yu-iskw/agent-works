import { randomUUID } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { requestDeletion, processDeletion } from '../governance/deletion-requests.js';
import { changeLegalHold } from '../governance/holds.js';
import { createMemoryGovernancePort } from '../ports/memory/governance.js';
import { createInMemoryUserMemoryStore } from '../ports/memory/user-memory.js';

import { changeConsent } from './consent.js';
import { governUserMemory } from './governance.js';
import { sweepMemory } from './lifecycle.js';
import { deleteMemory } from './manage.js';
import { recallMemory } from './recall.js';
import { restoreUserMemory } from './restore.js';
import { memoryFixture, memoryProposal, MEMORY_AT, aliceScope } from './test-fixtures.js';
function setup() {
  const governance = createMemoryGovernancePort();
  const raw = createInMemoryUserMemoryStore();
  const now = () => new Date(MEMORY_AT);
  const store = governUserMemory(raw, governance, now);
  return { ...memoryFixture(store), governance, raw };
}
describe('governance controls user memory', () => {
  it.each([
    ['owner', 'expiry'],
    ['source', 'expiry'],
    ['record', 'expiry'],
    ['owner', 'opt-out'],
    ['source', 'opt-out'],
    ['record', 'opt-out'],
  ] as const)('restore preserves a current %s hold during %s replay', async (kind, reason) => {
    const f = setup();
    await f.enable();
    const proposal = memoryProposal();
    proposal.origin.sourceRef = 'doc';
    const item = await f.put(proposal);
    const backup = await f.raw.transaction((state) => state);
    const evidence = structuredClone(backup);
    expect(evidence.items[0].legalHold).toBe(false);
    if (reason === 'opt-out') evidence.consents[0].enabled = false;
    await changeLegalHold(
      f.governance,
      {
        commandId: randomUUID(),
        target: { kind, id: kind === 'owner' ? item.owner : kind === 'source' ? 'doc' : item.id },
        action: 'set',
        reasonRef: 'case',
      },
      'officer',
      new Date(MEMORY_AT),
    );
    const restoredRaw = createInMemoryUserMemoryStore(backup);
    const restored = governUserMemory(restoredRaw, f.governance, () => new Date(MEMORY_AT));
    const at = new Date(reason === 'expiry' ? item.expiresAt : MEMORY_AT);
    expect(await restoreUserMemory(restored, evidence, at)).toBe(0);
    const state = await restoredRaw.transaction((state) => state);
    expect(state.items).toEqual([{ ...item, legalHold: true, state: 'sealed' }]);
    expect(state.history).toEqual(backup.history);
    expect(state.tombstones).toEqual([]);
    expect(await restoreUserMemory(restored, evidence, at)).toBe(0);
    expect(await restoredRaw.transaction((state) => state)).toEqual(state);
  });
  it('restore honors a current hold release despite stale held memory evidence', async () => {
    const f = setup();
    await f.enable();
    const item = await f.put();
    const target = { kind: 'owner' as const, id: item.owner };
    await changeLegalHold(
      f.governance,
      { commandId: randomUUID(), target, action: 'set', reasonRef: 'case' },
      'officer',
      new Date(MEMORY_AT),
    );
    const backup = await f.store.transaction((state) => state);
    expect(backup.items[0].legalHold).toBe(true);
    await changeLegalHold(
      f.governance,
      { commandId: randomUUID(), target, action: 'release', reasonRef: 'case' },
      'officer',
      new Date(MEMORY_AT),
    );
    const restoredRaw = createInMemoryUserMemoryStore(backup);
    const restored = governUserMemory(restoredRaw, f.governance, () => new Date(MEMORY_AT));
    expect(await restoreUserMemory(restored, backup, new Date(item.expiresAt))).toBe(1);
    const state = await restoredRaw.transaction((state) => state);
    expect(state.items).toEqual([]);
    expect(state.history).toEqual([]);
  });
  it('fans an ordinary deletion request out to current and historical memory', async () => {
    const f = setup();
    await f.enable();
    await f.put();
    const requestId = randomUUID();
    await requestDeletion(
      f.governance,
      { requestId, subject: 'alice', reasonRef: 'case' },
      'officer',
      new Date(MEMORY_AT),
    );
    const result = await processDeletion(f.governance, requestId, 'officer', new Date(MEMORY_AT));
    expect(result.state).toBe('PURGED');
    expect(await f.raw.transaction((state) => state.items)).toEqual([]);
    expect(await f.raw.transaction((state) => state.history)).toEqual([]);
  });
  it('preserves new memories after completed deletion while purging restored older rows', async () => {
    const f = setup();
    await f.enable();
    const old = await f.put();
    const backup = await f.raw.transaction((state) => state);
    const requestId = randomUUID();
    await requestDeletion(
      f.governance,
      { requestId, subject: 'alice', reasonRef: 'case' },
      'officer',
      new Date(MEMORY_AT),
    );
    const completedAt = new Date(Date.parse(MEMORY_AT) + 1000);
    expect((await processDeletion(f.governance, requestId, 'officer', completedAt)).state).toBe(
      'PURGED',
    );
    f.setTime(new Date(completedAt.getTime() + 1));
    const fresh = await f.put();
    expect(await recallMemory(f.store, f.policy, aliceScope)).toEqual([fresh]);
    expect(await f.raw.transaction((state) => state.history)).toEqual([fresh]);
    const restoredRaw = createInMemoryUserMemoryStore({
      ...backup,
      items: [old, fresh],
      history: [old, fresh],
    });
    const restored = governUserMemory(restoredRaw, f.governance, f.policy.now);
    expect(await recallMemory(restored, f.policy, aliceScope)).toEqual([fresh]);
    expect(await restoredRaw.transaction((state) => state.history)).toEqual([fresh]);
  });
  it('held memory prevents deletion completion until release', async () => {
    const f = setup();
    await f.enable();
    const item = await f.put();
    const target = { kind: 'owner' as const, id: 'alice' };
    await changeLegalHold(
      f.governance,
      { commandId: randomUUID(), target, action: 'set', reasonRef: 'case' },
      'officer',
      new Date(MEMORY_AT),
    );
    const requestId = randomUUID();
    await requestDeletion(
      f.governance,
      { requestId, subject: 'alice', reasonRef: 'case' },
      'officer',
      new Date(MEMORY_AT),
    );
    expect(
      (await processDeletion(f.governance, requestId, 'officer', new Date(MEMORY_AT))).state,
    ).toBe('HELD');
    expect(await recallMemory(f.store, f.policy, aliceScope)).toEqual([]);
    expect((await f.raw.transaction((state) => state.items))[0].id).toBe(item.id);
    await changeLegalHold(
      f.governance,
      { commandId: randomUUID(), target, action: 'release', reasonRef: 'case' },
      'officer',
      new Date(MEMORY_AT),
    );
    expect(
      (await processDeletion(f.governance, requestId, 'officer', new Date(MEMORY_AT))).state,
    ).toBe('PURGED');
    expect(await f.raw.transaction((state) => state.history)).toEqual([]);
  });
  it('a governance record hold blocks own delete and expiry sweep', async () => {
    const f = setup();
    await f.enable();
    const item = await f.put();
    await changeLegalHold(
      f.governance,
      {
        commandId: randomUUID(),
        target: { kind: 'record', id: item.id },
        action: 'set',
        reasonRef: 'case',
      },
      'officer',
      new Date(MEMORY_AT),
    );
    await expect(
      deleteMemory(
        f.store,
        aliceScope,
        { id: item.id, agent: item.agent, revision: 1 },
        new Date(MEMORY_AT),
      ),
    ).rejects.toThrow('hold');
    expect(await sweepMemory(f.store, new Date(item.expiresAt))).toBe(0);
  });
  it('restore evidence in governance re-purges stale raw memory on next access', async () => {
    const f = setup();
    await f.enable();
    await f.put();
    const backup = await f.raw.transaction((state) => state);
    const requestId = randomUUID();
    await requestDeletion(
      f.governance,
      { requestId, subject: 'alice', reasonRef: 'case' },
      'officer',
      new Date(MEMORY_AT),
    );
    await processDeletion(f.governance, requestId, 'officer', new Date(MEMORY_AT));
    const restoredRaw = createInMemoryUserMemoryStore(backup);
    const restored = governUserMemory(restoredRaw, f.governance, () => new Date(MEMORY_AT));
    expect(await recallMemory(restored, f.policy, aliceScope)).toEqual([]);
    expect(await restoredRaw.transaction((state) => state.history)).toEqual([]);
  });
});

it('hold release purges previously sealed rows even after a fresh opt-in', async () => {
  const f = setup();
  await f.enable();
  const item = await f.put();
  const target = { kind: 'owner' as const, id: 'alice' };
  await changeLegalHold(
    f.governance,
    { commandId: randomUUID(), target, action: 'set', reasonRef: 'hold' },
    'officer',
    new Date(MEMORY_AT),
  );
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
  expect(await recallMemory(f.store, f.policy, aliceScope)).toEqual([]);
  await changeLegalHold(
    f.governance,
    { commandId: randomUUID(), target, action: 'release', reasonRef: 'hold' },
    'officer',
    new Date(MEMORY_AT),
  );
  expect(await f.store.transaction((state) => state.items.some((row) => row.id === item.id))).toBe(
    false,
  );
  expect(await f.raw.transaction((state) => state.history)).toEqual([]);
});
