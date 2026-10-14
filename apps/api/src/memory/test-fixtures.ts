import { randomUUID } from 'node:crypto';

import { createInMemoryUserMemoryStore } from '../ports/memory/user-memory.js';

import { changeConsent } from './consent.js';
import { proposeMemory } from './write.js';

import type { MemoryPolicy, MemoryStore } from '../ports/user-memory.js';
import type { MemoryProposal, MemoryScope } from '@agent-works/domain/user-memory';
export const MEMORY_AT = '2026-10-14T00:00:00.000Z';
export const aliceScope: MemoryScope = { tenant: 'tenant-a', owner: 'alice', agent: 'assistant' };
export const bobScope: MemoryScope = { ...aliceScope, owner: 'bob' };
export function memoryProposal(overrides: Partial<MemoryProposal> = {}): MemoryProposal {
  return {
    id: randomUUID(),
    text: 'I prefer concise answers',
    classification: 'INTERNAL',
    ttlSeconds: 3600,
    origin: {
      kind: 'user-turn',
      taskId: 'task-alice',
      turnId: 'turn-1',
      subject: 'alice',
      sourceRef: null,
    },
    ...overrides,
  };
}
export function memoryFixture(store: MemoryStore = createInMemoryUserMemoryStore()) {
  let now = new Date(MEMORY_AT);
  let tenant = true;
  let acl = true;
  const policy: MemoryPolicy = {
    now: () => new Date(now),
    tenantEnabled: () => Promise.resolve(tenant),
    sourceAllowed: () => Promise.resolve(acl),
  };
  return {
    store,
    policy,
    scope: aliceScope,
    setTime: (value: Date) => {
      now = value;
    },
    setTenant: (value: boolean) => {
      tenant = value;
    },
    setAcl: (value: boolean) => {
      acl = value;
    },
    enable: () =>
      changeConsent(
        store,
        aliceScope,
        { enabled: true, revision: 0, noticeVersion: 'memory-v1' },
        now,
      ),
    put: (proposal = memoryProposal()) => proposeMemory(store, policy, aliceScope, proposal),
  };
}
