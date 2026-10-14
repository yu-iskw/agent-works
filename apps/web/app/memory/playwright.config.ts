import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: '.',
  testMatch: 'smoke.spec.ts',
  outputDir: '/tmp/p5b3-playwright-results',
  reporter: 'line',
  workers: 1,
  use: { headless: true, screenshot: 'only-on-failure', trace: 'retain-on-failure' },
});
