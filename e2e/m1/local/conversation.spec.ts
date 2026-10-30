import { expect, test } from '@playwright/test';

import { db, ensureStarterTeam, shot, signInLocal, teammateId } from '../helpers.js';

const RUN = Date.now();
const PROMPT = `How would you split a vendor comparison between two specialists? (run ${RUN})`;
const TASK = `Conversation-linked task ${RUN}: compare the vendors.`;

test('a teammate conversation persists, replies with the real model, and links the tasks started from it', async ({
  page,
}) => {
  test.setTimeout(300_000);
  await signInLocal(page);
  await ensureStarterTeam(page, 'alpha');
  const id = await teammateId(page, 'alpha', 'Coordinator');
  await page.goto(`/s/alpha/teammates/${id}`);
  await page.getByLabel('Message').fill(PROMPT);
  await page.getByRole('button', { name: 'Send' }).click();
  await expect(page.getByText(PROMPT)).toBeVisible();
  await expect(
    page
      .locator('.msg-member', { hasText: PROMPT })
      .locator('xpath=following-sibling::div[contains(@class,"msg-teammate")]')
      .first(),
  ).toBeVisible({ timeout: 120_000 });
  await shot(page, '01-teammate-conversation-1440');
  const calls = await db('alpha')<
    { purpose: string }[]
  >`select purpose from wb_model_calls where purpose = 'reply' and outcome = 'ok'`;
  expect(calls.length).toBeGreaterThanOrEqual(1);

  await page.getByRole('link', { name: 'Start a task from this conversation' }).click();
  await expect(page.getByRole('heading', { name: 'New task', level: 1 })).toBeVisible();
  await page.getByLabel('What do you need?').fill(TASK);
  await page.getByRole('radio', { name: /Coordinator proposes a plan/ }).check();
  await page.getByRole('button', { name: 'Start task' }).click();
  await expect(page.getByText('started from a conversation')).toBeVisible();
  await page.getByRole('button', { name: 'Cancel' }).click();
  await page.goto(`/s/alpha/teammates/${id}`);
  await expect(
    page.getByRole('link', { name: `Open task: Conversation-linked task ${RUN}` }),
  ).toBeVisible();
  await page.reload();
  await expect(page.getByText(PROMPT)).toBeVisible();
});
