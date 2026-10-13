import { fileURLToPath } from 'node:url';

import { defineProject } from 'vitest/config';

export default defineProject({
  resolve: {
    alias: {
      '@agent-works/domain': fileURLToPath(
        new URL('../../../packages/domain/src/index.ts', import.meta.url),
      ),
      '@agent-works/fakes': fileURLToPath(
        new URL('../../../packages/fakes/src/index.ts', import.meta.url),
      ),
    },
  },
  test: {
    name: 'incident-analysis',
    include: ['*.test.ts'],
  },
});
