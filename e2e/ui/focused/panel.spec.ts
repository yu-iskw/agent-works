import { expect, test } from '@playwright/test';

import { db } from '../../m1/helpers.js';
import { apiPost, revisedTask, signInLocal } from '../helpers.js';

import type { Subject } from '../helpers.js';
import type { Locator, Page } from '@playwright/test';

// The adaptive review panel against a task the coordinator already ran: resize by pointer and
// keyboard with clamping, expand and restore, close by button, Back and Escape with focus
// return, citation navigation with return, and revision switching that keeps views consistent.
// No message is sent and no task is created here, so no model call is spent.

const subject = (): Promise<Subject | undefined> => revisedTask('alpha');

const resultUrl = (s: Subject, revision: number, view = '') =>
  `/s/alpha/teammates/${s.teammateId}/tasks/${s.taskId}/results/${revision}${view}`;

const panel = (page: Page): Locator => page.getByRole('region', { name: 'Result' });
const separator = (page: Page): Locator =>
  page.getByRole('separator', { name: 'Resize the panel' });
const panelWidth = async (page: Page): Promise<number> =>
  (await page.locator('.ws-panel').boundingBox())?.width ?? 0;

async function openResult(page: Page, s: Subject, revision = s.latest): Promise<void> {
  await page.goto(resultUrl(s, revision));
  await expect(panel(page)).toBeVisible();
  await expect(page.getByRole('tab', { name: 'Result', exact: true })).toHaveAttribute(
    'aria-selected',
    'true',
  );
}

