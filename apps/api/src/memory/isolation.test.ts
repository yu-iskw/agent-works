import { describe, expect, it } from 'vitest';

import { MemoryDenied } from '../ports/user-memory.js';

import { changeConsent } from './consent.js';
import { listOwnMemories } from './export.js';
import { reviseMemory, deleteMemory } from './manage.js';
import { recallMemory } from './recall.js';
import { memoryFixture, memoryProposal, aliceScope, bobScope, MEMORY_AT } from './test-fixtures.js';
import { proposeMemory } from './write.js';

describe('tenant owner and agent isolation', () => {
  it.each([
    bobScope,
    { ...aliceScope, tenant: 'tenant-b' },
    { ...aliceScope, agent: 'other' },
    { ...aliceScope, owner: 'alice/../bob' },
    { ...aliceScope, agent: 'assistant/../other' },
  ])('cannot recall across scope %#', async (scope) => {
    const f = memoryFixture();
    await f.enable();
    await f.put();
    await changeConsent(
      f.store,
      scope,
      {
        enabled: true,
        revision: scope.owner === 'alice' && scope.tenant === 'tenant-a' ? 1 : 0,
        noticeVersion: 'memory-v1',
      },
      new Date(MEMORY_AT),
    );
    expect(await recallMemory(f.store, f.policy, scope)).toEqual([]);
    expect(await recallMemory(f.store, f.policy, aliceScope)).toHaveLength(1);
  });
  it('cannot revise or delete a known foreign id', async () => {
    const f = memoryFixture();
    await f.enable();
    const item = await f.put();
    const command = { id: item.id, agent: item.agent, revision: 1 };
    await expect(
      reviseMemory(
        f.store,
        f.policy,
        bobScope,
        { ...command, text: 'forged' },
        new Date(MEMORY_AT),
      ),
    ).rejects.toThrow();
    await expect(deleteMemory(f.store, bobScope, command, new Date(MEMORY_AT))).rejects.toThrow();
    expect((await recallMemory(f.store, f.policy, aliceScope))[0].text).toBe(item.text);
  });
  it('rejects turn provenance for a different subject', async () => {
    const f = memoryFixture();
    await f.enable();
    const proposal = memoryProposal();
    proposal.origin.subject = 'bob';
    await expect(f.put(proposal)).rejects.toBeInstanceOf(MemoryDenied);
    expect(await f.store.transaction((state) => state.items)).toEqual([]);
  });
  it('uses tuple equality for scopes containing separators', async () => {
    const f = memoryFixture();
    const a = { tenant: 'a:b', owner: 'c', agent: 'd' };
    const b = { tenant: 'a', owner: 'b:c', agent: 'd' };
    await changeConsent(
      f.store,
      a,
      { enabled: true, revision: 0, noticeVersion: 'memory-v1' },
      new Date(MEMORY_AT),
    );
    const proposal = memoryProposal();
    proposal.origin.subject = 'c';
    await proposeMemory(f.store, f.policy, a, proposal);
    expect(await recallMemory(f.store, f.policy, b)).toEqual([]);
    expect(await recallMemory(f.store, f.policy, a)).toHaveLength(1);
  });
  it('does not expose mutable store references through reads', async () => {
    const f = memoryFixture();
    await f.enable();
    const item = await f.put();
    item.text = 'mutated';
    const rows = await recallMemory(f.store, f.policy, aliceScope);
    expect(rows[0].text).toBe('I prefer concise answers');
    rows[0].origin.subject = 'bob';
    expect((await recallMemory(f.store, f.policy, aliceScope))[0].origin.subject).toBe('alice');
  });
});

it('owner export spans own agents with per-scope live authorization', async () => {
  const f = memoryFixture();
  await f.enable();
  const own = await f.put();
  const proposal = memoryProposal();
  proposal.origin.sourceRef = 'doc';
  await proposeMemory(f.store, f.policy, { ...aliceScope, agent: 'other' }, proposal);
  expect(
    (await listOwnMemories(f.store, f.policy, aliceScope))
      .map((row) => row.agent)
      .sort((a, b) => a.localeCompare(b)),
  ).toEqual(['assistant', 'other']);
  f.setAcl(false);
  expect(await listOwnMemories(f.store, f.policy, aliceScope)).toEqual([own]);
  expect(await listOwnMemories(f.store, f.policy, bobScope)).toEqual([]);
});
