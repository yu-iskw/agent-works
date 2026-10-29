import { readFileSync } from 'node:fs';

import { expect, test } from '@playwright/test';

import { fixtureDocCount, signIn, waitForStatus } from '../helpers.js';

// Runs after scripts/p0-e2e.mjs restarted every service including Postgres.
const state = 'artifacts/p0/restart-state.json';

test('after restart: tasks, events, decisions and results are intact', async ({ page }) => {
  const saved = JSON.parse(readFileSync(state, 'utf8')) as {
    completed: string;
    waiting: string;
    events: number;
  };
  await signIn(page);
  await page.goto(`/tasks/${saved.waiting}`);
  await waitForStatus(page, 'waiting_approval');
  await expect(page.locator('[data-event]')).toHaveCount(saved.events);
  await expect(page.locator('[data-evidence]')).toHaveCount(5);
  await page.goto(`/tasks/${saved.completed}`);
  await waitForStatus(page, 'completed');
  await expect(page.locator('[data-decision="approved"]')).toBeVisible();
  await page.locator('[data-result-link]').click();
  await expect(page.getByRole('heading', { name: 'Simulated Google Doc' })).toBeVisible();
  expect(await fixtureDocCount(saved.completed)).toBe(1);
  await page.goto(`/tasks/${saved.waiting}`);
  await page.getByRole('button', { name: 'Approve and create' }).click();
  await waitForStatus(page, 'completed');
  expect(await fixtureDocCount(saved.waiting)).toBe(1);
});
