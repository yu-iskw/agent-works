import { fileURLToPath } from 'node:url';

import { defineProject } from 'vitest/config';

export default defineProject({
  resolve: {
    alias: {
      '@agent-works/domain': fileURLToPath(new URL('../domain/src/index.ts', import.meta.url)),
    },
  },
  test: {
    name: '@agent-works/fakes',
    include: ['src/**/*.{test,spec}.ts'],
    exclude: ['dist/**'],
  },
});
