import { expect, test } from '@playwright/test';

test.use({ baseURL: 'http://127.0.0.1:8084' });

test('sec.forged-iap-header', async ({ page }) => {
  const response = await page.request.post('/v1/ask', {
    headers: { 'x-goog-authenticated-user-email': 'mallory@example.test' },
    data: {},
  });
  expect(response.status()).toBe(401);
  const body: unknown = await response.json();
  expect(body).toEqual({ error: 'unauthenticated' });
  // The artifacts reporter records a pass only when a screenshot exists.
  await page.setContent(`<pre>${response.status()} ${JSON.stringify(body)}</pre>`);
});
