import { fileURLToPath } from 'node:url';

import { defineProject } from 'vitest/config';

export default defineProject({
  resolve: {
    alias: {
      '@agent-works/domain/workspace-tools': fileURLToPath(
        new URL('../domain/src/workspace-tools.ts', import.meta.url),
      ),
      '@agent-works/domain': fileURLToPath(new URL('../domain/src/index.ts', import.meta.url)),
      '@agent-works/policy': fileURLToPath(new URL('../policy/src/index.ts', import.meta.url)),
    },
  },
  test: {
    name: '@agent-works/cli',
    include: ['src/**/*.{test,spec}.ts'],
    exclude: ['dist/**'],
  },
});
