import { expect, test } from '@playwright/test';

import { SCREENSHOTS, signIn, fullShot } from '../helpers.js';

// Stack started with LLM_MODE=vertex and an empty VERTEX_MODEL_ID; no model call is possible.
test('missing Vertex configuration blocks tasks with actionable guidance', async ({ page }) => {
  await signIn(page);
  const alert = page.getByRole('alert').first();
  await expect(alert).toContainText('Vertex AI is not configured');
  await expect(alert).toContainText('VERTEX_MODEL_ID');
  await expect(page.getByRole('button', { name: 'Start task' })).toBeDisabled();
  await fullShot(page, `${SCREENSHOTS}/14-misconfigured-home-1440.png`);
  await alert.getByRole('link', { name: 'Open Connections' }).click();
  await expect(page.locator('[data-model-state]')).toHaveAttribute(
    'data-model-state',
    'not_configured',
  );
  await expect(page.getByText('Not configured', { exact: true })).toBeVisible();
  expect(await page.content()).not.toMatch(/application_default_credentials|ya29\.|refresh_token/);
});
