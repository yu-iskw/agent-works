import { describe, expect, it } from 'vitest';

import { createMemoryGovernancePort } from '../ports/memory/governance.js';

import { changeConsent } from './consent.js';
import { createUserMemoryRuntime } from './runtime.js';
import { memoryFixture, memoryProposal, aliceScope, MEMORY_AT } from './test-fixtures.js';

describe('offline runtime composition', () => {
  it('composes local memory behind explicit tenant policy', async () => {
    const f = memoryFixture();
    const runtime = createUserMemoryRuntime({
      governance: createMemoryGovernancePort(),
      policy: f.policy,
      tenantFor: () => Promise.resolve('tenant-a'),
      scopeFor: () => Promise.resolve(aliceScope),
    });
    expect(await runtime.recall({ question: 'hello', sources: [] })).toBe('');
    await changeConsent(
      runtime.store,
      aliceScope,
      { enabled: true, revision: 0, noticeVersion: 'memory-v1' },
      new Date(MEMORY_AT),
    );
    await runtime.propose({ question: 'hello', sources: [] }, memoryProposal());
    expect(await runtime.recall({ question: 'hello', sources: [] })).toContain('concise');
    expect(await runtime.sweep()).toBe(0);
    const evidence = await runtime.store.transaction((state) => state);
    expect(await runtime.restore(evidence)).toBe(0);
    expect(typeof runtime.app).toBe('function');
  });
  it('enabled managed flag is a typed unavailable stub', async () => {
    const f = memoryFixture();
    const runtime = createUserMemoryRuntime({
      memoryBank: true,
      governance: createMemoryGovernancePort(),
      policy: f.policy,
      tenantFor: () => Promise.resolve('tenant-a'),
      scopeFor: () => Promise.resolve(aliceScope),
    });
    await expect(runtime.store.transaction((state) => state.items)).rejects.toThrow(
      'operator evidence pending',
    );
  });
});

it('runtime defaults tenant policy off even after a user enables consent', async () => {
  const runtime = createUserMemoryRuntime({
    governance: createMemoryGovernancePort(),
    tenantFor: () => Promise.resolve('tenant-a'),
    scopeFor: () => Promise.resolve(aliceScope),
  });
  await changeConsent(
    runtime.store,
    aliceScope,
    { enabled: true, revision: 0, noticeVersion: 'memory-v1' },
    new Date(MEMORY_AT),
  );
  expect(await runtime.recall({ question: 'hello', sources: [] })).toBe('');
  await expect(
    runtime.propose({ question: 'hello', sources: [] }, memoryProposal()),
  ).rejects.toThrow('memory disabled');
  expect(await runtime.store.transaction((state) => state.items)).toEqual([]);
});
