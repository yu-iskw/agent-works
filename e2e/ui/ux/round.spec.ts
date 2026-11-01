import { mkdirSync } from 'node:fs';

import { expect, test } from '@playwright/test';

import { db } from '../../m1/helpers.js';
import { signInLocal } from '../helpers.js';

import type { Page } from '@playwright/test';

// A UX review round: the running app at three widths in both themes, plus one real reply, for a
// person to inspect. Screens land in artifacts/ui/screenshots/round-<n>/ and the video next to the
// test results. Nothing here is a baseline.
const round = process.env.UX_ROUND ?? '0';
const dir = `artifacts/ui/screenshots/round-${round}`;
const widths = [1440, 768, 375] as const;
const themes = ['light', 'dark'] as const;

async function capture(page: Page, name: string): Promise<void> {
  // The round directory is built from a fixed prefix and a numeric round id.
  // eslint-disable-next-line security/detect-non-literal-fs-filename
  mkdirSync(dir, { recursive: true });
  await page.screenshot({ path: `${dir}/${name}.png` });
}

async function ensureStarterTeam(page: Page): Promise<void> {
  await page.goto('/s/alpha/teammates');
  const add = page.getByRole('button', { name: /starter team/i });
  if (await add.isVisible()) await add.click();
}

test('workspace review round', async ({ page }) => {
  await signInLocal(page, 'alice@local.test');
  await ensureStarterTeam(page);
  await page.goto('/s/alpha');
  await expect(page.getByRole('textbox', { name: 'Message' })).toBeVisible();

  for (const theme of themes) {
    await page.emulateMedia({ colorScheme: theme });
    for (const width of widths) {
      await page.setViewportSize({ width, height: width === 375 ? 812 : 900 });
      await capture(page, `conversation-${width}-${theme}`);
    }
  }

  await page.emulateMedia({ colorScheme: 'light' });
  await page.setViewportSize({ width: 1440, height: 900 });
  const replies = async () =>
    (
      await db('alpha')<{ n: number }[]>`
        select count(*)::int as n from tw_messages where role = 'teammate'`
    )[0].n;
  const before = await replies();
  const items = page.getByRole('list', { name: 'Conversation' }).getByRole('listitem');
  const shown = await items.count();
  const composer = page.getByRole('textbox', { name: 'Message' });
  await composer.fill(
    '社内向けの分析ツールを比較するとき、最初に何を確認しますか？短く答えてください。',
  );
  await capture(page, 'composer-filled-1440-light');
  await composer.press('Enter');
  await expect(composer).toHaveValue('');
  await capture(page, 'reply-pending-1440-light');
  await expect.poll(replies, { timeout: 120_000, intervals: [2_000] }).toBeGreaterThan(before);
  await expect.poll(() => items.count(), { timeout: 30_000 }).toBeGreaterThan(shown + 1);
  await capture(page, 'reply-1440-light');

  await page.getByRole('tab', { name: 'Work' }).click();
  await capture(page, 'sidebar-work-1440-light');
  await page.getByRole('tab', { name: 'Teammates' }).click();
  await page
    .getByRole('button', { name: /details/i })
    .first()
    .click();
  await expect(page.getByText('Loading teammate…')).toBeHidden();
  await capture(page, 'details-1440-light');

  await page.emulateMedia({ colorScheme: 'dark' });
  await capture(page, 'details-1440-dark');
  await page.setViewportSize({ width: 375, height: 812 });
  await capture(page, 'details-375-dark');
});
