import { AxeBuilder } from '@axe-core/playwright';
import { expect, test } from '@playwright/test';

import { ensureStarterTeam, signInLocal, teammateId } from '../helpers.js';

import type { Locator, Page } from '@playwright/test';

async function openBot(page: Page): Promise<string> {
  const stack = await page.request.get('/sign-in').catch(() => undefined);
  test.skip(stack === undefined || !stack.ok(), 'AW_BOT_WORKFLOWS stack is not reachable.');
  await signInLocal(page);
  await ensureStarterTeam(page, 'alpha');
  const id = await teammateId(page, 'alpha', 'Coordinator');
  await page.goto(`/s/alpha/bots/${id}`);
  test.skip(
    await page.getByRole('heading', { name: 'Bot workflows unavailable' }).isVisible(),
    'AW_BOT_WORKFLOWS stack is not enabled.',
  );
  return id;
}

async function requestDesign(page: Page, message: string): Promise<void> {
  await page.getByLabel('Your request').fill(message);
  await page.getByRole('button', { name: 'Send design request' }).click();
}

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
  await expect(page.getByText('Data sent externally', { exact: false })).toBeVisible();
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
    await expect(page.getByRole('button', { name: 'Approve', exact: true })).toBeVisible();
  }).toPass({ timeout: 120_000, intervals: [2000] });
  await page.getByRole('button', { name: 'Approve', exact: true }).click();
  await expect(async () => {
    await page.reload();
    await expect(page.getByText('completed', { exact: true })).toBeVisible();
  }).toPass({ timeout: 120_000, intervals: [2000] });
  await expect(page.getByRole('heading', { name: 'Result' })).toBeVisible();
  await expect(page.getByText(/Cost completeness:/)).toBeVisible();
  await other.close();
});

async function tabTo(page: Page, target: Locator): Promise<void> {
  for (let i = 0; i < 100; i += 1) {
    if (await target.evaluate((element) => element === document.activeElement)) return;
    await page.keyboard.press('Tab');
  }
  throw new Error('Control could not be reached by keyboard');
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
  const result = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21aa'])
    .analyze();
  expect(
    result.violations.filter(
      (violation) => violation.impact === 'critical' || violation.impact === 'serious',
    ),
  ).toEqual([]);
  await tabTo(page, page.getByRole('button', { name: 'Confirm and publish this revision' }));
  await page.keyboard.press('Enter');
  await tabTo(page, page.getByRole('button', { name: 'Start run' }));
  await page.keyboard.press('Enter');
  await expect(async () => {
    await page.reload();
    await expect(page.getByRole('button', { name: 'Approve', exact: true })).toBeVisible();
  }).toPass({ timeout: 120_000, intervals: [2000] });
  await tabTo(page, page.getByRole('button', { name: 'Approve', exact: true }));
  await page.keyboard.press('Enter');
  await expect(async () => {
    await page.reload();
    await expect(page.getByText('completed', { exact: true })).toBeVisible();
  }).toPass({ timeout: 120_000, intervals: [2000] });
});
