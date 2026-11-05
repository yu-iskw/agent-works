import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: 'tool-broker',
    include: ['src/**/*.test.ts'],
  },
});
