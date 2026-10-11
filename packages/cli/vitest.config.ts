import { defineProject } from 'vitest/config';

export default defineProject({
  test: {
    name: '@agent-works/cli',
    include: ['src/**/*.{test,spec}.ts'],
    exclude: ['dist/**'],
  },
});