test.describe('review panel', () => {
  let s: Subject | undefined;
  test.beforeAll(async () => {
    s = await subject();
  });
  test.beforeEach(async ({ page }) => {
    test.skip(s === undefined, 'no completed alice task with two or more revisions in alpha');
    await signInLocal(page, 'alice@local.test');
  });

  test('pointer and keyboard resize the split and stay within the clamp', async ({ page }) => {
    await openResult(page, s!);
    expect((await apiPost(page, '/api/s/alpha/preferences', { panelWidth: 480 })).status()).toBe(
      200,
    );
    await page.reload();
    await expect(panel(page)).toBeVisible();
    const sep = separator(page);
    await expect(sep).toHaveAttribute('aria-orientation', 'vertical');
    const before = await panelWidth(page);
    const box = (await sep.boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + 200);
    await page.mouse.down();
    await page.mouse.move(box.x - 120, box.y + 200, { steps: 6 });
    await page.mouse.up();
    const dragged = await panelWidth(page);
    expect(dragged).toBeGreaterThan(before + 100);
    expect(Number(await sep.getAttribute('aria-valuenow'))).toBe(Math.round(dragged));

    await sep.focus();
    await page.keyboard.press('ArrowRight');
    expect(await panelWidth(page)).toBe(dragged - 16);
    await page.keyboard.press('ArrowLeft');
    expect(await panelWidth(page)).toBe(dragged);

    await page.keyboard.press('Home');
    const min = Number(await sep.getAttribute('aria-valuemin'));
    expect(await panelWidth(page)).toBe(min);
    await page.keyboard.press('End');
    const max = Number(await sep.getAttribute('aria-valuemax'));
    expect(await panelWidth(page)).toBe(max);
    const conversation = (await page.locator('.ws-main').boundingBox())!.width;
    expect(conversation).toBeGreaterThanOrEqual(360);
    expect(max).toBeLessThanOrEqual(1440 - 360 - 300);

    // The width is a member preference: a reload keeps it.
    await page.waitForTimeout(600);
    await page.reload();
    await expect(panel(page)).toBeVisible();
    expect(await panelWidth(page)).toBe(max);
  });

  test('expand takes the content area and restore brings the conversation back unchanged', async ({
    page,
  }) => {
    await openResult(page, s!);
    const composer = page.getByRole('textbox', { name: 'Message' });
    await composer.fill('draft that must survive');
    await page.getByRole('button', { name: 'Expand the panel' }).click();
    await expect(composer).toBeHidden();
    await expect(page.locator('main.ws-main .ws-panel')).toBeVisible();
    await expect(separator(page)).toHaveCount(0);
    await expect(panel(page)).toBeVisible();
    await page.getByRole('button', { name: 'Restore the split view' }).click();
    await expect(composer).toBeVisible();
    await expect(composer).toHaveValue('draft that must survive');
    await expect(panel(page)).toBeVisible();
  });

  test('close, Back and Escape return to the conversation and to the invoking control', async ({
    page,
  }) => {
    await page.goto(`/s/alpha/teammates/${s!.teammateId}`);
    const open = page.getByRole('button', { name: 'Open result' }).last();
    await open.scrollIntoViewIfNeeded();
    await open.click();
    await expect(panel(page)).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Result', level: 2 })).toBeFocused();
    await expect(page).toHaveURL(/\/results\/\d+$/);

    await page.keyboard.press('Escape');
    await expect(panel(page)).toHaveCount(0);
    await expect(page).toHaveURL((url) => url.pathname.endsWith(`/teammates/${s!.teammateId}`));
    await expect(open).toBeFocused();

    await open.click();
    await expect(panel(page)).toBeVisible();
    await page.goBack();
    await expect(panel(page)).toHaveCount(0);
    await expect(page).toHaveURL((url) => url.pathname.endsWith(`/teammates/${s!.teammateId}`));

    await open.click();
    await expect(panel(page)).toBeVisible();
    await page.getByRole('button', { name: 'Close panel' }).click();
    await expect(panel(page)).toHaveCount(0);
    await expect(open).toBeFocused();
  });

  test('a citation opens Sources at that entry and Back to result restores the place', async ({
    page,
  }) => {
    test.skip(s!.cited === undefined, 'the latest revision cites no evidence');
    await openResult(page, s!);
    const body = page.locator('.pn-body');
    const cite = page.getByRole('button', { name: `Open source ${s!.cited}` }).first();
    await cite.scrollIntoViewIfNeeded();
    const before = await body.evaluate((el) => el.scrollTop);
    await cite.click();
    await expect(page.getByRole('tab', { name: 'Sources' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    await expect(page).toHaveURL(
      (url) => url.pathname.endsWith('/sources') && url.searchParams.get('citation') === s!.cited,
    );
    const entry = page.locator(`#ev-${s!.cited}`);
    await expect(entry).toHaveAttribute('aria-current', 'true');
    await expect(entry).toBeFocused();
    await expect(entry.locator('mark')).toBeVisible();

    await page.getByRole('button', { name: 'Back to result' }).click();
    await expect(page.getByRole('tab', { name: 'Result', exact: true })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    await expect(page).toHaveURL(/\/results\/\d+$/);
    await expect.poll(() => body.evaluate((el) => el.scrollTop)).toBe(before);
  });

  test('switching the revision updates the result, sources and changes together', async ({
    page,
  }) => {
    await openResult(page, s!);
    const select = page.getByRole('combobox', { name: 'Revision' });
    await expect(select).toHaveValue(String(s!.latest));
    await select.selectOption(String(s!.latest - 1));
    await expect(page).toHaveURL((url) => url.pathname.endsWith(`/results/${s!.latest - 1}`));
    await expect(
      page.getByText(`You are reading revision ${s!.latest - 1} of ${s!.latest}`),
    ).toBeVisible();

    await page.getByRole('tab', { name: 'Changes' }).click();
    await expect(page).toHaveURL((url) =>
      url.pathname.endsWith(`/results/${s!.latest - 1}/changes`),
    );
    const changes = page.getByRole('tabpanel', { name: 'Changes' });
    await expect(changes).toContainText(
      s!.latest - 1 === 1 ? 'First revision' : `revision ${s!.latest - 1}`,
    );

    await page.getByRole('tab', { name: 'Sources' }).click();
    await expect(page).toHaveURL((url) =>
      url.pathname.endsWith(`/results/${s!.latest - 1}/sources`),
    );
    const [{ n }] = await db('alpha')<{ n: number }[]>`
      select jsonb_array_length(evidence_ids)::int as n from tw_revisions
      where task_id = ${s!.taskId} and revision = ${s!.latest - 1}`;
    if (n > 0) await expect(page.locator('.ev')).toHaveCount(n);

    await page.getByRole('button', { name: 'Open the latest' }).click();
    await expect(page).toHaveURL((url) => url.pathname.endsWith(`/results/${s!.latest}/sources`));
    await expect(select).toHaveValue(String(s!.latest));
  });

  test('tablet and phone show one surface with an obvious way back', async ({ page }) => {
    await page.setViewportSize({ width: 900, height: 900 });
    await openResult(page, s!);
    await expect(page.getByRole('textbox', { name: 'Message' })).toBeHidden();
    // The panel is the page now: still one main landmark with a level-one heading.
    await expect(page.locator('main.ws-main .ws-panel')).toBeVisible();
    await expect(page.locator('h1:visible')).toHaveCount(1);
    await expect(separator(page)).toHaveCount(0);
    await page.getByRole('button', { name: 'Back to conversation' }).click();
    await expect(page.getByRole('textbox', { name: 'Message' })).toBeVisible();

    await page.setViewportSize({ width: 375, height: 812 });
    await openResult(page, s!);
    const box = (await page.locator('.ws-panel').boundingBox())!;
    expect(Math.round(box.width)).toBe(375);
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth > document.documentElement.clientWidth,
    );
    expect(overflow).toBe(false);
    await page.getByRole('button', { name: 'Back to conversation' }).click();
    await expect(page.getByRole('textbox', { name: 'Message' })).toBeVisible();
  });
});
