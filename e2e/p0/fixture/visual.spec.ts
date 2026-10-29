import { expect, test } from '@playwright/test';

import { FLAGSHIP, SCREENSHOTS, signIn, startTask, waitForStatus, fullShot } from '../helpers.js';

import type { Page } from '@playwright/test';

// Deterministic states only. Volatile text (times, ids, counts, fingerprints) is masked.
// Update baselines deliberately: see docs/p0/README.md "Visual baselines".
const volatile = (page: Page) => [
  page.locator('time'),
  page.locator('.mono'),
  page.locator('.task-list'),
  page.locator('.nav-count'),
  page.locator('[data-counter]'),
  page.locator('.tl-meta'),
  page.locator('.ev-meta'),
];

// Tall viewport: element snapshots never scroll under the sticky top bar.
test.use({ viewport: { width: 1280, height: 2600 } });

test('sign-in page', async ({ page }) => {
  await page.goto('/_auth/sign-in');
  await expect(page).toHaveScreenshot('sign-in.png');
});

test('home composer', async ({ page }) => {
  await signIn(page);
  await fullShot(page, `${SCREENSHOTS}/01-home-1280.png`);
  await expect(page.locator('form[data-composer]')).toHaveScreenshot('home-composer.png', {
    mask: volatile(page),
  });
});

test('task waiting for approval', async ({ page }) => {
  await signIn(page);
  await startTask(page, FLAGSHIP);
  await waitForStatus(page, 'waiting_approval');
  await expect(page.locator('#approval')).toHaveScreenshot('approval-panel.png', {
    mask: volatile(page),
  });
  await expect(page.locator('#report')).toHaveScreenshot('report-draft.png', {
    mask: volatile(page),
  });
});

test('failed task', async ({ page }) => {
  await signIn(page);
  await startTask(page, `${FLAGSHIP} [stub:unavailable]`);
  await waitForStatus(page, 'failed');
  await expect(page.locator('.turn-agent')).toHaveScreenshot('failed-turn.png', {
    mask: volatile(page),
  });
});

test('mobile task header and navigation', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await signIn(page);
  await page.getByRole('button', { name: 'Open navigation' }).click();
  await expect(page).toHaveScreenshot('mobile-nav-open.png', { mask: volatile(page) });
});
