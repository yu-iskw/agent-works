import { fileURLToPath } from 'node:url';

import { defineProject } from 'vitest/config';

export default defineProject({
  resolve: {
    alias: [
      {
        find: /^@agent-works\/domain$/,
        replacement: fileURLToPath(new URL('../../packages/domain/src/index.ts', import.meta.url)),
      },
      {
        find: /^@agent-works\/domain\/ask$/,
        replacement: fileURLToPath(new URL('../../packages/domain/src/ask.ts', import.meta.url)),
      },
    ],
  },
  oxc: {
    jsx: {
      runtime: 'automatic',
    },
  },
  test: {
    name: '@agent-works/web',
    include: ['app/**/*.test.ts', 'client/**/*.test.{ts,tsx}'],
  },
});
