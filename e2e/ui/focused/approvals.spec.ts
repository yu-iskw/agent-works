import { expect, test } from '@playwright/test';

import { db } from '../../m1/helpers.js';
import {
  apiPost,
  approvalsOf,
  endsWith,
  expireApproval,
  fixtureDocsOf,
  inboxOf,
  seedNextRevision,
  seedResultTask,
  signInLocal,
  taskRow,
} from '../helpers.js';

import type { SeededResult } from '../helpers.js';
import type { Locator, Page } from '@playwright/test';

// Publication of a result through the fixture document store: request, deny, approve once, and
// the two ways an approval goes invalid. Results are seeded rows, so no model is called; the
// approval, the action and the document row are the segment's own.

const ACCOUNT = 'alice@local.test (fixture Docs)';

const resultUrl = (s: SeededResult, revision = 1) =>
  `/s/alpha/teammates/${s.teammateId}/tasks/${s.taskId}/results/${revision}`;
const approvalCard = (page: Page, taskId: string): Locator =>
  page.locator(`li.card[data-kind="approval"][id^="card:${taskId}:"]`);
const publishButton = (page: Page): Locator =>
  page.getByRole('button', { name: 'Publish to demo document store' });
const reviewPanel = (page: Page): Locator => page.locator('.pn-body');

async function requestPublish(page: Page, s: SeededResult): Promise<string> {
  await page.goto(resultUrl(s));
  await expect(page.getByRole('heading', { level: 2, name: 'Result' })).toBeVisible();
  await expect(publishButton(page)).toBeEnabled();
  await expect(page.locator('#publish-note')).toContainText(
    'Nothing is written until you review and approve it',
  );
  await expect(page.locator('#publish-note')).toContainText('demo only');
  await publishButton(page).click();
  await expect(page.getByRole('heading', { level: 2, name: 'Review action' })).toBeVisible();
  const [approval] = (await approvalsOf('alpha', s.taskId)).filter((a) => a.state === 'pending');
  if (approval === undefined) throw new Error('no pending approval was prepared');
  await expect(page).toHaveURL(endsWith(`/approvals/${approval.id}`));
  return approval.id;
}

