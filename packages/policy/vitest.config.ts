import { defineProject } from 'vitest/config';

export default defineProject({
  test: {
    name: '@agent-works/policy',
    include: ['src/**/*.{test,spec}.ts'],
    exclude: ['dist/**'],
  },
});
