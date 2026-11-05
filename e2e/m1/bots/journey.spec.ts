import { AxeBuilder } from '@axe-core/playwright';
import { expect, test } from '@playwright/test';

import { openBot, requestDesign } from './helpers.js';

import type { Locator, Page } from '@playwright/test';

test('design, reject malformed, refuse stale publication, publish and operate a run', async ({
  page,
  context,
}) => {
  test.setTimeout(180_000);
  const id = await openBot(page);
  await requestDesign(page, '[malformed]');
  await expect(page.getByRole('heading', { name: 'Changes needed' })).toBeVisible();
  await requestDesign(page, 'Make a research brief');
  await expect(page.getByRole('heading', { name: /Review draft revision/ })).toBeVisible();
  await expect(
    page.getByText('Data sent externally to Local reference research agent'),
  ).toBeVisible();
  await expect(page.getByText('Asia/Tokyo', { exact: false })).toBeVisible();
  const other = await context.newPage();
  await other.goto(`/s/alpha/bots/${id}`);
  await requestDesign(other, 'Change the read step');
  await expect(other.getByRole('heading', { name: /Review draft revision/ })).toBeVisible();
  await page.getByRole('button', { name: 'Confirm and publish this revision' }).click();
  await expect(page.getByRole('alert')).toContainText('This draft changed since you reviewed it');
  await page.getByRole('link', { name: 'Reload', exact: true }).click();
  await page.getByRole('button', { name: 'Confirm and publish this revision' }).click();
  await page.getByRole('button', { name: 'Start run' }).click();
  await expect(page.getByRole('heading', { name: 'Bot run' })).toBeVisible();
  await expect(async () => {
    await page.reload();
    await expect(page.getByRole('button', { name: 'Approve', exact: true })).toBeVisible({
      timeout: 3000,
    });
  }).toPass({ timeout: 120_000, intervals: [2000] });
  await page.getByRole('button', { name: 'Approve', exact: true }).click();
  await expect(async () => {
    await page.reload();
    await expect(page.getByText('completed', { exact: true })).toBeVisible({ timeout: 3000 });
  }).toPass({ timeout: 120_000, intervals: [2000] });
  await expect(page.getByRole('heading', { name: 'Result' })).toBeVisible();
  await expect(page.getByText(/Cost completeness: (partial|unknown)/)).toBeVisible();
  await expect(page.getByText(/Estimated: unknown/)).toBeVisible();
  await other.close();
});

async function tabTo(page: Page, target: Locator): Promise<void> {
  for (let i = 0; i < 100; i += 1) {
    if (await target.evaluate((element) => element === document.activeElement)) return;
    await page.keyboard.press('Tab');
  }
  throw new Error('Control could not be reached by keyboard');
}

async function assertAccessible(page: Page): Promise<void> {
  const result = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21aa'])
    .analyze();
  expect(
    result.violations.filter(
      (violation) => violation.impact === 'critical' || violation.impact === 'serious',
    ),
  ).toEqual([]);
}

test('the critical path is keyboard operable and passes axe', async ({ page }) => {
  test.setTimeout(180_000);
  await openBot(page);
  await tabTo(page, page.getByLabel('Your request'));
  await page.keyboard.type('Create a research brief');
  await page.keyboard.press('Tab');
  await expect(page.getByRole('button', { name: 'Send design request' })).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('heading', { name: /Review draft revision/ })).toBeVisible();
  await assertAccessible(page);
  await tabTo(page, page.getByRole('button', { name: 'Confirm and publish this revision' }));
  await Promise.all([
    page.waitForURL(/\/s\/alpha\/bots\/[0-9a-f-]+$/),
    page.keyboard.press('Enter'),
  ]);
  await expect(page.getByRole('heading', { name: /Review draft revision/ })).toHaveCount(0);
  await tabTo(page, page.getByRole('button', { name: 'Start run' }));
  await expect(page.getByRole('button', { name: 'Start run' })).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('heading', { name: 'Bot run' })).toBeVisible();
  await expect(async () => {
    await page.reload();
    await expect(page.getByRole('button', { name: 'Approve', exact: true })).toBeVisible({
      timeout: 3000,
    });
  }).toPass({ timeout: 120_000, intervals: [2000] });
  await tabTo(page, page.getByRole('button', { name: 'Approve', exact: true }));
  await Promise.all([
    page.waitForResponse(
      (response) =>
        response.url().includes('/approvals/') && response.request().method() === 'POST',
    ),
    page.keyboard.press('Enter'),
  ]);
  await expect(async () => {
    await page.reload();
    await expect(page.getByText('completed', { exact: true })).toBeVisible({ timeout: 3000 });
  }).toPass({ timeout: 120_000, intervals: [2000] });
  await assertAccessible(page);
});
