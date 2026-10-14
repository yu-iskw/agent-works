import { fileURLToPath } from 'node:url';

import { defineProject } from 'vitest/config';

export default defineProject({
  resolve: {
    alias: {
      '@agent-works/domain/delegation': fileURLToPath(
        new URL('../../packages/domain/src/delegation.ts', import.meta.url),
      ),
      '@agent-works/domain/delegation-authority': fileURLToPath(
        new URL('../../packages/domain/src/delegation-authority.ts', import.meta.url),
      ),
      '@agent-works/domain/model-policy': fileURLToPath(
        new URL('../../packages/domain/src/model-policy.ts', import.meta.url),
      ),
      '@agent-works/domain/model-policy-benchmark': fileURLToPath(
        new URL('../../packages/domain/src/model-policy-benchmark.ts', import.meta.url),
      ),
      '@agent-works/domain/data-governance': fileURLToPath(
        new URL('../../packages/domain/src/data-governance.ts', import.meta.url),
      ),
      '@agent-works/domain/budget': fileURLToPath(
        new URL('../../packages/domain/src/budget.ts', import.meta.url),
      ),
      '@agent-works/domain/error-class': fileURLToPath(
        new URL('../../packages/domain/src/error-class.ts', import.meta.url),
      ),
      '@agent-works/domain/error-class-retry': fileURLToPath(
        new URL('../../packages/domain/src/error-class-retry.ts', import.meta.url),
      ),
      '@agent-works/incident-analysis': fileURLToPath(
        new URL('../../agents/skills/incident-analysis/deliver.ts', import.meta.url),
      ),
      '@agent-works/domain/workspace-tools': fileURLToPath(
        new URL('../../packages/domain/src/workspace-tools.ts', import.meta.url),
      ),
      '@agent-works/domain': fileURLToPath(
        new URL('../../packages/domain/src/index.ts', import.meta.url),
      ),
      '@agent-works/policy': fileURLToPath(
        new URL('../../packages/policy/src/index.ts', import.meta.url),
      ),
      '@agent-works/fakes': fileURLToPath(
        new URL('../../packages/fakes/src/index.ts', import.meta.url),
      ),
    },
  },
  test: {
    name: '@agent-works/api',
    include: ['src/**/*.test.ts'],
    exclude: ['dist/**'],
  },
});
