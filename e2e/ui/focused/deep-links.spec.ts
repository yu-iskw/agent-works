import { expect, test } from '@playwright/test';

import { endsWith, revisedTask, seedBobTask, signInLocal } from '../helpers.js';

import type { Subject } from '../helpers.js';

// Direct URLs to a task, a result revision and its views open exactly that object for the member
// who owns it. An unknown, foreign or cross-segment id lands on a safe missing panel that names
// nothing from the other record. No message is sent and no model is called.

const BETA_IN_ALPHA = (s: Subject, taskId: string) =>
  `/s/alpha/teammates/${s.teammateId}/tasks/${taskId}`;

test.describe('deep links', () => {
  let alpha: Subject | undefined;
  let beta: Subject | undefined;
  test.beforeAll(async () => {
    [alpha, beta] = await Promise.all([revisedTask('alpha'), revisedTask('beta')]);
  });
  test.beforeEach(async ({ page }) => {
    test.skip(alpha === undefined, 'no alpha task of alice with two revisions');
    test.skip(beta === undefined, 'no beta task of alice with two revisions');
    await signInLocal(page, 'alice@local.test');
  });

  test('a task URL, a revision URL and its Sources and Changes views open that exact object', async ({
    page,
  }) => {
    const s = alpha!;
    const base = `/s/alpha/teammates/${s.teammateId}/tasks/${s.taskId}`;
    await page.goto(base);
    await expect(page.getByRole('heading', { level: 2, name: 'Task' })).toBeVisible();
    await expect(page.getByRole('region', { name: 'Task' })).toContainText(s.title);
    await expect(page.getByRole('textbox', { name: 'Message' })).toBeVisible();

    await page.goto(`${base}/results/1/sources`);
    await expect(page.getByRole('tab', { name: 'Sources' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    await expect(page.getByRole('combobox', { name: 'Revision' })).toHaveValue('1');
    await expect(page.getByText(`You are reading revision 1 of ${s.latest}`)).toBeVisible();

    await page.goto(`${base}/results/${s.latest}/changes`);
    await expect(page.getByRole('tab', { name: 'Changes' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    await expect(page.getByRole('combobox', { name: 'Revision' })).toHaveValue(String(s.latest));
    await expect(page).toHaveURL(endsWith(`/results/${s.latest}/changes`));
  });

  test('an unknown task id and another member’s task id show the missing panel and nothing of theirs', async ({
    page,
  }) => {
    const s = alpha!;
    const bob = await seedBobTask();
    for (const id of ['00000000-0000-4000-8000-000000000000', bob.id]) {
      const response = await page.goto(BETA_IN_ALPHA(s, id));
      expect(response?.status()).toBeLessThan(500);
      await expect(page.getByRole('alert')).toContainText('This task is not available to you');
      await expect(page.getByRole('textbox', { name: 'Message' })).toBeVisible();
      await expect(page.locator('body')).not.toContainText(bob.title);
    }
    const revision = await page.goto(`${BETA_IN_ALPHA(s, bob.id)}/results/1`);
    expect(revision?.status()).toBeLessThan(500);
    await expect(page.getByRole('alert')).toContainText('This task is not available to you');
    await expect(page.locator('body')).not.toContainText(bob.title);
  });

  test('a beta task id under /s/alpha is not found and never shows the beta record', async ({
    page,
  }) => {
    const s = alpha!;
    const b = beta!;
    await page.goto(BETA_IN_ALPHA(s, b.taskId));
    await expect(page.getByRole('alert')).toContainText('This task is not available to you');
    await expect(page.locator('body')).not.toContainText(b.title);
    const api = await page.request.get(`/api/s/alpha/tasks/${b.taskId}`);
    expect(api.status()).toBe(404);
    expect(await api.text()).not.toContain(b.title);
  });

  test('a task URL without its teammate and an unknown teammate are safe not-found pages', async ({
    page,
  }) => {
    const bob = await seedBobTask();
    const bare = await page.goto(`/s/alpha/tasks/${bob.id}`);
    expect(bare?.status()).toBe(404);
    await expect(page.locator('body')).not.toContainText(bob.title);
    const gone = await page.goto('/s/alpha/teammates/00000000-0000-4000-8000-000000000001');
    expect(gone?.status()).toBe(404);
    await expect(page.locator('.pn').getByRole('alert')).toContainText(
      'This teammate is not available to you',
    );
    await page.getByRole('tab', { name: 'Teammates' }).click();
    await expect(page.getByRole('list', { name: 'Teammates' })).toBeVisible();
  });
});
