import { fileURLToPath } from 'node:url';

import { defineProject } from 'vitest/config';

export default defineProject({
  resolve: {
    alias: {
      '@agent-works/domain/workspace-tools': fileURLToPath(
        new URL('../../packages/domain/src/workspace-tools.ts', import.meta.url),
      ),
      '@agent-works/domain/user-memory': fileURLToPath(
        new URL('../../packages/domain/src/user-memory.ts', import.meta.url),
      ),
      '@agent-works/domain/user-memory-pii': fileURLToPath(
        new URL('../../packages/domain/src/user-memory-pii.ts', import.meta.url),
      ),
      '@agent-works/domain/workbench': fileURLToPath(
        new URL('../../packages/domain/src/workbench.ts', import.meta.url),
      ),
      '@agent-works/domain': fileURLToPath(
        new URL('../../packages/domain/src/index.ts', import.meta.url),
      ),
    },
  },
  oxc: {
    jsx: {
      runtime: 'classic',
      pragma: 'h',
      pragmaFrag: 'Fragment',
    },
  },
  test: {
    name: '@agent-works/web',
    include: ['app/**/*.test.{ts,tsx}'],
  },
});
