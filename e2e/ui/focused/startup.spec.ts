import { expect, test } from '@playwright/test';

import { db } from '../../m1/helpers.js';
import { apiPost, endsWith, signInLocal } from '../helpers.js';

import type { Page } from '@playwright/test';

// Where /s/alpha lands and how the first HTML response already carries the chosen theme. The
// remembered teammate is a segment-scoped preference; when it no longer exists the first
// teammate opens with a notice instead of an error. No model is called.

const ALICE = 'local-test:alice';

async function teammates(): Promise<readonly string[]> {
  const rows = await db('alpha')<{ id: string }[]>`
    select id from tw_teammates where owner_sub = ${ALICE} and not archived order by created_at`;
  return rows.map((row) => row.id);
}

async function choose(page: Page, group: 'Appearance' | 'Startup view', name: string | RegExp) {
  await page.getByRole('button', { name: 'Preferences' }).click();
  await expect(page.getByRole('heading', { level: 2, name: 'Preferences' })).toBeVisible();
  await page.getByRole('group', { name: group }).getByRole('radio', { name }).check();
  await page.getByRole('button', { name: 'Close panel' }).click();
}

test.describe('startup', () => {
  test.beforeEach(async ({ page }) => {
    await signInLocal(page, 'alice@local.test');
    await page.goto('/s/alpha/teammates');
    const add = page.getByRole('button', { name: /starter team/i });
    if (await add.isVisible()) await add.click();
  });

  test('Last conversation reopens the teammate alice talked to last, inbox and recap open on top of it', async ({
    page,
  }) => {
    const ids = await teammates();
    expect(ids.length).toBeGreaterThan(1);
    const second = ids[1];
    await page.goto(`/s/alpha/teammates/${second}`);
    await choose(page, 'Startup view', /Last conversation/);
    await page.goto('/s/alpha');
    await expect(page).toHaveURL(endsWith(`/teammates/${second}`));
    await expect(page.getByRole('region', { name: /inbox|recap/i })).toHaveCount(0);

    await choose(page, 'Startup view', /Attention inbox/);
    await page.goto('/s/alpha');
    await expect(page).toHaveURL(endsWith(`/teammates/${second}/inbox`));
    await expect(page.getByRole('heading', { level: 2, name: 'Attention inbox' })).toBeVisible();

    await choose(page, 'Startup view', /Coordinator recap/);
    await page.goto('/s/alpha');
    await expect(page).toHaveURL(endsWith(`/teammates/${second}/recap`));
    await expect(page.getByRole('heading', { level: 2, name: 'Coordinator recap' })).toBeVisible();
    await expect(page.getByText('No model was called.')).toBeVisible();
    await choose(page, 'Startup view', /Last conversation/);
  });

  test('a remembered teammate that no longer exists falls back to the first one with a notice', async ({
    page,
  }) => {
    const ids = await teammates();
    // The page remembers its own context shortly after load; plant the stale one after that write.
    const remembered = page.waitForResponse(
      (r) => r.request().method() === 'POST' && r.url().endsWith('/api/s/alpha/preferences'),
    );
    await page.goto(`/s/alpha/teammates/${ids[0]}`);
    await remembered;
    const planted = await apiPost(page, '/api/s/alpha/preferences', {
      lastContext: { teammateId: '00000000-0000-4000-8000-00000000dead', tab: 'teammates' },
    });
    expect(planted.status()).toBe(200);
    await page.goto('/s/alpha');
    await expect(page).toHaveURL(endsWith(`/teammates/${ids[0]}`));
    await expect(page.getByRole('status')).toContainText(
      'The teammate you last talked to is no longer available',
    );
    await expect(page.getByRole('textbox', { name: 'Message' })).toBeVisible();
  });

  test('System, Light and Dark are persisted and stamped on the first HTML byte, before any script', async ({
    page,
  }) => {
    const ids = await teammates();
    const url = `/s/alpha/teammates/${ids[0]}`;
    await page.goto(url);
    const firstHtml = async () => (await page.request.get(url)).text();
    for (const theme of ['Dark', 'Light'] as const) {
      await choose(page, 'Appearance', theme);
      const value = theme.toLowerCase();
      await expect(page.locator('html')).toHaveAttribute('data-theme', value);
      const html = await firstHtml();
      expect(html.startsWith(`<!doctype html><html lang="en" data-theme="${value}">`)).toBe(true);
      expect(html.indexOf('data-theme')).toBeLessThan(html.indexOf('<script'));
      await page.reload();
      await expect(page.locator('html')).toHaveAttribute('data-theme', value);
      await expect(page.locator('html')).toHaveCSS('color-scheme', value);
    }
    await choose(page, 'Appearance', 'System');
    await expect(page.locator('html')).not.toHaveAttribute('data-theme', /./);
    expect((await firstHtml()).startsWith('<!doctype html><html lang="en">')).toBe(true);
    await page.emulateMedia({ colorScheme: 'dark' });
    await expect(page.locator('html')).toHaveCSS('color-scheme', 'dark');
    await page.emulateMedia({ colorScheme: 'light' });
    await expect(page.locator('html')).toHaveCSS('color-scheme', 'light');
  });
});
