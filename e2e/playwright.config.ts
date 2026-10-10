import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: '.',
  testMatch: ['web/**/*.spec.ts', 'security/**/*.spec.ts'],
  outputDir: 'test-results',
  reporter: 'line',
  use: {
    baseURL: 'http://127.0.0.1:8085',
    screenshot: 'on',
    trace: 'on',
    video: 'on',
  },
  webServer: {
    command: 'pnpm --filter @agent-works/web build && PORT=8085 node apps/web/dist/server.js',
    cwd: '..',
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
    url: 'http://127.0.0.1:8085/healthz',
  },
  workers: 1,
});
