import { expect } from '@playwright/test';
import postgres from 'postgres';

import type { Browser, Page } from '@playwright/test';

export const FLAGSHIP =
  'Review the October incident reports in my authorized Google Drive, identify recurring causes with citations, and draft a summary Google Doc for my approval.';

export const SCREENSHOTS = 'artifacts/p0/screenshots';

let sql: postgres.Sql | undefined;

export function db(): postgres.Sql {
  sql ??= postgres(process.env.DATABASE_URL ?? 'postgres://postgres@postgres:5432/postgres');
  return sql;
}

export async function fixtureDocCount(taskId?: string): Promise<number> {
  const rows =
    taskId === undefined
      ? await db()`select count(*)::int as n from wb_fixture_docs`
      : await db()`select count(*)::int as n from wb_fixture_docs where idempotency_key like ${`wb:${taskId}:%`}`;
  return Number(rows[0]?.n ?? -1);
}

export async function taskCount(owner: string): Promise<number> {
  const rows = await db()`select count(*)::int as n from wb_tasks where owner_sub = ${owner}`;
  return Number(rows[0]?.n ?? -1);
}

export async function signIn(page: Page, user: 'alice' | 'bob' = 'alice'): Promise<void> {
  await page.goto('/_auth/sign-in');
  await page.getByRole('button', { name: `Continue as ${user}@example.test` }).click();
  await expect(page.getByRole('heading', { name: 'New task' })).toBeVisible();
}

export async function newUserPage(
  browser: Browser,
  user: 'alice' | 'bob' = 'alice',
): Promise<Page> {
  const context = await browser.newContext();
  const page = await context.newPage();
  await signIn(page, user);
  return page;
}

export function trackConsoleErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  page.on('pageerror', (error) => errors.push(error.message));
  return errors;
}

export async function startTask(page: Page, objective: string): Promise<string> {
  await page.goto('/');
  const field = page.getByRole('textbox', { name: 'Objective' });
  await field.fill(objective);
  await field.press('Control+Enter');
  await page.waitForURL(/\/tasks\/[0-9a-f-]{36}$/);
  return taskIdOf(page);
}

export function taskIdOf(page: Page): string {
  const id = /\/tasks\/([0-9a-f-]{36})/.exec(page.url())?.[1];
  if (id === undefined) throw new Error(`not a task page: ${page.url()}`);
  return id;
}

export async function waitForStatus(page: Page, status: string, timeout = 30_000): Promise<void> {
  await expect(page.locator('#task-live')).toHaveAttribute('data-status', status, { timeout });
}

export async function approve(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Approve and create' }).click();
  await waitForStatus(page, 'completed');
}

export async function noHorizontalOverflow(page: Page): Promise<void> {
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - window.innerWidth,
  );
  expect(overflow, 'page must not scroll horizontally').toBeLessThanOrEqual(0);
}

/** The double-submit token from a page that renders a form; the cookie is already set. */
export async function csrfFrom(page: Page): Promise<string> {
  const back = page.url();
  await page.goto('/');
  const token = await page.locator('input[name=csrf]').first().inputValue();
  if (back !== page.url()) await page.goto(back);
  return token;
}

/** Element capture with the whole element in view, so the sticky top bar never overlaps it. */
export async function captureElement(page: Page, selector: string, path: string): Promise<void> {
  const before = page.viewportSize() ?? { width: 1440, height: 900 };
  const box = await page.locator(selector).evaluate((element) => {
    const rect = element.getBoundingClientRect();
    return { bottom: rect.bottom + window.scrollY };
  });
  await page.setViewportSize({ width: before.width, height: Math.ceil(box.bottom) + 40 });
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.locator(selector).screenshot({ path, mask: [page.locator('[data-redact]')] });
  await page.setViewportSize(before);
}

/** Full-page capture from the top, so the sticky top bar is drawn once, at the top. */
export async function fullShot(page: Page, path: string): Promise<void> {
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({ path, fullPage: true, mask: [page.locator('[data-redact]')] });
}
