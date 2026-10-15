import { readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { defineConfig } from '@playwright/test';

const root = dirname(__filename);

function hasSpec(directory: string): boolean {
  // eslint-disable-next-line security/detect-non-literal-fs-filename
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      if (hasSpec(path)) return true;
      continue;
    }
    if (entry.name.endsWith('.spec.ts')) return true;
  }
  return false;
}

// eslint-disable-next-line security/detect-non-literal-fs-filename
const projects = readdirSync(root, { withFileTypes: true })
  .filter(
    (entry) =>
      entry.name !== 'adversarial' && entry.isDirectory() && hasSpec(join(root, entry.name)),
  )
  .map((entry) => ({
    name: entry.name,
    testMatch: `${entry.name}/**/*.spec.ts`,
    ...(entry.name === 'security' ? { testIgnore: 'security/pending.spec.ts' } : {}),
    ...(entry.name === 'dev'
      ? {
          testIgnore: [
            'dev/identity-smoke.spec.ts',
            'dev/cross-user.spec.ts',
            'dev/direct-url.spec.ts',
          ],
        }
      : {}),
  }));

export default defineConfig({
  testDir: '.',
  projects: [
    ...projects,
    {
      name: 'adversarial',
      testMatch: 'adversarial/**/*.spec.ts',
      outputDir: 'adversarial/results',
    },
  ],
  outputDir: 'test-results',
  reporter: [['line'], ['./web/artifacts-reporter.mjs']],
  use: {
    baseURL: 'http://127.0.0.1:8085',
    screenshot: 'on',
    trace: 'on',
    video: 'on',
  },
  workers: 1,
});
