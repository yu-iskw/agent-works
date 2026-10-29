import { expect, test } from '@playwright/test';

import {
  FLAGSHIP,
  approve,
  captureElement,
  csrfFrom,
  fixtureDocCount,
  newUserPage,
  signIn,
  startTask,
  waitForStatus,
} from '../helpers.js';

test('a second identity cannot see or act on another owner’s task', async ({ browser }) => {
  const alice = await newUserPage(browser, 'alice');
  const id = await startTask(alice, FLAGSHIP);
  await waitForStatus(alice, 'waiting_approval');
  const sourceHref = await alice.locator('[data-source-link]').first().getAttribute('href');
  const digest = await alice
    .locator('#approval input[name="expectedPayloadSha256"]')
    .first()
    .inputValue();

  const bob = await newUserPage(browser, 'bob');
  const direct = await bob.goto(`/tasks/${id}`);
  expect(direct?.status()).toBe(404);
  await expect(bob.getByRole('heading', { name: 'Task not found' })).toBeVisible();
  expect(await bob.content()).not.toContain('Incident review');
  expect((await bob.request.get(`/tasks/${id}?fragment=1`)).status()).toBe(404);
  expect((await bob.request.get(`/tasks/${id}/report.md`)).status()).toBe(404);
  expect((await bob.goto(sourceHref ?? '/'))?.status()).toBe(404);
  await bob.goto('/tasks');
  await expect(bob.locator(`a[href="/tasks/${id}"]`)).toHaveCount(0);

  const csrf = await csrfFrom(bob);
  for (const [path, form] of [
    [`/tasks/${id}/approval`, { csrf, decision: 'approve', expectedPayloadSha256: digest }],
    [`/tasks/${id}/cancel`, { csrf }],
    [`/tasks/${id}/retry`, { csrf }],
  ] as const) {
    const response = await bob.request.post(path, {
      form,
      headers: { origin: 'http://fake-iap:8080' },
      maxRedirects: 0,
    });
    expect(response.status(), path).toBe(303);
  }
  expect(await fixtureDocCount(id)).toBe(0);
  await alice.reload();
  await waitForStatus(alice, 'waiting_approval');

  await approve(alice);
  const docHref = await alice.locator('[data-result-link]').getAttribute('href');
  expect((await bob.goto(docHref ?? '/'))?.status()).toBe(404);
});

test('requests without the CSRF token or from a foreign origin are refused', async ({ page }) => {
  await signIn(page);
  const csrf = await csrfFrom(page);
  const missing = await page.request.post('/tasks', {
    form: { objective: 'x', clientRequestId: crypto.randomUUID() },
    headers: { origin: 'http://fake-iap:8080' },
    maxRedirects: 0,
  });
  expect(missing.status()).toBe(403);
  const foreign = await page.request.post('/tasks', {
    form: { csrf, objective: 'x', clientRequestId: crypto.randomUUID() },
    headers: { origin: 'https://evil.example' },
    maxRedirects: 0,
  });
  expect(foreign.status()).toBe(403);
  const good = await page.request.post('/tasks', {
    form: { csrf, objective: 'CSRF control task', clientRequestId: crypto.randomUUID() },
    headers: { origin: 'http://fake-iap:8080' },
    maxRedirects: 0,
  });
  expect(good.status()).toBe(303);
});

test('unauthenticated requests never reach task data', async ({ request }) => {
  const response = await request.get('/tasks', { maxRedirects: 0 });
  expect(response.status()).toBe(303);
  expect(response.headers().location).toBe('/_auth/sign-in');
  const post = await request.post('/tasks', { form: { objective: 'x' }, maxRedirects: 0 });
  expect(post.status()).toBe(401);
});

test('prompt and source-title injection render as inert text', async ({ browser }) => {
  const bob = await newUserPage(browser, 'bob');
  await bob.addInitScript(() => {
    (window as unknown as { __xss: number }).__xss = 0;
  });
  const payload = `${FLAGSHIP} <img src=x onerror="window.__xss=1"><script>window.__xss=2</script> **bold** [link](javascript:alert(1))`;
  await startTask(bob, payload);
  await waitForStatus(bob, 'waiting_approval');
  expect(await bob.evaluate(() => (window as unknown as { __xss: number }).__xss)).toBe(0);
  await expect(bob.locator('.turn-user .bubble')).toContainText(
    '<img src=x onerror="window.__xss=1">',
  );
  await expect(bob.locator('[data-evidence="E1"] .ev-title')).toHaveText(
    '<img src=x onerror="alert(1)"> INC-2001 Login outage (Oct 11)',
  );
  await expect(bob.locator('[data-evidence="E1"] [data-blocked-link]')).toBeVisible();
  const dangerous = await bob
    .locator('a[href^="javascript:"], a[href^="data:"], img[onerror], script:not([src])')
    .count();
  expect(dangerous).toBe(0);
  await expect(bob.locator('a', { hasText: 'link' })).toHaveCount(0);
  await captureElement(bob, '#report', 'artifacts/p0/screenshots/12-xss-inert-1440.png');
});
