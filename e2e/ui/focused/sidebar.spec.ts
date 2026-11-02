import { expect, test } from '@playwright/test';

import { db } from '../../m1/helpers.js';
import {
  SEED_PREFIX,
  endsWith,
  includes,
  seedHistory,
  seedUnreadReply,
  signInLocal,
  signOut,
} from '../helpers.js';

import type { Locator, Page } from '@playwright/test';

// Sidebar Work, Results and Inbox over a seeded history of 120 tasks (no model calls): bounded
// paging, server-side search and filters open the right object, tab switches keep the
// conversation, draft, scroll and selection, state labels are text, reading clears Unread only,
// and bob sees none of alice's rows on the same browser.

async function ensureStarterTeam(page: Page): Promise<void> {
  await page.goto('/s/alpha/teammates');
  const add = page.getByRole('button', { name: /starter team/i });
  if (await add.isVisible()) await add.click();
}

const workRows = (page: Page): Locator =>
  page.getByRole('list', { name: 'Work' }).getByRole('listitem');
const resultRows = (page: Page): Locator =>
  page.getByRole('list', { name: 'Results' }).getByRole('listitem');

test.describe('sidebar lists', () => {
  test.beforeEach(async ({ page }) => {
    await signInLocal(page, 'alice@local.test');
    await ensureStarterTeam(page);
  });

  test('Work pages, filters and searches the segment and opens the right task', async ({
    page,
  }) => {
    const seeded = await seedHistory(120);
    await page.goto(`/s/alpha/teammates/${seeded.teammateId}`);
    const composer = page.getByRole('textbox', { name: 'Message' });
    await composer.fill('draft that must survive the sidebar');

    await page.getByRole('tab', { name: 'Work' }).click();
    await expect(workRows(page).first()).toBeVisible();
    const firstPage = await workRows(page).count();
    expect(firstPage).toBeLessThanOrEqual(25);
    await page.getByRole('button', { name: 'Load more' }).click();
    await expect.poll(() => workRows(page).count()).toBeGreaterThan(firstPage);
    expect(await workRows(page).count()).toBeLessThanOrEqual(50);

    await page.getByRole('searchbox', { name: 'Search work' }).fill(`${SEED_PREFIX} task 117`);
    await expect(workRows(page)).toHaveCount(1);
    await expect(workRows(page).first()).toContainText(`${SEED_PREFIX} task 117`);
    await workRows(page).first().getByRole('button').click();
    await expect(page).toHaveURL(
      endsWith(`/s/alpha/teammates/${seeded.teammateId}/tasks/${seeded.taskIds[117]}`),
    );
    await expect(page.getByRole('heading', { level: 2, name: 'Task' })).toBeVisible();
    await expect(composer).toHaveValue('draft that must survive the sidebar');
    await expect(workRows(page).first().getByRole('button')).toHaveAttribute(
      'aria-current',
      'true',
    );

    await page.getByRole('searchbox', { name: 'Search work' }).fill('');
    await page.getByRole('radio', { name: 'Completed' }).check();
    await expect(workRows(page).first()).toBeVisible();
    const statuses = await workRows(page).locator('.status').allTextContents();
    expect(statuses.length).toBeGreaterThan(0);
    expect(new Set(statuses)).toEqual(new Set(['Completed']));

    await page.getByRole('radio', { name: 'Needs attention' }).check();
    const attention = workRows(page).filter({ hasText: `${SEED_PREFIX} question task` });
    await expect(attention).toHaveCount(1);
    await expect(attention).toContainText('Needs input');
    await expect(workRows(page).filter({ hasText: `${SEED_PREFIX} task 117` })).toHaveCount(0);
  });

  test('Results opens the exact revision in the result panel', async ({ page }) => {
    const seeded = await seedHistory(120);
    await page.goto(`/s/alpha/teammates/${seeded.teammateId}`);
    await page.getByRole('tab', { name: 'Results' }).click();
    await expect(resultRows(page).first()).toBeVisible();
    expect(await resultRows(page).count()).toBeLessThanOrEqual(25);
    await page.getByRole('searchbox', { name: 'Search results' }).fill(`${SEED_PREFIX} result 33`);
    await expect(resultRows(page)).toHaveCount(1);
    const row = resultRows(page).first();
    await expect(row).toContainText('Revision 1');
    await expect(row).toContainText(`${SEED_PREFIX} task 33`);
    await row.getByRole('button').click();
    await expect(page).toHaveURL(
      endsWith(`/s/alpha/teammates/${seeded.teammateId}/tasks/${seeded.taskIds[33]}/results/1`),
    );
    await expect(page.getByRole('heading', { level: 2, name: 'Result' })).toBeVisible();
  });

  test('switching tabs keeps scroll, selection, conversation and draft', async ({ page }) => {
    const seeded = await seedHistory(120);
    await page.goto(`/s/alpha/teammates/${seeded.teammateId}`);
    const composer = page.getByRole('textbox', { name: 'Message' });
    await composer.fill('still here');
    await page.getByRole('tab', { name: 'Work' }).click();
    await page.getByRole('searchbox', { name: 'Search work' }).fill(`${SEED_PREFIX} task`);
    await expect(workRows(page).first()).toContainText(SEED_PREFIX);
    await workRows(page).nth(2).getByRole('button').click();
    const selectedTask = await workRows(page).nth(2).textContent();
    const scroller = page.locator('.side-scroll');
    await scroller.evaluate((node) => {
      node.scrollTop = 300;
    });
    await expect.poll(() => scroller.evaluate((node) => node.scrollTop)).toBe(300);

    await page.getByRole('tab', { name: 'Teammates' }).click();
    await expect(page.getByRole('list', { name: 'Teammates' })).toBeVisible();
    await page.getByRole('tab', { name: 'Results' }).click();
    await page.getByRole('tab', { name: 'Work' }).click();
    await expect.poll(() => scroller.evaluate((node) => node.scrollTop)).toBe(300);
    await expect(workRows(page).nth(2)).toHaveText(selectedTask ?? '');
    await expect(workRows(page).nth(2).getByRole('button')).toHaveAttribute('aria-current', 'true');
    await expect(page).toHaveURL(includes(`/s/alpha/teammates/${seeded.teammateId}/tasks/`));
    await expect(composer).toHaveValue('still here');
  });

  test('arrow keys move between tabs without leaving the conversation', async ({ page }) => {
    await page.goto('/s/alpha');
    await page.getByRole('tab', { name: 'Teammates' }).click();
    const url = page.url();
    await page.getByRole('tab', { name: 'Teammates' }).focus();
    await page.keyboard.press('ArrowRight');
    await expect(page.getByRole('tab', { name: 'Work' })).toHaveAttribute('aria-selected', 'true');
    await expect(page.getByRole('tab', { name: 'Work' })).toBeFocused();
    await page.keyboard.press('End');
    await expect(page.getByRole('tab', { name: 'Results' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    expect(page.url()).toBe(url);
  });

  test('Working, Needs you and Unread are separate text labels, and reading clears only Unread', async ({
    page,
  }) => {
    const seeded = await seedHistory(120);
    await seedUnreadReply(seeded.conversationId, 'ui-seed unread reply');
    await page.goto('/s/alpha/teammates');
    await page.goto(`/s/alpha/teammates/${seeded.teammateId}`);
    await page.getByRole('tab', { name: 'Teammates' }).click();
    const row = page
      .getByRole('list', { name: 'Teammates' })
      .getByRole('listitem')
      .filter({ has: page.locator(`a[href$="/teammates/${seeded.teammateId}"]`) });
    await expect(row.locator('.flag-working')).toHaveText('Working');
    await expect(row.locator('.flag-attention')).toHaveText('Needs you');
    // The open conversation is read as soon as its newest message is on screen.
    await expect(row.locator('.flag-unread')).toHaveCount(0);
    await expect(page.getByRole('button', { name: /^Inbox/ })).toHaveAccessibleName(
      /\d+ open item/,
    );

    await page.getByRole('button', { name: /^Inbox/ }).click();
    await expect(page.getByRole('heading', { level: 2, name: 'Attention inbox' })).toBeVisible();
    const decisions = page.getByRole('region', { name: 'Needs your decision' });
    await expect(decisions).toContainText(`${SEED_PREFIX} question task`);
    await decisions
      .getByRole('button')
      .filter({ hasText: `${SEED_PREFIX} question task` })
      .first()
      .click();
    await expect(page).toHaveURL(endsWith(`/tasks/${seeded.attentionTaskId}`));
    // Opening the item never resolves it.
    await page.getByRole('button', { name: /^Inbox/ }).click();
    await expect(decisions).toContainText(`${SEED_PREFIX} question task`);
  });

  test('another teammate’s reply shows Unread until that conversation is opened', async ({
    page,
  }) => {
    const seeded = await seedHistory(120);
    const [{ id: otherId, conversation_id: otherConversation }] = await db('alpha')<
      { id: string; conversation_id: string }[]
    >`
      select id, conversation_id from tw_teammates
      where owner_sub = 'local-test:alice' and not archived and id <> ${seeded.teammateId}
      order by created_at limit 1`;
    // Read from the seeded teammate's conversation, so the other one is never marked read here.
    await page.goto(`/s/alpha/teammates/${seeded.teammateId}`);
    await page.getByRole('tab', { name: 'Teammates' }).click();
    const rows = page.getByRole('list', { name: 'Teammates' }).getByRole('listitem');
    const other = rows.filter({ has: page.locator(`a[href$="/teammates/${otherId}"]`) });
    await expect(other).toHaveCount(1);
    await seedUnreadReply(otherConversation, `ui-seed reply elsewhere ${Date.now()}`);
    await page.reload();
    await page.getByRole('tab', { name: 'Teammates' }).click();
    await expect(other.locator('.flag-unread')).toHaveText('Unread');
    await other.getByRole('link').click();
    await expect(page).toHaveURL(endsWith(`/teammates/${otherId}`));
    await expect(other.locator('.flag-unread')).toHaveCount(0);
  });

  test('bob sees his own state only on the same browser', async ({ page }) => {
    await seedHistory(120);
    await page.goto('/s/alpha');
    await page.getByRole('tab', { name: 'Work' }).click();
    await page.getByRole('searchbox', { name: 'Search work' }).fill(`${SEED_PREFIX} task`);
    await expect(workRows(page).first()).toContainText(`${SEED_PREFIX} task`);
    await signOut(page);
    await signInLocal(page, 'bob@local.test');
    await page.goto('/s/alpha');
    await page.getByRole('tab', { name: 'Work' }).click();
    await page.getByRole('searchbox', { name: 'Search work' }).fill(`${SEED_PREFIX} task`);
    await expect(page.getByRole('tabpanel', { name: 'Work' })).not.toContainText(
      `${SEED_PREFIX} task`,
    );
    await expect(page.locator('.who-mail')).toHaveText('bob@local.test');
    await expect(page.locator('.who-mail')).toBeVisible();
    await expect(page.getByRole('textbox', { name: 'Message' })).toHaveValue('');
  });
});

test.describe('responsive shell', () => {
  test('phone: the sidebar is a closed sheet on load with a trap, Escape and focus return', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    await signInLocal(page, 'alice@local.test');
    await page.goto('/s/alpha');
    const sidebar = page.locator('#sidebar');
    await expect(page.locator('.ws')).toHaveAttribute('data-sheet', 'closed');
    await expect(sidebar).not.toBeInViewport();
    await expect(page.getByRole('textbox', { name: 'Message' })).toBeVisible();
    await expect(page.locator('.hd-seg')).toBeVisible();
    const menu = page.getByRole('button', { name: 'Open the sidebar' });
    await expect(menu).toBeVisible();
    await menu.click();
    await expect(page.locator('.ws')).toHaveAttribute('data-sheet', 'open');
    await expect(sidebar).toHaveAttribute('aria-modal', 'true');
    await expect(sidebar).toBeInViewport();
    await expect(sidebar.getByRole('button', { name: 'Close the sidebar' })).toBeFocused();
    for (let i = 0; i < 40; i += 1) await page.keyboard.press('Tab');
    await expect(sidebar.locator(':focus')).toHaveCount(1);
    await page.keyboard.press('Escape');
    await expect(page.locator('.ws')).toHaveAttribute('data-sheet', 'closed');
    await expect(menu).toBeFocused();
    await menu.click();
    await sidebar.getByRole('button', { name: 'Close the sidebar' }).click();
    await expect(page.locator('.ws')).toHaveAttribute('data-sheet', 'closed');
    const width = await page.evaluate(() => document.documentElement.scrollWidth);
    expect(width).toBeLessThanOrEqual(375);
  });

  test('phone: the sheet stays closed across loads, resizes and a remembered panel', async ({
    page,
  }) => {
    // A desktop session leaves the panel open and the sidebar a static column; the next load at
    // phone width must start with the sheet closed, and a resize must never carry an open sheet.
    await page.setViewportSize({ width: 1440, height: 900 });
    await signInLocal(page, 'alice@local.test');
    await page.goto('/s/alpha');
    await page.getByRole('button', { name: /^Inbox/ }).click();
    await expect(page.getByRole('heading', { level: 2, name: 'Attention inbox' })).toBeVisible();
    const url = page.url();
    await page.setViewportSize({ width: 375, height: 812 });
    await expect(page.locator('.ws')).toHaveAttribute('data-layout', 'phone');
    // Read once, without retrying: a closed sheet must be hidden the moment the layout changes,
    // not after sliding out across the conversation.
    expect(
      await page.locator('#sidebar').evaluate((node) => getComputedStyle(node).visibility),
      'the sidebar is hidden at once when the window narrows to a phone',
    ).toBe('hidden');
    await expect(page.locator('.ws')).toHaveAttribute('data-sheet', 'closed');
    for (let i = 0; i < 3; i += 1) {
      await page.goto(url);
      await expect(page.locator('.ws')).toHaveAttribute('data-sheet', 'closed');
      await expect(page.locator('#sidebar')).toHaveAttribute('role', 'dialog');
      await expect(page.locator('#sidebar')).not.toBeInViewport();
      await expect(page.locator('#sidebar')).toHaveCSS('visibility', 'hidden');
    }
    // The panel is the page at this width; the conversation and its menu button come back.
    await page.getByRole('button', { name: 'Back to conversation' }).click();
    const menu = page.getByRole('button', { name: 'Open the sidebar' });
    await expect(menu).toHaveAttribute('aria-expanded', 'false');
    await expect(page.locator('.ws')).toHaveAttribute('data-sheet', 'closed');
    await menu.click();
    await expect(page.locator('.ws')).toHaveAttribute('data-sheet', 'open');
    await expect(menu).toHaveAttribute('aria-expanded', 'true');
    await page.setViewportSize({ width: 1440, height: 900 });
    await expect(page.locator('.ws')).toHaveAttribute('data-sheet', 'closed');
    await expect(page.locator('#sidebar')).toHaveAttribute('role', 'complementary');
    await page.setViewportSize({ width: 375, height: 812 });
    await expect(page.locator('.ws')).toHaveAttribute('data-sheet', 'closed');
    await expect(page.locator('#sidebar')).not.toBeInViewport();
  });

  test('tablet and open panel: header controls never overlap the title', async ({ page }) => {
    await signInLocal(page, 'alice@local.test');
    for (const width of [768, 1440]) {
      await page.setViewportSize({ width, height: 900 });
      await page.goto('/s/alpha');
      await page.getByRole('button', { name: 'Details' }).click();
      await expect(page.getByRole('heading', { level: 2, name: 'Teammate details' })).toBeVisible();
      if (width < 1024) {
        // The panel takes the content surface at tablet width; the header returns with it.
        await page.getByRole('button', { name: 'Back to conversation' }).click();
        await expect(page.getByRole('button', { name: 'Details' })).toBeVisible();
      }
      const title = await page.locator('.hd-name').boundingBox();
      const details = await page.getByRole('button', { name: 'Details' }).boundingBox();
      const segment = await page.locator('.hd-seg').boundingBox();
      const sim = await page.locator('.hd-sim').boundingBox();
      for (const box of [details, segment, sim]) {
        expect(title).not.toBeNull();
        expect(box).not.toBeNull();
        if (title === null || box === null) continue;
        const overlaps =
          box.x < title.x + title.width &&
          box.x + box.width > title.x &&
          box.y < title.y + title.height &&
          box.y + box.height > title.y;
        expect(overlaps, `${width}px: a header control overlaps the title`).toBe(false);
      }
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
        width,
      );
    }
  });
});
