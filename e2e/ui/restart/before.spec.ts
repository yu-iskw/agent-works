import { mkdirSync, writeFileSync } from 'node:fs';

import { expect, test } from '@playwright/test';

import { db } from '../../m1/helpers.js';
import { campaignCalls, coordinator, signInLocal } from '../helpers.js';

// First half of `pnpm ui:restart`: starts real parallel work from the conversation and types a
// draft, then hands the ids and the browser state to after.spec.ts. The runner kills api-alpha
// while an assignment is running. Spends the task's calls (about four with the resumed one).

export const STATE = 'artifacts/ui/restart-state.json';
export const STORAGE = 'artifacts/ui/restart-storage.json';

export type RestartState = {
  readonly taskId: string;
  readonly title: string;
  readonly teammateId: string;
  readonly conversationId: string;
  readonly draft: string;
  readonly messagesBefore: number;
  readonly callsBefore: number;
  readonly startedAt: string;
};

test('start parallel work and leave a draft while an assignment is running', async ({ page }) => {
  test.setTimeout(240_000);
  const callsBefore = await campaignCalls('alpha');
  await signInLocal(page, 'alice@local.test');
  const owner = await coordinator('alpha');
  await page.goto(`/s/alpha/teammates/${owner.id}`);
  const message = page.getByRole('textbox', { name: 'Message' });
  const objective = `Restart probe ${Date.now()}: which feature-flag service fits the EU residency requirement?`;
  await message.fill(objective);
  await page.getByRole('button', { name: 'Add to the message' }).click();
  await page.getByRole('option', { name: /Create task/ }).click();
  const draft = page.locator('.card[data-kind="task_draft"]');
  await expect(draft).toBeVisible();
  await draft.getByLabel('Workflow').selectOption('research_brief');
  // The conversation's own teammate is prefilled; the Coordinator owns the result instead.
  const prefilled = draft.getByRole('button', { name: 'Remove Coordinator' });
  if (await prefilled.isVisible()) await prefilled.click();
  for (const name of ['Research analyst', 'Risk and compliance reviewer']) {
    await draft.getByRole('button', { name: 'Add specialist' }).click();
    await page
      .getByRole('list', { name: 'Teammates to add' })
      .getByRole('button')
      .filter({ hasText: name })
      .first()
      .click();
  }
  await expect(draft.getByRole('list', { name: 'Specialists' }).getByRole('listitem')).toHaveCount(
    2,
  );
  await expect(draft.locator('#td-problems')).toHaveCount(0);
  await draft.getByRole('button', { name: 'Start' }).click();
  await expect(draft).toBeHidden();
  const rows = () =>
    db('alpha')<{ id: string; title: string }[]>`
      select id, title from wb_tasks where owner_sub = 'local-test:alice' and objective = ${objective}`;
  await expect.poll(async () => (await rows()).length, { timeout: 30_000 }).toBe(1);
  const [task] = await rows();
  if (task === undefined) throw new Error('the task row disappeared');
  await expect(page.locator(`li.card[id^="card:${task.id}:"]`).first()).toBeVisible();

  const typed = `Draft typed before the restart ${Date.now()}`;
  await message.fill(typed);
  await expect
    .poll(() => page.evaluate(() => JSON.stringify(Object.values(localStorage))))
    .toContain(typed);
  await expect
    .poll(
      async () =>
        (
          await db('alpha')<{ n: number }[]>`
            select count(*)::int as n from tw_assignments where task_id = ${task.id} and status = 'running'`
        )[0]?.n,
      { timeout: 90_000 },
    )
    .toBeGreaterThan(0);
  const [messages] = await db('alpha')<{ n: number }[]>`
    select count(*)::int as n from tw_messages where conversation_id = ${owner.conversationId}`;
  const state: RestartState = {
    taskId: task.id,
    title: task.title,
    teammateId: owner.id,
    conversationId: owner.conversationId,
    draft: typed,
    messagesBefore: messages?.n ?? 0,
    callsBefore,
    startedAt: new Date().toISOString(),
  };
  mkdirSync('artifacts/ui', { recursive: true });
  writeFileSync(STATE, JSON.stringify(state, null, 2));
  await page.context().storageState({ path: STORAGE });
});
