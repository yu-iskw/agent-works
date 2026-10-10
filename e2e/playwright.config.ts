import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: '.',
  testMatch: ['web/**/*.spec.ts', 'security/**/*.spec.ts'],
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
