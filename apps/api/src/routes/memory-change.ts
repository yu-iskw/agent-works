import { memoryDeleteSchema, memoryEditSchema } from '@agent-works/domain/user-memory';

import { deleteMemory, reviseMemory } from '../memory/manage.js';

import { ownMemoryRoute, parseMemoryBody } from './memory-auth.js';

import type { MemoryRouteDeps } from './memory-auth.js';
export function memoryChangeRoutes(deps: MemoryRouteDeps) {
  return {
    'POST /v1/memory/edit': ownMemoryRoute(deps, async (scope, request) => {
      const command = memoryEditSchema.parse(parseMemoryBody(request));
      return {
        status: 200,
        body: {
          item: await reviseMemory(
            deps.store,
            deps.policy,
            { ...scope, agent: command.agent },
            command,
            deps.policy.now(),
          ),
        },
      };
    }),
    'POST /v1/memory/delete': ownMemoryRoute(deps, async (scope, request) => {
      const command = memoryDeleteSchema.parse(parseMemoryBody(request));
      await deleteMemory(
        deps.store,
        { ...scope, agent: command.agent },
        command,
        deps.policy.now(),
      );
      return { status: 200, body: { deleted: true } };
    }),
  };
}
