import { fileURLToPath } from 'node:url';

import { defineProject } from 'vitest/config';

export default defineProject({
  resolve: {
    alias: {
      '@agent-works/agent-runtime/port': fileURLToPath(
        new URL('./src/runner-port.ts', import.meta.url),
      ),
      '@agent-works/agent-runtime': fileURLToPath(new URL('./src/index.ts', import.meta.url)),
      '@agent-works/incident-analysis': fileURLToPath(
        new URL('../../agents/skills/incident-analysis/deliver.ts', import.meta.url),
      ),
      '@agent-works/domain/workspace-tools': fileURLToPath(
        new URL('../domain/src/workspace-tools.ts', import.meta.url),
      ),
      '@agent-works/domain/data-governance': fileURLToPath(
        new URL('../domain/src/data-governance.ts', import.meta.url),
      ),
      '@agent-works/domain/delegation-authority': fileURLToPath(
        new URL('../domain/src/delegation-authority.ts', import.meta.url),
      ),
      '@agent-works/domain/delegation': fileURLToPath(
        new URL('../domain/src/delegation.ts', import.meta.url),
      ),
      '@agent-works/domain/budget': fileURLToPath(
        new URL('../domain/src/budget.ts', import.meta.url),
      ),
      '@agent-works/domain': fileURLToPath(new URL('../domain/src/index.ts', import.meta.url)),
      '@agent-works/policy': fileURLToPath(new URL('../policy/src/index.ts', import.meta.url)),
      '@agent-works/fakes': fileURLToPath(new URL('../fakes/src/index.ts', import.meta.url)),
    },
  },
  test: {
    name: '@agent-works/agent-runtime',
    include: ['src/**/*.{test,spec}.ts'],
    exclude: ['dist/**'],
  },
});
