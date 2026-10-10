import { expect, test } from '@playwright/test';

test('harness.trace-recorded', async ({ page }) => {
  const response = await page.goto('/healthz');
  expect(response?.status()).toBe(200);
  await expect(page.locator('body')).toContainText('ok');
});
