import { writeFileSync } from 'node:fs';

import { expect, test } from '@playwright/test';

import { db, ensureStarterTeam, signInLocal, taskIdFrom, teammateId } from '../helpers.js';

test('start parallel work and stop while an assignment is running', async ({ page }) => {
  await signInLocal(page);
  await ensureStarterTeam(page, 'alpha');
  const research = await teammateId(page, 'alpha', 'Research analyst');
  const risk = await teammateId(page, 'alpha', 'Risk and compliance reviewer');
  await page.goto('/s/alpha/tasks/new');
  await page
    .getByLabel('What do you need?')
    .fill('Restart probe: which feature-flag service fits the EU requirement?');
  await page.getByLabel('Specialist 1').selectOption(research);
  await page.getByLabel('Assignment').nth(0).fill('Compare prices and EU residency.');
  await page.getByLabel('Specialist 2').selectOption(risk);
  await page.getByLabel('Assignment').nth(1).fill('Find conflicting figures.');
  await page.getByRole('button', { name: 'Start task' }).click();
  const id = taskIdFrom(page);
  await expect
    .poll(
      async () =>
        (
          await db('alpha')<
            { n: number }[]
          >`select count(*)::int as n from tw_assignments where task_id = ${id} and status = 'running'`
        )[0]?.n,
      { timeout: 60_000 },
    )
    .toBeGreaterThan(0);
  await page.goto('/s/alpha/teammates');
  const coordinator = await teammateId(page, 'alpha', 'Coordinator');
  writeFileSync('artifacts/m1/restart-state.json', JSON.stringify({ taskId: id, coordinator }));
});
