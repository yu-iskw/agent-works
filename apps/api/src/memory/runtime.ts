import { createApp } from '../app.js';
import { createInMemoryUserMemoryStore } from '../ports/memory/user-memory.js';
import { createPostgresUserMemoryStore } from '../ports/user-memory-postgres.js';

import { governUserMemory } from './governance.js';
import { sweepMemory } from './lifecycle.js';
import { createMemoryBankStub } from './memory-bank.js';
import { restoreUserMemory } from './restore.js';
import { createMemoryRecallHook } from './runner.js';
import { proposeMemory } from './write.js';

import type { RunnerInput } from '../agent/runner-port.js';
import type { GovernancePort } from '../ports/governance.js';
import type { MemoryPolicy, MemoryState, MemoryStore } from '../ports/user-memory.js';
import type { RouteDeps } from '../routes/index.js';
import type { MemoryRouteDeps } from '../routes/memory-auth.js';
import type { MemoryScope, MemoryProposal } from '@agent-works/domain/user-memory';
import type postgres from 'postgres';
export type UserMemoryRuntimeOptions = {
  store?: MemoryStore;
  postgres?: postgres.Sql;
  memoryBank?: boolean;
  governance: GovernancePort;
  policy?: MemoryPolicy;
  tenantFor: MemoryRouteDeps['tenantFor'];
  scopeFor: (input: RunnerInput) => Promise<MemoryScope>;
};
/** Explicit composition only; no environment flags silently turn memory on. */
export function createUserMemoryRuntime(options: UserMemoryRuntimeOptions) {
  const policy: MemoryPolicy = options.policy ?? {
    tenantEnabled: () => Promise.resolve(false),
    sourceAllowed: () => Promise.resolve(false),
    now: () => new Date(),
  };
  const raw =
    options.store ??
    (options.memoryBank === true
      ? createMemoryBankStub(true)
      : options.postgres === undefined
        ? createInMemoryUserMemoryStore()
        : createPostgresUserMemoryStore(options.postgres));
  const store = governUserMemory(raw, options.governance, policy.now);
  return {
    store,
    propose: async (context: RunnerInput, proposal: MemoryProposal) =>
      proposeMemory(store, policy, await options.scopeFor(context), proposal),
    recall: createMemoryRecallHook(store, policy, options.scopeFor),
    app: (deps: RouteDeps) =>
      createApp({
        ...deps,
        governance: {
          port: options.governance,
          rolesFor:
            deps.governance?.rolesFor ?? deps.admin?.rolesFor ?? (() => Promise.resolve([])),
        },
        userMemory: {
          verify: deps.verify,
          tenantFor: options.tenantFor,
          store,
          policy,
        },
      }),
    sweep: () => sweepMemory(store, policy.now()),
    restore: (evidence: MemoryState) => restoreUserMemory(store, evidence, policy.now()),
  };
}
