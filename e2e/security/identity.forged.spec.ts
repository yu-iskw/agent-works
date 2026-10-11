import { expect, test } from '@playwright/test';

test('sec.forged-iap-header', async ({ page }) => {
  const { startStack } = (await import('../../apps/api/dist/testing/stack.js')) as {
    startStack: () => Promise<{ apiUrl: string; close: () => Promise<void> }>;
  };
  const stack = await startStack();
  try {
    const response = await page.request.post(`${stack.apiUrl}/v1/ask`, {
      headers: { 'x-goog-authenticated-user-email': 'mallory@example.test' },
      data: {},
    });
    expect(response.status()).toBe(401);
    const body: unknown = await response.json();
    expect(body).toEqual({ error: 'unauthenticated' });
    // The artifacts reporter records a pass only when a screenshot exists.
    await page.setContent(`<pre>${response.status()} ${JSON.stringify(body)}</pre>`);
    await expect(page.getByText('401')).toBeVisible();
  } finally {
    await stack.close();
  }
});
