import { expect, test } from '@playwright/test';

import { db, ensureStarterTeam, shot, signInLocal, taskIdFrom, waitForStatus } from '../helpers.js';

const QUESTION =
  'Which appointment-reminder channel should clinics adopt before the confirmation requirement takes effect?';

test('coordinator plan is reviewed, edited and approved before any work, then revised and published once', async ({
  page,
}) => {
  test.setTimeout(600_000);
  await signInLocal(page);
  await ensureStarterTeam(page, 'beta');
  await page.goto('/s/beta/tasks/new');
  await page.getByLabel('What do you need?').fill(QUESTION);
  await page.getByRole('radio', { name: /Coordinator proposes a plan/ }).check();
  await page.getByRole('button', { name: 'Start task' }).click();
  const id = taskIdFrom(page);
  const sql = db('beta');

  await waitForStatus(page, 'beta', id, ['plan_review', 'failed']);
  const before = await sql<
    { n: number }[]
  >`select count(*)::int as n from tw_assignments where task_id = ${id}`;
  const queued = await sql<
    { n: number }[]
  >`select count(*)::int as n from tw_jobs where task_id = ${id} and kind = 'assignment'`;
  const calls = await sql<
    { purpose: string }[]
  >`select purpose from wb_model_calls where task_id = ${id} order by id`;
  expect(before[0]?.n, 'no assignments before approval').toBe(0);
  expect(queued[0]?.n, 'no dispatch jobs before approval').toBe(0);
  expect(calls.map((c) => c.purpose)).toEqual(['plan']);

  await page.reload();
  await expect(page.getByRole('heading', { name: /Review plan version 1/ })).toBeVisible();
  await shot(page, '10-plan-review-1440');
  await page.getByText('Edit the plan').click();
  const brief = page.getByRole('textbox', { name: 'Assignment' }).first();
  await brief.fill(`${await brief.inputValue()} Report both values whenever two sources disagree.`);
  await page.getByRole('button', { name: 'Save as a new plan version' }).click();
  await expect(
    page.getByRole('heading', { name: /Review plan version 2 \(edited by you\)/ }),
  ).toBeVisible();
  expect(
    (
      await sql<
        { n: number }[]
      >`select count(*)::int as n from tw_jobs where task_id = ${id} and kind = 'assignment'`
    )[0]?.n,
  ).toBe(0);

  await page.getByRole('button', { name: 'Approve plan v2 and start' }).click();
  await expect(page.getByText('Plan approved.')).toBeVisible();
  await waitForStatus(page, 'beta', id, ['ready', 'needs_input', 'failed']);
  const versions = await sql<
    { plan_version: number }[]
  >`select plan_version from tw_assignments where task_id = ${id}`;
  expect(versions.length).toBeGreaterThanOrEqual(1);
  expect(versions.every((v) => v.plan_version === 2)).toBe(true);

  await page.reload();
  await expect(page.getByText(/Result · revision 1 of 1/)).toBeVisible();
  await page
    .getByRole('link', { name: /^Source E\d+$/ })
    .first()
    .click();
  await expect(page.locator('.ev:target')).toBeVisible();
  await page
    .getByLabel('Request a revision')
    .fill(
      'Keep the SMS delivery rate as an unresolved conflict and add the engineering effort for app push.',
    );
  await page.getByRole('button', { name: 'Request revision' }).click();
  await waitForStatus(page, 'beta', id, ['ready', 'failed']);
  await page.goto(`/s/beta/tasks/${id}/compare?from=1&to=2`);
  await expect(page.getByRole('heading', { name: 'Revision 1 → 2' })).toBeVisible();
  await expect(page.locator('.diff-add').first()).toBeVisible();
  await shot(page, '12-revision-compare-1440');

  await page.goto(`/s/beta/tasks/${id}`);
  await page.getByRole('button', { name: 'Prepare revision 2 for Google Docs' }).click();
  await expect(page.getByRole('heading', { name: 'Approve this exact Google Doc?' })).toBeVisible();
  await expect(page.getByText('alice@local.test (fixture Docs)').first()).toBeVisible();
  await expect(page.getByLabel('Document content')).toContainText('Sources');
  await shot(page, '13-action-approval-1440');
  expect(
    (
      await sql<
        { n: number }[]
      >`select count(*)::int as n from wb_fixture_docs where idempotency_key like ${`tw:${id}:%`}`
    )[0]?.n,
  ).toBe(0);
  await page.getByRole('button', { name: 'Approve and create the document' }).click();
  await waitForStatus(page, 'beta', id, ['completed', 'failed', 'outcome_uncertain']);
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Published' })).toBeVisible();
  expect(
    (
      await sql<
        { n: number }[]
      >`select count(*)::int as n from wb_fixture_docs where idempotency_key like ${`tw:${id}:%`}`
    )[0]?.n,
  ).toBe(1);
  await page.getByRole('link', { name: 'Open the document' }).click();
});
