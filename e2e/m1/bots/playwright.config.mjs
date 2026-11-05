import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: '.',
  outputDir: '../../../artifacts/m1/test-results/bots',
  workers: 1,
  retries: 0,
  timeout: 120_000,
  expect: { timeout: 20_000 },
  reporter: [
    ['list'],
    ['json', { outputFile: '../../../artifacts/m1/results-bots.json' }],
    ['html', { outputFolder: '../../../artifacts/m1/report-bots', open: 'never' }],
  ],
  use: {
    ...devices['Desktop Chrome'],
    baseURL: process.env.M1_BASE_URL ?? 'http://web:8080',
    trace: 'on',
    screenshot: 'on',
  },
  projects: [{ name: 'bots', testMatch: /.*\.spec\.ts$/ }],
});
