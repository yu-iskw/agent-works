import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: [
      'packages/*/vitest.config.ts',
      'apps/api/vitest.config.ts',
      'apps/web/vitest.config.ts',
      'agents/skills/incident-analysis/vitest.config.ts',
      {
        test: {
          name: 'scripts',
          include: ['scripts/**/*.test.mjs'],
        },
      },
      {
        resolve: {
          alias: {
            '@agent-works/incident-analysis': fileURLToPath(
              new URL('./agents/skills/incident-analysis/deliver.ts', import.meta.url),
            ),
            '@agent-works/domain/user-memory': fileURLToPath(
              new URL('./packages/domain/src/user-memory.ts', import.meta.url),
            ),
            '@agent-works/domain/data-governance': fileURLToPath(
              new URL('./packages/domain/src/data-governance.ts', import.meta.url),
            ),
            '@agent-works/domain/workspace-tools': fileURLToPath(
              new URL('./packages/domain/src/workspace-tools.ts', import.meta.url),
            ),
            '@agent-works/domain/user-memory-pii': fileURLToPath(
              new URL('./packages/domain/src/user-memory-pii.ts', import.meta.url),
            ),
            '@agent-works/domain': fileURLToPath(
              new URL('./packages/domain/src/index.ts', import.meta.url),
            ),
            '@agent-works/fakes': fileURLToPath(
              new URL('./packages/fakes/src/index.ts', import.meta.url),
            ),
            '@agent-works/policy': fileURLToPath(
              new URL('./packages/policy/src/index.ts', import.meta.url),
            ),
          },
        },
        test: {
          name: 'contract',
          include: ['e2e/contract/**/*.test.ts'],
        },
      },
    ],
    coverage: {
      provider: 'v8',
      include: ['packages/*/src/**/*.ts'],
      exclude: [
        'packages/*/src/**/*.{test,spec}.ts',
        'packages/*/src/**/*.d.ts',
        'packages/*/dist/**',
        '**/*.config.{js,mjs,cjs,ts}',
      ],
      reporter: ['text', 'html', 'lcov', 'json-summary'],
      thresholds: {
        lines: 80,
        functions: 80,
        statements: 80,
        branches: 70,
      },
    },
  },
});
