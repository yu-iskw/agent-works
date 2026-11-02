import { defineConfig, devices } from '@playwright/test';

// Runs inside the `e2e` compose service of compose.m1.yaml, orchestrated by scripts/ui/run.mjs,
// which first asserts the stack is on the real model. Retries stay at 0 for every suite: a flaky
// journey is a failure. Baselines compare only against files a human approved; `updateSnapshots`
// is `none`, so no run can write an approved baseline.
const artifacts = '../../artifacts/ui';
const suite = process.env.UI_SUITE ?? 'focused';
const video = { mode: 'on' as const, size: { width: 1440, height: 900 } };

export default defineConfig({
  testDir: '.',
  outputDir: `${artifacts}/test-results/${suite}`,
  snapshotPathTemplate: `${artifacts}/baselines/approved/{arg}{ext}`,
  updateSnapshots: 'none',
  fullyParallel: false,
  workers: 1,
  forbidOnly: true,
  retries: 0,
  timeout: 120_000,
  expect: {
    timeout: 20_000,
    // An absolute allowance: two runs differ by up to about 20 pixels of scrollbar fade and
    // anti-aliasing, while a missing label is about 80 and a missing card thousands. A 1% ratio
    // let two missing cards through on a full page.
    toHaveScreenshot: { maxDiffPixels: 64, animations: 'disabled' },
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
    // Real-model journeys: specialists, synthesis and revisions wait on Vertex latency.
    { name: 'journeys', testMatch: /journeys\/.*\.spec\.ts$/, timeout: 600_000, use: { video } },
    { name: 'focused', testMatch: /focused\/.*\.spec\.ts$/, use: { video } },
    // UX review rounds: screenshots and video of the running app, inspected by a person.
    { name: 'ux', testMatch: /ux\/.*\.spec\.ts$/, timeout: 600_000, use: { video } },
    { name: 'visual', testMatch: /visual\/.*\.spec\.ts$/, timeout: 180_000 },
    { name: 'restart-before', testMatch: /restart\/before\.spec\.ts$/ },
    { name: 'restart-after', testMatch: /restart\/after\.spec\.ts$/, timeout: 360_000 },
    // Usability seed (pnpm ui:seed-review --with-approval); never part of a test suite.
    { name: 'seed', testMatch: /seed\/.*\.spec\.ts$/ },
  ],
});
