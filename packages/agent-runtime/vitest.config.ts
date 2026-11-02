import { fileURLToPath } from 'node:url';

import { defineProject } from 'vitest/config';

export default defineProject({
  resolve: {
    alias: {
      '@agent-works/domain/workspace-tools': fileURLToPath(
        new URL('../domain/src/workspace-tools.ts', import.meta.url),
      ),
      '@agent-works/domain/data-governance': fileURLToPath(
        new URL('../domain/src/data-governance.ts', import.meta.url),
      ),
      '@agent-works/domain': fileURLToPath(new URL('../domain/src/index.ts', import.meta.url)),
      '@agent-works/fakes': fileURLToPath(new URL('../fakes/src/index.ts', import.meta.url)),
    },
  },
  test: {
    name: '@agent-works/agent-runtime',
    include: ['src/**/*.{test,spec}.ts'],
    exclude: ['dist/**'],
  },
});
