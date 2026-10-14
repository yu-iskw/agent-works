import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: '.',
  testMatch: 'workspace-smoke.spec.tsx',
  outputDir: '/tmp/p5b1-playwright-results',
  reporter: 'line',
  workers: 1,
  use: { headless: true },
});
