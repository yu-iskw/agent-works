import { writeFileSync } from 'node:fs';

import { expect, test } from '@playwright/test';

import { FLAGSHIP, signIn, startTask, waitForStatus } from '../helpers.js';

// scripts/p0-e2e.mjs runs this, restarts every service including Postgres, then runs after.spec.ts.
const state = 'artifacts/p0/restart-state.json';

test('before restart: leave one completed and one waiting task', async ({ page }) => {
  await signIn(page);
  const completed = await startTask(page, FLAGSHIP);
  await waitForStatus(page, 'waiting_approval');
  await page.getByRole('button', { name: 'Approve and create' }).click();
  await waitForStatus(page, 'completed');
  const waiting = await startTask(page, FLAGSHIP);
  await waitForStatus(page, 'waiting_approval');
  const events = await page.locator('[data-event]').count();
  writeFileSync(state, JSON.stringify({ completed, waiting, events }));
});
