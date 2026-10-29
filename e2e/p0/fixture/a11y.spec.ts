import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';

import {
  FLAGSHIP,
  SCREENSHOTS,
  fixtureDocCount,
  noHorizontalOverflow,
  signIn,
  startTask,
  taskIdOf,
  waitForStatus,
  fullShot,
} from '../helpers.js';

import type { Page } from '@playwright/test';

async function axe(page: Page, label: string): Promise<void> {
  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
    .analyze();
  const blocking = results.violations.filter(
    (item) => item.impact === 'critical' || item.impact === 'serious',
  );
  expect(
    blocking.map(
      (item) => `${item.id}: ${item.nodes.map((node) => node.target.join(' ')).join(', ')}`,
    ),
    `${label}: critical/serious axe violations`,
  ).toEqual([]);
}

test('primary screens have no critical or serious axe violations', async ({ page }) => {
  await page.goto('/_auth/sign-in');
  await axe(page, 'sign-in');
  await signIn(page);
  await axe(page, 'home');
  await startTask(page, FLAGSHIP);
  await waitForStatus(page, 'waiting_approval');
  await axe(page, 'task waiting approval');
  await page.getByRole('button', { name: 'Approve and create' }).click();
  await waitForStatus(page, 'completed');
  await axe(page, 'task completed');
  await page.locator('[data-result-link]').click();
  await axe(page, 'simulated document');
  for (const path of ['/tasks', '/approvals', '/connections']) {
    await page.goto(path);
    await axe(page, path);
  }
  await startTask(page, `${FLAGSHIP} [stub:unavailable]`);
  await waitForStatus(page, 'failed');
  await axe(page, 'task failed');
});

test('the flagship flow completes with the keyboard alone', async ({ page }) => {
  await signIn(page);
  await page.goto('/');
  await page.keyboard.press('Tab');
  await expect(page.locator('.skip-link')).toBeFocused();
  await page.keyboard.press('Enter');
  let reached = false;
  for (let index = 0; index < 20 && !reached; index += 1) {
    await page.keyboard.press('Tab');
    reached = await page
      .getByRole('textbox', { name: 'Objective' })
      .evaluate((field) => field === document.activeElement);
  }
  expect(reached, 'objective field reachable by Tab').toBe(true);
  await page.keyboard.type(FLAGSHIP);
  await page.keyboard.press('Control+Enter');
  await page.waitForURL(/\/tasks\//);
  const id = taskIdOf(page);
  await waitForStatus(page, 'waiting_approval');
  let onApprove = false;
  for (let index = 0; index < 80 && !onApprove; index += 1) {
    await page.keyboard.press('Tab');
    onApprove = await page.evaluate(
      () => document.activeElement?.textContent?.includes('Approve and create') ?? false,
    );
  }
  expect(onApprove, 'approve button reachable by Tab').toBe(true);
  await expect(page.getByRole('button', { name: 'Approve and create' })).toBeFocused();
  const outline = await page.evaluate(
    () => getComputedStyle(document.activeElement as Element).outlineStyle,
  );
  expect(outline).not.toBe('none');
  await page.keyboard.press('Enter');
  await waitForStatus(page, 'completed');
  await expect(page.locator('#announcer')).toHaveText(/Task status: Completed|^$/);
  expect(await fixtureDocCount(id)).toBe(1);
});

test('status changes are announced to assistive technology', async ({ page }) => {
  await signIn(page);
  await startTask(page, `${FLAGSHIP} [stub:slow]`);
  await expect(page.locator('#announcer')).toHaveAttribute('aria-live', 'polite');
  await expect(page.locator('#announcer')).toHaveText('Task status: Needs approval', {
    timeout: 30_000,
  });
});

test('reduced motion disables animation', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await signIn(page);
  await startTask(page, `${FLAGSHIP} [stub:slow]`);
  const duration = await page
    .locator('.progress-line .spinner')
    .evaluate((element) => getComputedStyle(element).animationDuration);
  expect(Number.parseFloat(duration)).toBeLessThan(0.01);
});

for (const [width, height, name] of [
  [375, 812, 'mobile'],
  [768, 1024, 'tablet'],
  [1440, 900, 'desktop'],
] as const) {
  test(`responsive layout at ${width}x${height}`, async ({ page }) => {
    await page.setViewportSize({ width, height });
    await signIn(page);
    await noHorizontalOverflow(page);
    await fullShot(page, `${SCREENSHOTS}/10-home-${name}-${width}.png`);
    const menu = page.getByRole('button', { name: 'Open navigation' });
    if (width < 900) {
      await expect(page.getByRole('navigation', { name: 'Primary' })).toBeHidden();
      await menu.click();
      await expect(page.getByRole('link', { name: 'Tasks', exact: true })).toBeVisible();
      await expect(menu).toHaveAttribute('aria-expanded', 'true');
      await page.keyboard.press('Escape');
      await expect(menu).toHaveAttribute('aria-expanded', 'false');
      await expect(menu).toBeFocused();
    } else {
      await expect(menu).toBeHidden();
      await expect(page.getByRole('link', { name: 'Tasks', exact: true })).toBeVisible();
    }
    await startTask(page, FLAGSHIP);
    await waitForStatus(page, 'waiting_approval');
    await noHorizontalOverflow(page);
    await fullShot(page, `${SCREENSHOTS}/11-task-${name}-${width}.png`);
    const approveButton = page.getByRole('button', { name: 'Approve and create' });
    await approveButton.scrollIntoViewIfNeeded();
    await expect(approveButton).toBeInViewport();
    await expect(page.getByRole('button', { name: 'Reject' })).toBeVisible();
    for (const path of ['/tasks', '/connections', '/approvals']) {
      await page.goto(path);
      await noHorizontalOverflow(page);
    }
    await page.goto('/connections');
    await fullShot(page, `${SCREENSHOTS}/13-connections-${name}-${width}.png`);
  });
}
