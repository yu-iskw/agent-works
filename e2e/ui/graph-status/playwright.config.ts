import { defineConfig, devices } from '@playwright/test';

// Offline: the spec bundles the component itself and answers every request in the browser.
export default defineConfig({
  testDir: '.',
  testMatch: /graph-status\.spec\.ts$/,
  outputDir: '../../../artifacts/ui/test-results/graph-status',
  workers: 1,
  retries: 0,
  forbidOnly: true,
  timeout: 60_000,
  reporter: [['list']],
  use: { ...devices['Desktop Chrome'], viewport: { width: 1100, height: 800 }, locale: 'en-US' },
});
