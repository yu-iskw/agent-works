import { expect, test } from '@playwright/test';

import {
  FLAGSHIP,
  SCREENSHOTS,
  fixtureDocCount,
  signIn,
  startTask,
  waitForStatus,
  fullShot,
} from '../helpers.js';

test.beforeEach(async ({ page }) => {
  await signIn(page);
});

const failures = [
  ['[stub:unavailable]', 'unavailable', 'Vertex AI returned a server error'],
  ['[stub:rate-limit]', 'rate limited', 'quota or rate limit'],
  ['[stub:timeout]', 'timeout', 'timed out'],
  ['[fixture:drive-denied]', 'drive denied', 'Drive access was denied'],
  ['[fixture:empty]', 'no evidence', 'No authorised documents matched'],
] as const;

for (const [marker, code, guidance] of failures) {
  test(`${marker} shows a recoverable failure`, async ({ page }) => {
    const id = await startTask(page, `${FLAGSHIP} ${marker}`);
    await waitForStatus(page, 'failed');
    const alert = page.getByRole('alert').first();
    await expect(alert).toContainText(`Task failed: ${code}`);
    await expect(alert).toContainText(guidance);
    await expect(page.getByRole('button', { name: 'Retry' })).toBeVisible();
    expect(await fixtureDocCount(id)).toBe(0);
    if (marker === '[stub:unavailable]')
      await fullShot(page, `${SCREENSHOTS}/08-error-model-1440.png`);
    await page.getByRole('button', { name: 'Retry' }).click();
    await waitForStatus(page, 'failed');
    await expect(page.locator('[data-event="task.retried"]')).toHaveCount(1);
  });
}

test('a failed write is retried without duplicating', async ({ page }) => {
  const id = await startTask(page, `${FLAGSHIP} [fixture:docs-fail]`);
  await waitForStatus(page, 'waiting_approval');
  await page.getByRole('button', { name: 'Approve and create' }).click();
  await waitForStatus(page, 'failed');
  await expect(page.getByRole('alert').first()).toContainText('could not be created');
  await page.getByRole('button', { name: 'Retry' }).click();
  await waitForStatus(page, 'failed');
  expect(await fixtureDocCount(id)).toBe(0);
});

test('an unconfirmed write is uncertain and reconciles to exactly one document', async ({
  page,
}) => {
  const id = await startTask(page, `${FLAGSHIP} [fixture:docs-timeout]`);
  await waitForStatus(page, 'waiting_approval');
  await page.getByRole('button', { name: 'Approve and create' }).click();
  await waitForStatus(page, 'outcome_uncertain');
  await expect(page.getByRole('alert').first()).toContainText('Write outcome uncertain');
  await fullShot(page, `${SCREENSHOTS}/09-outcome-uncertain-1440.png`);
  expect(await fixtureDocCount(id)).toBe(1);
  await page.getByRole('button', { name: 'Reconcile' }).click();
  await waitForStatus(page, 'completed');
  await expect(page.locator('[data-event="action.reconciled"]')).toContainText('No new write');
  expect(await fixtureDocCount(id)).toBe(1);
});

test('unknown task ids get a clear not-found page', async ({ page }) => {
  const response = await page.goto('/tasks/00000000-0000-4000-8000-000000000000');
  expect(response?.status()).toBe(404);
  await expect(page.getByRole('heading', { name: 'Task not found' })).toBeVisible();
});
