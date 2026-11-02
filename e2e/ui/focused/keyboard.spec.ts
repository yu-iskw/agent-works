import { expect, test } from '@playwright/test';

import { apiPost, signInLocal, smallestConversationWithResult } from '../helpers.js';

import type { Page } from '@playwright/test';

// One journey with no pointer at all: reach the composer, mention a teammate through the @ menu,
// drop the chip, open a result card, resize the panel from the separator, and leave with Escape.
// Every step asserts where focus is. No message is sent and no model is called.

const MAX_TABS = 80;

type Target = { readonly label: string } | { readonly text: string };

/** Presses `key` until the focused element carries the label or exact text, bounded by MAX_TABS. */
async function tabUntil(page: Page, key: 'Tab' | 'Shift+Tab', target: Target): Promise<void> {
  const focused = () =>
    page.evaluate((t) => {
      const el = document.activeElement;
      if (el === null) return false;
      return 'label' in t
        ? el.getAttribute('aria-label') === t.label
        : el.textContent?.trim() === t.text;
    }, target);
  for (let i = 0; i < MAX_TABS; i += 1) {
    if (await focused()) return;
    await page.keyboard.press(key);
  }
  throw new Error(`nothing matching ${JSON.stringify(target)} after ${MAX_TABS} ${key} presses`);
}

const panelWidth = async (page: Page): Promise<number> =>
  (await page.locator('.ws-panel').boundingBox())?.width ?? 0;

test('a keyboard-only member mentions, drops the chip, opens a result, resizes and closes', async ({
  page,
}) => {
  await signInLocal(page, 'alice@local.test');
  const c = await smallestConversationWithResult();
  await page.goto(`/s/alpha/teammates/${c.teammateId}`);
  expect((await apiPost(page, '/api/s/alpha/preferences', { panelWidth: 480 })).status()).toBe(200);
  await page.goto(`/s/alpha/teammates/${c.teammateId}`);
  const composer = page.getByRole('textbox', { name: 'Message' });
  await expect(composer).toBeVisible();
  await page.keyboard.press('Tab');
  await tabUntil(page, 'Tab', { label: 'Message' });
  await expect(composer).toBeFocused();

  await page.keyboard.type('@');
  const menu = page.getByRole('listbox');
  await expect(menu).toBeVisible();
  const options = menu.getByRole('option');
  await expect(options.first()).toHaveAttribute('aria-selected', 'true');
  await page.keyboard.press('ArrowDown');
  await expect(options.nth(1)).toHaveAttribute('aria-selected', 'true');
  await page.keyboard.press('ArrowUp');
  await expect(options.first()).toHaveAttribute('aria-selected', 'true');
  await page.keyboard.press('Enter');
  await expect(menu).toBeHidden();
  const remove = page
    .getByRole('group', { name: 'Context' })
    .getByRole('button', { name: /^Remove / });
  await expect(remove).toHaveCount(1);
  await expect(composer).toBeFocused();
  await expect(composer).toHaveValue('');
  await page.keyboard.press('Backspace');
  await expect(remove).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(remove).toHaveCount(0);
  await expect(composer).toBeFocused();

  await tabUntil(page, 'Shift+Tab', { text: 'Open result' });
  const opener = await page.evaluateHandle(() => document.activeElement);
  await page.keyboard.press('Enter');
  const panel = page.getByRole('region', { name: 'Result' });
  await expect(panel).toBeVisible();
  await expect(page.getByRole('heading', { level: 2, name: 'Result' })).toBeFocused();
  await expect(page).toHaveURL(/\/results\/\d+$/);

  const separator = page.getByRole('separator', { name: 'Resize the panel' });
  await tabUntil(page, 'Shift+Tab', { label: 'Resize the panel' });
  await expect(separator).toBeFocused();
  const start = await panelWidth(page);
  await page.keyboard.press('ArrowLeft');
  await page.keyboard.press('ArrowLeft');
  await expect.poll(() => panelWidth(page)).toBe(start + 32);
  await page.keyboard.press('ArrowRight');
  await expect.poll(() => panelWidth(page)).toBe(start + 16);
  await page.keyboard.press('Home');
  const min = Number(await separator.getAttribute('aria-valuemin'));
  await expect.poll(() => panelWidth(page)).toBe(min);
  await page.keyboard.press('End');
  const max = Number(await separator.getAttribute('aria-valuemax'));
  await expect.poll(() => panelWidth(page)).toBe(max);
  await expect(separator).toHaveAttribute('aria-valuenow', String(max));

  await page.keyboard.press('Escape');
  await expect(panel).toHaveCount(0);
  expect(await page.evaluate((el) => document.activeElement === el, opener)).toBe(true);
});
