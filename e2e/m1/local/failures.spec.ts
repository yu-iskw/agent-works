import { expect, test } from '@playwright/test';

import {
  ensureStarterTeam,
  shot,
  signInLocal,
  taskIdFrom,
  teammateId,
  waitForStatus,
} from '../helpers.js';

test('a denied source stops one contribution, keeps the input, and lets the member choose', async ({
  page,
}) => {
  await signInLocal(page);
  await ensureStarterTeam(page, 'alpha');
  const research = await teammateId(page, 'alpha', 'Research analyst');
  await page.goto('/s/alpha/tasks/new');
  await page.getByLabel('What do you need?').fill('Compare vendors [fault:denied]');
  await page.getByLabel('Specialist 1').selectOption(research);
  await page.getByLabel('Assignment').first().fill('Compare prices.');
  await page.getByRole('button', { name: 'Start task' }).click();
  const id = taskIdFrom(page);
  await waitForStatus(page, 'alpha', id, ['needs_input']);
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Your teammates need you' })).toBeVisible();
  await expect(
    page
      .getByRole('article', { name: /Research analyst: Did not finish/ })
      .getByText(/provider denied access/),
  ).toBeVisible();
  await shot(page, '15-failed-recoverable-1440');
  await page.goto('/s/alpha/inbox');
  await expect(page.getByText(/did not finish/).first()).toBeVisible();
  await page.goto(`/s/alpha/tasks/${id}`);
  await page.getByRole('button', { name: 'Continue without them' }).click();
  await expect(page.getByText('No contribution succeeded')).toBeVisible();
});

test('an invalid form keeps every field the member typed', async ({ page }) => {
  await signInLocal(page);
  await ensureStarterTeam(page, 'alpha');
  await page.goto('/s/alpha/tasks/new?workflow=metrics_explanation');
  await page.getByLabel('What do you need?').fill('Why did EU signups change?');
  await page.getByLabel('Baseline month').fill('2026-10');
  await page.getByLabel('Current month').fill('2026-10');
  await page.getByRole('radio', { name: /Coordinator proposes a plan/ }).check();
  await page.getByRole('button', { name: 'Start task' }).click();
  await expect(page.getByText('The baseline and current months must differ.')).toBeVisible();
  await expect(page.getByLabel('What do you need?')).toHaveValue('Why did EU signups change?');
});

test('cancelling a planned task dispatches nothing and says so', async ({ page }) => {
  await signInLocal(page);
  await ensureStarterTeam(page, 'alpha');
  await page.goto('/s/alpha/tasks/new');
  await page.getByLabel('What do you need?').fill('Cancel probe');
  await page.getByRole('radio', { name: /Coordinator proposes a plan/ }).check();
  await page.getByRole('button', { name: 'Start task' }).click();
  await page.getByRole('button', { name: 'Cancel' }).click();
  await expect(page.getByText('Task cancelled. Nothing more will run.')).toBeVisible();
  await expect(page.locator('.status').first()).toHaveText('Cancelled');
});
