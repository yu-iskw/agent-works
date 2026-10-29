import { defineConfig, devices } from '@playwright/test';

// Runs inside the `e2e` compose service of compose.m1.yaml, orchestrated by scripts/m1/run.mjs.
// Retries stay at 0 for every suite: a flaky critical journey is a failure, not a pass.
const artifacts = '../../artifacts/m1';
const suite = process.env.M1_SUITE ?? 'local';

export default defineConfig({
  testDir: '.',
  outputDir: `${artifacts}/test-results/${suite}`,
  snapshotPathTemplate: '{testDir}/__screenshots__/{testFilePath}/{arg}{ext}',
  fullyParallel: false,
  workers: 1,
  forbidOnly: true,
  retries: 0,
  timeout: 120_000,
  expect: {
    timeout: 20_000,
    toHaveScreenshot: { maxDiffPixelRatio: 0.01, animations: 'disabled' },
  },
  reporter: [
    ['list'],
    ['json', { outputFile: `${artifacts}/results-${suite}.json` }],
    ['html', { outputFolder: `${artifacts}/report-${suite}`, open: 'never' }],
  ],
  use: {
    baseURL: process.env.M1_BASE_URL ?? 'http://web:8080',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    ...devices['Desktop Chrome'],
    viewport: { width: 1440, height: 900 },
    timezoneId: 'UTC',
    locale: 'en-US',
  },
  projects: [
    {
      name: 'local',
      testMatch: /local\/.*\.spec\.ts$/,
      testIgnore: process.env.GITHUB_ACTIONS === 'true' ? /visual\.spec\.ts$/ : undefined,
      outputDir: `${artifacts}/videos/${suite}`,
      use: { video: { mode: 'on', size: { width: 1440, height: 900 } } },
    },
    {
      name: 'ux',
      testMatch: /ux\/.*\.spec\.ts$/,
      timeout: 600_000,
      outputDir: `${artifacts}/videos/ux-round-${process.env.M1_UX_ROUND ?? '0'}`,
      use: { video: { mode: 'on', size: { width: 1440, height: 900 } } },
    },
    { name: 'restart-before', testMatch: /restart\/before\.spec\.ts$/ },
    { name: 'restart-after', testMatch: /restart\/after\.spec\.ts$/, timeout: 360_000 },
    {
      name: 'live',
      testMatch: /live\/.*\.spec\.ts$/,
      timeout: 900_000,
      use: { video: { mode: 'on', size: { width: 1440, height: 900 } } },
    },
  ],
});
