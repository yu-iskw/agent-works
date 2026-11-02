import { expect, test } from '@playwright/test';

import { db } from '../../m1/helpers.js';
import { busiestConversation, revisedTask, seedUnreadReply, signInLocal } from '../helpers.js';

import type { Locator, Page } from '@playwright/test';

// Reading position, New activity, reconnect dedupe and what a poll may not disturb, against
// alice's busiest alpha conversation. New items are persisted system rows inserted straight into
// the segment database, so no model is called.

const list = (page: Page): Locator => page.getByRole('list', { name: 'Conversation' });
const scroller = (page: Page): Locator => page.locator('.tl');
const scrollTop = (page: Page) => scroller(page).evaluate((node) => node.scrollTop);
const atBottom = (page: Page) =>
  expect(list(page).locator('li[id]').last()).toBeInViewport({ ratio: 0.9 });

async function openBusiest(page: Page): Promise<{ teammateId: string; conversationId: string }> {
  const c = await busiestConversation();
  await page.goto(`/s/alpha/teammates/${c.teammateId}`);
  await expect(list(page).getByRole('listitem').first()).toBeVisible();
  await atBottom(page);
  return c;
}

/** Resolves after `n` further conversation polls were issued (answered, failed or aborted). */
async function polls(page: Page, n: number): Promise<void> {
  let seen = 0;
  const done = new Promise<void>((resolve) => {
    page.on('request', (request) => {
      if (/\/api\/s\/alpha\/conversations\/[0-9a-f-]+\?teammate=/.test(request.url())) {
        seen += 1;
        if (seen >= n) resolve();
      }
    });
  });
  await done;
}

test.describe('timeline', () => {
  test.beforeEach(async ({ page }) => {
    await signInLocal(page, 'alice@local.test');
  });

  test('a member reading earlier messages stays put; New activity jumps to the new item', async ({
    page,
  }) => {
    const c = await openBusiest(page);
    const before = await list(page).locator('li[id]').count();
    await scroller(page).evaluate((node) => {
      node.scrollTop = 0;
    });
    await expect.poll(() => scrollTop(page)).toBe(0);
    const text = `ui-seed activity ${Date.now()}`;
    const id = await seedUnreadReply(c.conversationId, text, 'system');
    const jump = page.getByRole('button', { name: /^New activity \(\d+\)$/ });
    await expect(jump).toBeVisible();
    await expect(jump).toHaveText('New activity (1)');
    expect(await scrollTop(page)).toBe(0);
    expect(await list(page).locator('li[id]').count()).toBe(before + 1);
    await jump.click();
    await atBottom(page);
    await expect(page.locator(`[id="msg:${id}"]`)).toBeInViewport();
    await expect(page.locator(`[id="msg:${id}"]`)).toContainText(text);
    await expect(jump).toHaveCount(0);
  });

  test('Show earlier messages pages back and keeps the message being read in place', async ({
    page,
  }) => {
    await openBusiest(page);
    const items = list(page).locator('li[id]');
    const before = await items.count();
    await scroller(page).evaluate((node) => {
      node.scrollTop = 0;
    });
    // The anchor is the first item the member can see: a day separator re-forms at the new top
    // once older messages of that day arrive, and an anchor row may render nothing.
    const id = await scroller(page).evaluate((box) => {
      const top = box.getBoundingClientRect().top;
      const seen = [...box.querySelectorAll('li[id]')].find((item) => {
        const r = item.getBoundingClientRect();
        return r.height > 16 && r.top >= top && !item.id.startsWith('day:');
      });
      return seen?.id ?? null;
    });
    expect(id, 'an item is visible before paging back').not.toBeNull();
    const top = async () => (await page.locator(`[id="${id}"]`).boundingBox())!.y;
    const held = await top();
    await page.getByRole('button', { name: 'Show earlier messages' }).click();
    await expect.poll(() => items.count()).toBeGreaterThan(before);
    expect(Math.abs((await top()) - held)).toBeLessThanOrEqual(2);
    const inside = await scroller(page).evaluate((box, anchor) => {
      const frame = box.getBoundingClientRect();
      const r = document.getElementById(anchor)!.getBoundingClientRect();
      return r.top >= frame.top - 1 && r.top < frame.bottom;
    }, id!);
    expect(inside, 'the message being read is still on screen').toBe(true);
  });

  test('a reconnect after failed polls adds each new item once and keeps the order', async ({
    page,
  }) => {
    const c = await openBusiest(page);
    const ids = () =>
      list(page)
        .locator('li[id]')
        .evaluateAll((nodes) => nodes.map((n) => n.id));
    const before = await ids();
    await page.route(/\/api\/s\/alpha\/conversations\/[0-9a-f-]+\?teammate=/, (route) =>
      route.abort('connectionfailed'),
    );
    await expect(page.getByRole('status').filter({ hasText: 'Connection trouble' })).toBeVisible();
    const text = `ui-seed after reconnect ${Date.now()}`;
    const id = await seedUnreadReply(c.conversationId, text, 'system');
    await polls(page, 2);
    await page.unroute(/\/api\/s\/alpha\/conversations\/[0-9a-f-]+\?teammate=/);
    await expect(page.locator(`[id="msg:${id}"]`)).toContainText(text);
    await expect(page.getByRole('status').filter({ hasText: 'Connection trouble' })).toHaveCount(0);
    await polls(page, 2);
    const after = await ids();
    expect(after.length).toBe(before.length + 1);
    expect(new Set(after).size).toBe(after.length);
    expect(after.slice(0, before.length)).toEqual(before);
  });

  test('three polls leave the selected revision, source, draft and focus exactly as they were', async ({
    page,
  }) => {
    const s = await revisedTask('alpha');
    test.skip(s === undefined, 'no alpha task of alice with two revisions');
    const base = `/s/alpha/teammates/${s!.teammateId}/tasks/${s!.taskId}/results/1`;
    const [first] = await db('alpha')<{ evidence_ids: string[] }[]>`
      select evidence_ids from tw_revisions where task_id = ${s!.taskId} and revision = 1`;
    const cited = first.evidence_ids.at(0);
    test.skip(cited === undefined, 'revision 1 cites no evidence');
    await page.goto(`${base}/sources?citation=${cited}`);
    const entry = page.locator(`#ev-${cited}`);
    await expect(entry).toHaveAttribute('aria-current', 'true');
    await expect(page.getByRole('combobox', { name: 'Revision' })).toHaveValue('1');
    const composer = page.getByRole('textbox', { name: 'Message' });
    await composer.fill('a draft the poll must keep');
    await composer.press('End');
    await expect(composer).toBeFocused();
    const url = page.url();

    await polls(page, 3);

    expect(page.url()).toBe(url);
    await expect(page.getByRole('tab', { name: 'Sources' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    await expect(page.getByRole('combobox', { name: 'Revision' })).toHaveValue('1');
    await expect(entry).toHaveAttribute('aria-current', 'true');
    await expect(entry.locator('mark')).toBeVisible();
    await expect(composer).toHaveValue('a draft the poll must keep');
    await expect(composer).toBeFocused();
  });
});
