import { describe, expect, it } from 'vitest';

import { changeConsent } from './consent.js';
import { listOwnMemories } from './export.js';
import { holdMemory } from './lifecycle.js';
import { reviseMemory } from './manage.js';
import { memoryFixture, memoryProposal, aliceScope, MEMORY_AT } from './test-fixtures.js';
import { proposeMemory } from './write.js';

describe('owner export final revalidation', () => {
  it.each(['opt-out', 'revision', 'sealed'] as const)(
    'omits an earlier agent item after mid-export %s',
    async (change) => {
      const f = memoryFixture();
      await f.enable();
      const first = await f.put();
      const otherScope = { ...aliceScope, agent: 'second-agent' };
      const second = await proposeMemory(
        f.store,
        f.policy,
        otherScope,
        memoryProposal({ origin: { ...memoryProposal().origin, sourceRef: 'doc' } }),
      );
      const policy = {
        ...f.policy,
        async sourceAllowed() {
          if (change === 'revision') {
            await reviseMemory(
              f.store,
              f.policy,
              aliceScope,
              { id: first.id, agent: first.agent, revision: 1, text: 'replacement' },
              new Date(MEMORY_AT),
            );
          } else {
            if (change === 'sealed')
              await holdMemory(f.store, aliceScope, first.id, true, new Date(MEMORY_AT));
            await changeConsent(
              f.store,
              aliceScope,
              { enabled: false, revision: 1, noticeVersion: 'memory-v1' },
              new Date(MEMORY_AT),
            );
            if (change === 'sealed')
              await changeConsent(
                f.store,
                aliceScope,
                { enabled: true, revision: 2, noticeVersion: 'memory-v1' },
                new Date(MEMORY_AT),
              );
          }
          return true;
        },
      };
      expect(await listOwnMemories(f.store, policy, aliceScope)).toEqual(
        change === 'revision' ? [second] : [],
      );
    },
  );
  it('exports unchanged items across agents', async () => {
    const f = memoryFixture();
    await f.enable();
    const first = await f.put();
    const second = await proposeMemory(
      f.store,
      f.policy,
      { ...aliceScope, agent: 'second-agent' },
      memoryProposal(),
    );
    expect(await listOwnMemories(f.store, f.policy, aliceScope)).toEqual([first, second]);
  });
});
