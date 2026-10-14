import { memoryListSchema } from '@agent-works/domain/user-memory';

import { listOwnMemories } from '../memory/export.js';
import { recallMemory } from '../memory/recall.js';

import { ownMemoryRoute, parseMemoryBody } from './memory-auth.js';

import type { MemoryRouteDeps } from './memory-auth.js';
export function memoryReadRoutes(deps: MemoryRouteDeps) {
  return {
    'GET /v1/memory': ownMemoryRoute(deps, async (scope) => ({
      status: 200,
      body: { items: await listOwnMemories(deps.store, deps.policy, scope) },
    })),
    'POST /v1/memory/list': ownMemoryRoute(deps, async (scope, request) => {
      const command = memoryListSchema.parse(parseMemoryBody(request));
      return {
        status: 200,
        body: {
          items: await recallMemory(deps.store, deps.policy, { ...scope, agent: command.agent }),
        },
      };
    }),
    'GET /v1/memory/export': ownMemoryRoute(deps, async (scope) => ({
      status: 200,
      body: {
        version: 'memory-v1',
        exportedAt: deps.policy.now().toISOString(),
        items: await listOwnMemories(deps.store, deps.policy, scope),
      },
    })),
  };
}
