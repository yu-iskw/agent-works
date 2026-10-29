import { defineConfig, devices } from '@playwright/test';

// Runs inside the `e2e` compose service against the running compose.p0.yaml stack.
// Orchestrated by scripts/p0-e2e.mjs, which brings the stack up in the right mode first.
const artifacts = '../../artifacts/p0';

export default defineConfig({
  testDir: '.',
  outputDir: `${artifacts}/test-results`,
  snapshotPathTemplate: '{testDir}/__screenshots__/{testFilePath}/{arg}{ext}',
  fullyParallel: false,
  workers: 1,
  forbidOnly: true,
  retries: 0,
  timeout: 60_000,
  expect: {
    timeout: 15_000,
    toHaveScreenshot: { maxDiffPixelRatio: 0.01, animations: 'disabled' },
  },
  reporter: [
    ['list'],
    ['json', { outputFile: `${artifacts}/results-${process.env.P0_SUITE ?? 'local'}.json` }],
    [
      'html',
      { outputFolder: `${artifacts}/report-${process.env.P0_SUITE ?? 'local'}`, open: 'never' },
    ],
  ],
  use: {
    baseURL: process.env.P0_BASE_URL ?? 'http://fake-iap:8080',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    ...devices['Desktop Chrome'],
    viewport: { width: 1440, height: 900 },
    timezoneId: 'UTC',
    locale: 'en-US',
  },
  projects: [
    {
      name: 'fixture',
      testMatch: /fixture\/.*\.spec\.ts$/,
      // No committed baselines exist in CI, so the visual comparison only runs locally.
      testIgnore: process.env.GITHUB_ACTIONS === 'true' ? /visual\.spec\.ts$/ : undefined,
    },
    { name: 'misconfig', testMatch: /misconfig\/.*\.spec\.ts$/ },
    { name: 'restart-before', testMatch: /restart\/before\.spec\.ts$/ },
    { name: 'restart-after', testMatch: /restart\/after\.spec\.ts$/ },
    {
      name: 'real-llm',
      testMatch: /real-llm\/.*\.spec\.ts$/,
      timeout: 240_000,
      use: { video: { mode: 'on', size: { width: 1440, height: 900 } } },
    },
  ],
});
