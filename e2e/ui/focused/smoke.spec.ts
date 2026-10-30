import { expect, test } from '@playwright/test';

import { signInLocal } from '../helpers.js';

test('sign-in page says identity is simulated and a mock member can enter', async ({ page }) => {
  await page.goto('/sign-in');
  await expect(page.getByText('Mock identities')).toBeVisible();
  await signInLocal(page, 'alice@local.test');
  await expect(page).toHaveURL(/\/s\/(alpha|beta)\//);
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
});
