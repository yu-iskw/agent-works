import { defineProject } from 'vitest/config';
export default defineProject({
  test: {
    name: '@agent-works/api-contract',
    include: ['tests/**/*.test.mjs'],
    exclude: ['dist/**'],
  },
});
