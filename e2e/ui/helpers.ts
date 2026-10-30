import { existsSync } from 'node:fs';

import { expect, test } from '@playwright/test';

import type { Page } from '@playwright/test';

const ARTIFACTS = 'artifacts/ui';
const SCREENSHOTS = `${ARTIFACTS}/screenshots`;
const APPROVED = `${ARTIFACTS}/baselines/approved`;

export type Member = 'alice@local.test' | 'bob@local.test';

/** Mock identity sign-in; the stack labels it as simulated on the page. */
export async function signInLocal(page: Page, email: Member = 'alice@local.test'): Promise<void> {
  await page.goto('/sign-in');
  await page.getByRole('button', { name: `Continue as ${email}` }).click();
  await expect(page).not.toHaveURL(/\/sign-in/);
}

async function shot(page: Page, name: string): Promise<void> {
  await page.screenshot({ path: `${SCREENSHOTS}/${name}.png`, fullPage: true });
}

/**
 * Writes the capture for human review and compares it only when an approved baseline exists.
 * Without one the test records a `pending-baseline` annotation, which `ui:visual` reports as
 * PENDING; nothing here can create an approved file.
 */
export async function captureForBaseline(page: Page, name: string): Promise<void> {
  await shot(page, name);
  // eslint-disable-next-line security/detect-non-literal-fs-filename
  if (existsSync(`${APPROVED}/${name}.png`)) {
    await expect(page).toHaveScreenshot(`${name}.png`, { fullPage: true });
    return;
  }
  test.info().annotations.push({ type: 'pending-baseline', description: name });
}
