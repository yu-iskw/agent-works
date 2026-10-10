import { defineProject } from 'vitest/config';

export default defineProject({
  test: {
    name: '@agent-works/domain',
    include: ['src/**/*.{test,spec}.ts'],
    exclude: ['dist/**'],
  },
});
