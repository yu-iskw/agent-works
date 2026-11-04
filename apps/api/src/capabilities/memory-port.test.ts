import { describe, expect, it, vi } from 'vitest';

import { createCapabilityGuard, CapabilityDisabledError, sealGateRecord } from './gate.js';
import {
  createInMemoryMemory,
  disabledMemory,
  guardMemory,
  MemoryUnavailableError,
  recoverTask,
} from './memory-port.js';

const now = new Date('2026-11-03T00:00:00Z');
const target = { project: 'proj-a', scope: 'team-x', digest: 'b'.repeat(64) };
const alice = { user: 'alice', agent: 'a1' };
const bob = { user: 'bob', agent: 'a1' };
const goRecord = sealGateRecord({
  ...target,
  capability: 'managedMemory',
  verdict: 'GO',
  signedOffBy: 'operator@example.test',
  approvalRef: 'GATE-2',
  signedOffAt: '2026-11-02T00:00:00Z',
  expiresAt: '2026-12-01T00:00:00Z',
});

describe('guarded memory', () => {
  it('is denied by default and never reaches the adapter', async () => {
    const adapter = { recall: vi.fn(), remember: vi.fn(), forget: vi.fn() };
    const memory = guardMemory(createCapabilityGuard(), target, adapter, () => now);
    await expect(memory.recall(alice, 3)).rejects.toBeInstanceOf(CapabilityDisabledError);
    await expect(memory.remember(alice, 'x')).rejects.toBeInstanceOf(CapabilityDisabledError);
    await expect(memory.forget(alice, 'm')).rejects.toBeInstanceOf(CapabilityDisabledError);
    expect(adapter.recall).not.toHaveBeenCalled();
    expect(adapter.remember).not.toHaveBeenCalled();
  });

  it('isolates users and deletes when enabled by a GO record', async () => {
    const memory = guardMemory(
      createCapabilityGuard([goRecord]),
      target,
      createInMemoryMemory(),
      () => now,
    );
    const id = await memory.remember(alice, 'prefers short answers');
    expect(await memory.recall(bob, 5)).toEqual([]);
    expect(await memory.forget(bob, id)).toBe(false);
    expect(await memory.recall(alice, 5)).toEqual([{ id, text: 'prefers short answers' }]);
    expect(await memory.forget(alice, id)).toBe(true);
    expect(await memory.recall(alice, 5)).toEqual([]);
  });

  it('the disabled implementation always reports unavailable', async () => {
    await expect(disabledMemory.recall(alice, 1)).rejects.toBeInstanceOf(MemoryUnavailableError);
  });
});

describe('core task recovery without the memory adapter', () => {
  const state = { taskId: 't1', status: 'running', step: 3 };
  const loadAuthoritative = (): Promise<typeof state> => Promise.resolve(state);

  it('recovers from authoritative state with no adapter configured', async () => {
    const result = await recoverTask({
      loadAuthoritative,
      memory: undefined,
      scope: alice,
      hintLimit: 3,
    });
    expect(result).toEqual({ state, hints: [], memory: 'disabled' });
  });

  it('recovers when the guard denies memory', async () => {
    const memory = guardMemory(createCapabilityGuard(), target, createInMemoryMemory(), () => now);
    const result = await recoverTask({ loadAuthoritative, memory, scope: alice, hintLimit: 3 });
    expect(result).toEqual({ state, hints: [], memory: 'disabled' });
  });

  it('recovers when the adapter is unavailable or throws', async () => {
    for (const memory of [
      disabledMemory,
      { ...disabledMemory, recall: () => Promise.reject(new Error('503')) },
    ]) {
      const result = await recoverTask({ loadAuthoritative, memory, scope: alice, hintLimit: 3 });
      expect(result).toEqual({ state, hints: [], memory: 'unavailable' });
    }
  });

  it('never takes state from memory and fails when the authoritative store fails', async () => {
    const store = createInMemoryMemory();
    await store.remember(alice, 'status: completed');
    const result = await recoverTask({
      loadAuthoritative,
      memory: store,
      scope: alice,
      hintLimit: 3,
    });
    expect(result.state).toBe(state);
    expect(result.hints).toHaveLength(1);
    await expect(
      recoverTask({
        loadAuthoritative: () => Promise.reject(new Error('db down')),
        memory: store,
        scope: alice,
        hintLimit: 3,
      }),
    ).rejects.toThrow('db down');
  });
});
