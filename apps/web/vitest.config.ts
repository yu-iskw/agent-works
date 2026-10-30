import { fileURLToPath } from 'node:url';

import { defineProject } from 'vitest/config';

export default defineProject({
  resolve: {
    alias: {
      '@agent-works/domain/env-file': fileURLToPath(
        new URL('../../packages/domain/src/env-file.ts', import.meta.url),
      ),
      '@agent-works/domain/sealer': fileURLToPath(
        new URL('../../packages/domain/src/sealer.ts', import.meta.url),
      ),
      '@agent-works/domain/teamwork-policy': fileURLToPath(
        new URL('../../packages/domain/src/teamwork-policy.ts', import.meta.url),
      ),
      '@agent-works/domain/teamwork-evidence': fileURLToPath(
        new URL('../../packages/domain/src/teamwork-evidence.ts', import.meta.url),
      ),
      '@agent-works/domain/teamwork-portable': fileURLToPath(
        new URL('../../packages/domain/src/teamwork-portable.ts', import.meta.url),
      ),
      '@agent-works/domain/teamwork-inbox': fileURLToPath(
        new URL('../../packages/domain/src/teamwork-inbox.ts', import.meta.url),
      ),
      '@agent-works/domain/teamwork': fileURLToPath(
        new URL('../../packages/domain/src/teamwork.ts', import.meta.url),
      ),
      '@agent-works/domain/workspace-tools': fileURLToPath(
        new URL('../../packages/domain/src/workspace-tools.ts', import.meta.url),
      ),
      '@agent-works/domain/user-memory': fileURLToPath(
        new URL('../../packages/domain/src/user-memory.ts', import.meta.url),
      ),
      '@agent-works/domain/user-memory-pii': fileURLToPath(
        new URL('../../packages/domain/src/user-memory-pii.ts', import.meta.url),
      ),
      '@agent-works/domain/workbench': fileURLToPath(
        new URL('../../packages/domain/src/workbench.ts', import.meta.url),
      ),
      '@agent-works/domain': fileURLToPath(
        new URL('../../packages/domain/src/index.ts', import.meta.url),
      ),
    },
  },
  oxc: {
    jsx: {
      runtime: 'classic',
      pragma: 'h',
      pragmaFrag: 'Fragment',
    },
  },
  test: {
    name: '@agent-works/web',
    include: ['app/**/*.test.{ts,tsx}', 'shared/**/*.test.ts', 'client/**/*.test.{ts,tsx}'],
  },
});
