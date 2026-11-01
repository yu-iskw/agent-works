import { expect, test } from '@playwright/test';

import { db } from '../../m1/helpers.js';
import { SEED_PREFIX, endsWith, seedHistory, seedUnreadReply, signInLocal } from '../helpers.js';

// Working, Unread and Needs you are three labels on three different rows at once, and opening an
// inbox item changes nothing in tw_inbox: only an answer, an approval or a dismissal resolves it.
// No model is called.

const ALICE = 'local-test:alice';

async function openInbox(): Promise<readonly { id: string; state: string }[]> {
  return db('alpha')<{ id: string; state: string }[]>`
    select id, state from tw_inbox where owner_sub = ${ALICE} order by id`;
}

test('labels are distinct text and opening an item never resolves it', async ({ page }) => {
  await signInLocal(page, 'alice@local.test');
  const seeded = await seedHistory(120);
  const [other] = await db('alpha')<{ id: string; conversation_id: string }[]>`
    select id, conversation_id from tw_teammates
    where owner_sub = ${ALICE} and not archived and id <> ${seeded.teammateId}
    order by created_at limit 1`;
  await seedUnreadReply(other.conversation_id, `${SEED_PREFIX} unread elsewhere ${Date.now()}`);
  await page.goto(`/s/alpha/teammates/${seeded.teammateId}`);
  await page.getByRole('tab', { name: 'Teammates' }).click();
  const rows = page.getByRole('list', { name: 'Teammates' }).getByRole('listitem');
  const seededRow = rows.filter({
    has: page.locator(`a[href$="/teammates/${seeded.teammateId}"]`),
  });
  const otherRow = rows.filter({ has: page.locator(`a[href$="/teammates/${other.id}"]`) });
  await expect(seededRow.locator('.flag-working')).toHaveText('Working');
  await expect(seededRow.locator('.flag-attention')).toHaveText('Needs you');
  await expect(seededRow.locator('.flag-unread')).toHaveCount(0);
  await expect(otherRow.locator('.flag-unread')).toHaveText('Unread');
  const labels = await page
    .locator('.flag-working, .flag-attention, .flag-unread')
    .evaluateAll((nodes) => nodes.map((n) => [n.className, n.textContent?.trim()]));
  expect(new Set(labels.map(([, text]) => text)).size).toBe(3);

  const before = await openInbox();
  expect(before.some((row) => row.state === 'open')).toBe(true);
  await page.getByRole('button', { name: /^Inbox/ }).click();
  const decisions = page.getByRole('region', { name: 'Needs your decision' });
  const item = decisions.getByRole('button').filter({ hasText: `${SEED_PREFIX} question task` });
  await expect(item.first()).toBeVisible();
  await item.first().click();
  await expect(page).toHaveURL(endsWith(`/tasks/${seeded.attentionTaskId}`));
  await expect(page.getByRole('heading', { level: 2, name: 'Task' })).toBeVisible();
  await page.goBack();
  await expect(page.getByRole('heading', { level: 2, name: 'Attention inbox' })).toBeVisible();
  await expect(item.first()).toBeVisible();
  expect(await openInbox()).toEqual(before);
});
