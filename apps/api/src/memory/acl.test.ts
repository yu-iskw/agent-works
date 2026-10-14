import { describe, expect, it } from 'vitest';

import { MemoryDenied } from '../ports/user-memory.js';

import { revokeMemorySource } from './lifecycle.js';
import { recallMemory } from './recall.js';
import { memoryFixture, memoryProposal, aliceScope, MEMORY_AT } from './test-fixtures.js';

describe('live ACL checks for cited source memory', () => {
  it('drops a memory immediately after source access is lost', async () => {
    const f = memoryFixture();
    await f.enable();
    const proposal = memoryProposal();
    proposal.origin.sourceRef = 'drive/doc-a';
    await f.put(proposal);
    expect(await recallMemory(f.store, f.policy, aliceScope)).toHaveLength(1);
    f.setAcl(false);
    expect(await recallMemory(f.store, f.policy, aliceScope)).toEqual([]);
    expect(await f.store.transaction((state) => state.items)).toHaveLength(1);
  });
  it('rejects proposals citing a currently unauthorized source', async () => {
    const f = memoryFixture();
    await f.enable();
    f.setAcl(false);
    const proposal = memoryProposal();
    proposal.origin.sourceRef = 'private-doc';
    await expect(f.put(proposal)).rejects.toBeInstanceOf(MemoryDenied);
    expect(await f.store.transaction((state) => state.history)).toEqual([]);
  });
  it('fails closed for a source checker outage but keeps source-free preferences', async () => {
    const f = memoryFixture();
    await f.enable();
    const proposal = memoryProposal();
    proposal.origin.sourceRef = 'doc';
    await f.put(proposal);
    await f.put();
    const policy = {
      ...f.policy,
      sourceAllowed: () => Promise.reject(new Error('directory unavailable')),
    };
    const rows = await recallMemory(f.store, policy, aliceScope);
    expect(rows).toHaveLength(1);
    expect(rows[0].origin.sourceRef).toBeNull();
  });
  it('passes the entire trusted scope and source ref to authorization', async () => {
    const f = memoryFixture();
    await f.enable();
    const proposal = memoryProposal();
    proposal.origin.sourceRef = 'drive/folder/doc';
    await f.put(proposal);
    const seen: unknown[] = [];
    const policy = {
      ...f.policy,
      sourceAllowed: (scope: typeof aliceScope, ref: string) => {
        seen.push({ scope, ref });
        return Promise.resolve(true);
      },
    };
    await recallMemory(f.store, policy, aliceScope);
    expect(seen).toEqual([{ scope: aliceScope, ref: 'drive/folder/doc' }]);
  });
  it('permanent revocation prevents restoration by later ACL grants', async () => {
    const f = memoryFixture();
    await f.enable();
    const proposal = memoryProposal();
    proposal.origin.sourceRef = 'doc';
    await f.put(proposal);
    await revokeMemorySource(f.store, 'doc', new Date(MEMORY_AT));
    f.setAcl(true);
    expect(await recallMemory(f.store, f.policy, aliceScope)).toEqual([]);
    await expect(f.put(proposal)).rejects.toBeInstanceOf(MemoryDenied);
  });
});
