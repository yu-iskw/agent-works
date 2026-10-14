import { describe, expect, it } from 'vitest';

import { MemoryDenied } from '../ports/user-memory.js';

import { changeConsent } from './consent.js';
import { revokeMemorySource } from './lifecycle.js';
import { reviseMemory } from './manage.js';
import { recallMemory } from './recall.js';
import { memoryFixture, memoryProposal, aliceScope, MEMORY_AT } from './test-fixtures.js';
import { proposeMemory } from './write.js';

describe('recall race fences', () => {
  it('does not return items after consent is revoked during ACL check', async () => {
    const f = memoryFixture();
    await f.enable();
    const proposal = memoryProposal();
    proposal.origin.sourceRef = 'doc';
    await f.put(proposal);
    const policy = {
      ...f.policy,
      sourceAllowed: async () => {
        await changeConsent(
          f.store,
          aliceScope,
          { enabled: false, revision: 1, noticeVersion: 'memory-v1' },
          new Date(MEMORY_AT),
        );
        return true;
      },
    };
    expect(await recallMemory(f.store, policy, aliceScope)).toEqual([]);
  });
  it('does not return stale revisions after concurrent edits during ACL check', async () => {
    const f = memoryFixture();
    await f.enable();
    const proposal = memoryProposal();
    proposal.origin.sourceRef = 'doc';
    const item = await f.put(proposal);
    const policy = {
      ...f.policy,
      sourceAllowed: async () => {
        await reviseMemory(
          f.store,
          f.policy,
          aliceScope,
          { id: item.id, agent: item.agent, revision: 1, text: 'updated' },
          new Date(MEMORY_AT),
        );
        return true;
      },
    };
    expect(await recallMemory(f.store, policy, aliceScope)).toEqual([]);
  });
  it('does not return rows revoked during ACL check', async () => {
    const f = memoryFixture();
    await f.enable();
    const proposal = memoryProposal();
    proposal.origin.sourceRef = 'doc';
    await f.put(proposal);
    const policy = {
      ...f.policy,
      sourceAllowed: async () => {
        await revokeMemorySource(f.store, 'doc', new Date(MEMORY_AT));
        return true;
      },
    };
    expect(await recallMemory(f.store, policy, aliceScope)).toEqual([]);
  });
  it('does not write after consent is revoked during proposal ACL check', async () => {
    const f = memoryFixture();
    await f.enable();
    const proposal = memoryProposal();
    proposal.origin.sourceRef = 'doc';
    const policy = {
      ...f.policy,
      sourceAllowed: async () => {
        await changeConsent(
          f.store,
          aliceScope,
          { enabled: false, revision: 1, noticeVersion: 'memory-v1' },
          new Date(MEMORY_AT),
        );
        return true;
      },
    };
    await expect(proposeMemory(f.store, policy, aliceScope, proposal)).rejects.toBeInstanceOf(
      MemoryDenied,
    );
    expect(await f.store.transaction((state) => state.items)).toEqual([]);
  });
});

it('drops items when tenant policy is disabled while live ACL is checked', async () => {
  const f = memoryFixture();
  await f.enable();
  const proposal = memoryProposal();
  proposal.origin.sourceRef = 'doc';
  await f.put(proposal);
  const policy = {
    ...f.policy,
    sourceAllowed: () => {
      f.setTenant(false);
      return Promise.resolve(true);
    },
  };
  expect(await recallMemory(f.store, policy, aliceScope)).toEqual([]);
});
it('rechecks expiry after the asynchronous live ACL step', async () => {
  const f = memoryFixture();
  await f.enable();
  const proposal = memoryProposal();
  proposal.origin.sourceRef = 'doc';
  const item = await f.put(proposal);
  const policy = {
    ...f.policy,
    sourceAllowed: () => {
      f.setTime(new Date(item.expiresAt));
      return Promise.resolve(true);
    },
  };
  expect(await recallMemory(f.store, policy, aliceScope)).toEqual([]);
});

it('rejects a proposal when tenant memory turns off during source authorization', async () => {
  const f = memoryFixture();
  await f.enable();
  const proposal = memoryProposal();
  proposal.origin.sourceRef = 'doc';
  const policy = {
    ...f.policy,
    sourceAllowed: () => {
      f.setTenant(false);
      return Promise.resolve(true);
    },
  };
  await expect(proposeMemory(f.store, policy, aliceScope, proposal)).rejects.toBeInstanceOf(
    MemoryDenied,
  );
  expect(await f.store.transaction((state) => state.items)).toEqual([]);
});
