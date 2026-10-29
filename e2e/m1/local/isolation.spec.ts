import { expect, test } from '@playwright/test';

import { ensureStarterTeam, signInLocal } from '../helpers.js';

test.describe('segment and member isolation', () => {
  test('another member and another segment cannot see a task', async ({ browser }) => {
    const alice = await (await browser.newContext()).newPage();
    await signInLocal(alice, 'alice@local.test');
    await ensureStarterTeam(alice, 'alpha');
    await alice.goto('/s/alpha/tasks/new');
    await alice.getByLabel('What do you need?').fill('Isolation probe: compare vendors.');
    await alice.getByRole('radio', { name: /Coordinator proposes a plan/ }).check();
    await alice.getByRole('button', { name: 'Start task' }).click();
    const url = alice.url().replace(/\?.*$/, '');
    await alice.getByRole('button', { name: 'Cancel' }).click();

    const crossSegment = await alice.request.get(url.replace('/s/alpha/', '/s/beta/'));
    expect(crossSegment.status()).toBe(404);
    const unknownSegment = await alice.request.get('/s/gamma/inbox');
    expect(unknownSegment.status()).toBe(404);

    const bob = await (await browser.newContext()).newPage();
    await signInLocal(bob, 'bob@local.test');
    const other = await bob.request.get(url);
    expect(other.status()).toBe(404);
    const otherVersion = await bob.request.get(`${url}/version`);
    expect(otherVersion.status()).toBe(404);
  });

  test('segment APIs reject missing and forged assertions and are not reachable by id injection', async ({
    page,
  }) => {
    const none = await page.request.get('http://api-alpha:8080/v1/teamwork/me');
    expect(none.status()).toBe(401);
    const header = Buffer.from(JSON.stringify({ alg: 'ES256', kid: 'forged' })).toString(
      'base64url',
    );
    const claims = Buffer.from(
      JSON.stringify({
        iss: 'https://aw-m1-web.local/local-test',
        aud: 'segment:alpha',
        sub: 'x',
        email: 'alice@local.test',
        iat: Math.floor(Date.now() / 1000),
        exp: Math.floor(Date.now() / 1000) + 60,
      }),
    ).toString('base64url');
    const forged = await page.request.get('http://api-alpha:8080/v1/teamwork/me', {
      headers: { 'x-goog-iap-jwt-assertion': `${header}.${claims}.AAAA` },
    });
    expect(forged.status()).toBe(401);
    await signInLocal(page);
    expect((await page.request.get('/s/http%3A%2F%2Fevil.example/inbox')).status()).toBe(404);
  });

  test('state changes need the session CSRF token and a trusted origin', async ({ page }) => {
    await signInLocal(page);
    const noToken = await page.request.post('/s/alpha/teammates/starter', {
      form: {},
      headers: { origin: 'http://web:8080' },
    });
    expect(noToken.status()).toBe(403);
    const token = await page
      .locator('form[action="/auth/sign-out"] input[name="csrf"]')
      .getAttribute('value');
    const badOrigin = await page.request.post('/s/alpha/teammates/starter', {
      form: { csrf: token ?? '' },
      headers: { origin: 'https://evil.example' },
    });
    expect(badOrigin.status()).toBe(403);
  });

  test('member-entered text is escaped everywhere it is shown', async ({ page }) => {
    await signInLocal(page);
    await ensureStarterTeam(page, 'alpha');
    await page.getByRole('link', { name: 'Research analyst' }).first().click();
    await page.getByLabel('Name').fill('<img src=x onerror=alert(1)>Analyst');
    await page.getByRole('button', { name: 'Save changes' }).click();
    await expect(
      page.getByRole('heading', { name: '<img src=x onerror=alert(1)>Analyst', level: 1 }),
    ).toBeVisible();
    expect(await page.locator('img[src="x"]').count()).toBe(0);
    await page.getByLabel('Name').fill('Research analyst');
    await page.getByRole('button', { name: 'Save changes' }).click();
  });
});