test.describe('publication approvals', () => {
  test.beforeEach(async ({ page }) => {
    await signInLocal(page, 'alice@local.test');
  });

  test('a result is published only through one reviewed approval: deny writes nothing, approve once writes the reviewed content', async ({
    page,
  }) => {
    const s = await seedResultTask('alpha', '');
    const first = await requestPublish(page, s);
    const panel = reviewPanel(page);
    await expect(panel).toContainText(ACCOUNT);
    await expect(panel).toContainText('fixture, no live Google Docs write');
    await expect(panel).toContainText('Demo action');
    await expect(panel.locator('.facts')).toContainText('1 (latest)');
    const preview = page.getByRole('region', { name: 'Content preview, revision 1' });
    await expect(preview).toContainText('Seeded result for a publish check');
    await expect(panel).toContainText('Pending your approval');
    expect(await inboxOf('alpha', s.taskId)).toContainEqual({
      kind: 'approval',
      ref: `approval:${first}`,
      state: 'open',
    });
    expect(await fixtureDocsOf('alpha', s.taskId)).toEqual([]);

    await page.getByRole('button', { name: 'Close panel' }).click();
    const card = approvalCard(page, s.taskId);
    await expect(card).toBeVisible();
    await expect(card).toContainText('Pending your approval');
    await expect(card).toContainText(ACCOUNT);
    await expect(card.locator('.card-facts')).toContainText('1');
    await card.getByRole('button', { name: 'Review action' }).click();
    await expect(page).toHaveURL(endsWith(`/approvals/${first}`));
    await page.getByRole('button', { name: 'Deny' }).click();
    await expect(panel).toContainText('Denied. No document was created.');
    await expect(page.getByRole('button', { name: 'Approve once' })).toHaveCount(0);
    await expect.poll(async () => (await taskRow('alpha', s.taskId)).status).toBe('ready');
    expect((await approvalsOf('alpha', s.taskId)).map((a) => [a.id, a.state])).toEqual([
      [first, 'rejected'],
    ]);
    expect(await fixtureDocsOf('alpha', s.taskId)).toEqual([]);
    expect(await inboxOf('alpha', s.taskId)).toContainEqual({
      kind: 'approval',
      ref: `approval:${first}`,
      state: 'resolved',
    });
    await page.getByRole('button', { name: 'Close panel' }).click();
    await expect(card).toContainText('Already decided');

    const second = await requestPublish(page, s);
    expect(second).not.toBe(first);
    await page.getByRole('button', { name: 'Approve once' }).click();
    await expect(panel).toContainText('Document created.', { timeout: 60_000 });
    await expect.poll(async () => (await taskRow('alpha', s.taskId)).status).toBe('completed');
    const approvals = await approvalsOf('alpha', s.taskId);
    const approved = approvals.find((a) => a.id === second);
    expect(approved?.state).toBe('approved');
    expect(approved?.actionStatus).toBe('succeeded');
    const docs = await fixtureDocsOf('alpha', s.taskId);
    expect(docs).toHaveLength(1);
    expect(docs[0]?.docId).toBe(approved?.externalId);
    const [reviewed] = await db('alpha')<{ markdown: string }[]>`
      select document->>'markdown' as markdown from wb_approvals where id = ${second}`;
    expect(docs[0]?.markdown).toBe(reviewed?.markdown);
    expect(docs[0]?.markdown).toContain('Seeded result for a publish check');
    const open = page.getByRole('link', { name: 'Open the document' });
    await expect(open).toBeVisible();
    await expect(open).toHaveAttribute('href', /\/s\/alpha\/fixture-docs\/fxdoc-[0-9a-f]{16}$/);
    const inbox = await inboxOf('alpha', s.taskId);
    expect(inbox.filter((i) => i.kind === 'approval').every((i) => i.state === 'resolved')).toBe(
      true,
    );
    await page.getByRole('button', { name: 'Close panel' }).click();
    await expect(approvalCard(page, s.taskId).last()).toContainText('Already decided');
    await page.goto(resultUrl(s));
    await expect(page.locator('.rp-meta')).toContainText('Published to');
    await expect(publishButton(page)).toBeDisabled();
    await expect(page.locator('#publish-note')).toContainText('already published');
  });

  test('an approval for an earlier revision is visibly invalid and the segment refuses it', async ({
    page,
  }) => {
    const s = await seedResultTask('alpha', '');
    const approvalId = await requestPublish(page, s);
    const [pending] = await approvalsOf('alpha', s.taskId);
    const next = await seedNextRevision('alpha', s.taskId);
    await page.reload();
    const panel = reviewPanel(page);
    await expect(panel).toContainText(`Revision ${next} replaced revision 1`);
    await expect(panel.locator('.facts')).toContainText(`1 (latest is ${next})`);
    await expect(page.getByRole('button', { name: 'Approve once' })).toBeDisabled();
    await expect(page.getByRole('button', { name: 'Deny' })).toBeDisabled();
    await page.getByRole('button', { name: 'Close panel' }).click();
    const card = approvalCard(page, s.taskId);
    await expect(card).toContainText('A newer revision exists; this approval cannot write it');
    await expect(card.locator('.card-facts')).toContainText(`1 (latest is ${next})`);

    const refused = await apiPost(page, `/api/s/alpha/tasks/${s.taskId}/action`, {
      approvalId,
      expectedDigest: pending?.digest ?? '',
      decision: 'approve',
    });
    expect(refused.status()).toBe(409);
    expect(((await refused.json()) as { error: string }).error).toBe('stale_revision');
    expect((await approvalsOf('alpha', s.taskId)).map((a) => a.state)).toEqual(['void']);
    expect(await fixtureDocsOf('alpha', s.taskId)).toEqual([]);
    await expect.poll(async () => (await taskRow('alpha', s.taskId)).status).toBe('ready');
    await page.goto(resultUrl(s, next));
    await expect(publishButton(page)).toBeEnabled();
    await page.goto(resultUrl(s, 1));
    await expect(publishButton(page)).toHaveCount(0);
    await expect(page.getByText(`You are reading revision 1 of ${next}`)).toBeVisible();
  });

  test('an expired approval cannot approve and the segment voids it', async ({ page }) => {
    const s = await seedResultTask('alpha', '');
    const approvalId = await requestPublish(page, s);
    const [pending] = await approvalsOf('alpha', s.taskId);
    await expireApproval('alpha', approvalId);
    await page.reload();
    await expect(reviewPanel(page)).toContainText('This approval expired before a decision');
    await expect(page.getByRole('button', { name: 'Approve once' })).toBeDisabled();
    await page.getByRole('button', { name: 'Close panel' }).click();
    await expect(approvalCard(page, s.taskId)).toContainText('Expired before a decision');
    const refused = await apiPost(page, `/api/s/alpha/tasks/${s.taskId}/action`, {
      approvalId,
      expectedDigest: pending?.digest ?? '',
      decision: 'approve',
    });
    expect(refused.status()).toBe(409);
    expect(((await refused.json()) as { error: string }).error).toBe('approval_expired');
    expect((await approvalsOf('alpha', s.taskId)).map((a) => a.state)).toEqual(['void']);
    expect(await fixtureDocsOf('alpha', s.taskId)).toEqual([]);
  });
});
