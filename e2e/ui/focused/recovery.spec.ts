import { expect, test } from '@playwright/test';

import { db } from '../../m1/helpers.js';
import {
  apiPost,
  approvalsOf,
  campaignCalls,
  cloneStoppedTask,
  coordinator,
  endsWith,
  fixtureDocsOf,
  inboxOf,
  modelCallsOf,
  seedResultTask,
  signInLocal,
  stoppedTask,
  taskRow,
} from '../helpers.js';

import type { SeededResult, Segment } from '../helpers.js';
import type { Locator, Page } from '@playwright/test';

// Honest recovery: an uncertain publish is reconciled, a failed publish is retried and stays
// failed, a question is answered from the inbox, a partial failure proceeds with what finished,
// and a cancellation stops further work. The publish cases are seeded and free; answering,
// proceeding and the cancelled task run real work (about five calls across both segments).

const EXECUTION_MS = 480_000;
const card = (page: Page, taskId: string, kind: string): Locator =>
  page.locator(`li.card[data-kind="${kind}"][id^="card:${taskId}:"]`);
const panel = (page: Page): Locator => page.locator('.pn-body');

async function approveSeeded(page: Page, s: SeededResult): Promise<string> {
  await page.goto(`/s/alpha/teammates/${s.teammateId}/tasks/${s.taskId}/results/1`);
  await expect(page.getByRole('heading', { level: 2, name: 'Result' })).toBeVisible();
  const prepared = await apiPost(page, `/api/s/alpha/tasks/${s.taskId}/publish`, { revision: 1 });
  expect(prepared.status()).toBe(200);
  const [approval] = (await approvalsOf('alpha', s.taskId)).filter((a) => a.state === 'pending');
  if (approval === undefined) throw new Error('no pending approval');
  await page.goto(`/s/alpha/teammates/${s.teammateId}/tasks/${s.taskId}/approvals/${approval.id}`);
  await page.getByRole('button', { name: 'Approve once' }).click();
  return approval.id;
}

async function waitForStatus(
  segment: Segment,
  taskId: string,
  wanted: readonly string[],
  timeout = 60_000,
): Promise<string> {
  await expect
    .poll(async () => wanted.includes((await taskRow(segment, taskId)).status), {
      timeout,
      intervals: [2_000],
    })
    .toBe(true);
  return (await taskRow(segment, taskId)).status;
}

test.describe('publish outcomes', () => {
  test.beforeEach(async ({ page }) => {
    await signInLocal(page, 'alice@local.test');
  });

  test('an unconfirmed write is reconciled to the one document that exists', async ({ page }) => {
    const s = await seedResultTask('alpha', '[fault:publish-uncertain]');
    await approveSeeded(page, s);
    await waitForStatus('alpha', s.taskId, ['outcome_uncertain']);
    await expect(panel(page)).toContainText('The document store did not confirm the write.');
    await expect(panel(page)).toContainText('A document may exist. Reconcile first');
    await page.getByRole('button', { name: 'Close panel' }).click();
    const failure = card(page, s.taskId, 'failure');
    await expect(failure).toContainText('Outcome uncertain');
    await expect(failure).not.toContainText('Resolved');
    await expect(failure.getByRole('button', { name: 'Reconcile' })).toBeVisible();
    expect(await inboxOf('alpha', s.taskId)).toContainEqual(
      expect.objectContaining({ kind: 'uncertain', state: 'open' }),
    );
    const before = await fixtureDocsOf('alpha', s.taskId);
    expect(before, 'the fixture store holds the write that lost its confirmation').toHaveLength(1);

    await failure.getByRole('button', { name: 'Reconcile' }).click();
    await waitForStatus('alpha', s.taskId, ['completed']);
    await expect(failure).toContainText('Resolved');
    const [approval] = await approvalsOf('alpha', s.taskId);
    expect(approval?.actionStatus).toBe('succeeded');
    expect(approval?.externalId).toBe(before[0]?.docId);
    expect(await fixtureDocsOf('alpha', s.taskId), 'no second copy').toHaveLength(1);
    // What stays open is the result notification; the uncertainty itself is resolved.
    expect(
      (await inboxOf('alpha', s.taskId)).filter((i) => i.state === 'open').map((i) => i.kind),
    ).toEqual(['completed']);
    const [event] = await db('alpha')<{ summary: string }[]>`
      select summary from wb_events where task_id = ${s.taskId} and type = 'action.reconciled'`;
    expect(event?.summary).toContain('Found the document from the earlier attempt');
  });

  test('a refused write fails honestly, can be retried, and never leaves a document behind', async ({
    page,
  }) => {
    const s = await seedResultTask('alpha', '[fault:publish-fail]');
    await approveSeeded(page, s);
    await waitForStatus('alpha', s.taskId, ['failed']);
    await expect(panel(page)).toContainText('Creating the document failed.');
    await expect(panel(page).getByRole('button', { name: 'Retry publishing' })).toBeVisible();
    await page.getByRole('button', { name: 'Close panel' }).click();
    const failure = card(page, s.taskId, 'failure').last();
    await expect(failure).toContainText('Publishing failed');
    await expect(failure).not.toContainText('Resolved');
    expect(await fixtureDocsOf('alpha', s.taskId)).toEqual([]);

    await failure.getByRole('button', { name: 'Retry' }).click();
    const events = () =>
      db('alpha')<{ type: string; summary: string }[]>`
        select type, summary from wb_events where task_id = ${s.taskId} order by seq`;
    await expect
      .poll(async () => (await events()).filter((e) => e.type === 'task.failed').length, {
        timeout: 60_000,
      })
      .toBe(2);
    await waitForStatus('alpha', s.taskId, ['failed']);
    expect((await events()).filter((e) => e.type === 'task.retried')).toHaveLength(1);
    expect(await fixtureDocsOf('alpha', s.taskId)).toEqual([]);
    const [approval] = await approvalsOf('alpha', s.taskId);
    expect(approval?.actionStatus).toBe('failed');
    await expect(card(page, s.taskId, 'failure').last()).toContainText('Publishing failed');
    await expect(card(page, s.taskId, 'failure').last()).not.toContainText('Resolved');
    // Giving up is a decision too: cancelling the failed task resolves its cards and inbox item.
    await card(page, s.taskId, 'failure').last().getByRole('button', { name: 'Open task' }).click();
    await panel(page).getByRole('button', { name: 'Cancel task' }).click();
    await panel(page).getByRole('button', { name: 'Yes, cancel it' }).click();
    await waitForStatus('alpha', s.taskId, ['cancelled']);
    await expect(panel(page)).toContainText('Cancelled');
    expect((await inboxOf('alpha', s.taskId)).filter((i) => i.state === 'open')).toEqual([]);
    await page.getByRole('button', { name: 'Close panel' }).click();
    await expect(card(page, s.taskId, 'failure').last()).toContainText('Resolved');
    expect(await fixtureDocsOf('alpha', s.taskId)).toEqual([]);
  });
});

test.describe('questions and partial failure', () => {
  test('a question answered from the inbox requeues the assignment and resolves everywhere', async ({
    page,
  }) => {
    test.setTimeout(EXECUTION_MS + 120_000);
    const source = await stoppedTask('beta', 'question');
    if (source === undefined) throw new Error('beta has no task waiting on a question to copy');
    const t = await cloneStoppedTask('beta', source);
    const [asked] = await db('beta')<{ id: string; question: string }[]>`
      select id, question from tw_assignments where task_id = ${t.taskId} and status = 'needs_input'`;
    if (asked === undefined) throw new Error('the copy has no open question');
    const calls = await campaignCalls('beta');
    await signInLocal(page, 'alice@local.test');
    await page.goto(`/s/beta/teammates/${t.teammateId}/inbox`);
    const item = page
      .getByRole('region', { name: 'Needs your decision' })
      .locator(`button.row[data-task="${t.taskId}"]`);
    await expect(item).toBeVisible();
    await expect(item).toContainText('Answer question');
    await item.click();
    await expect(page).toHaveURL(endsWith(`/tasks/${t.taskId}`));
    await expect(page.getByRole('heading', { level: 2, name: 'Task', exact: true })).toBeVisible();
    await expect(panel(page)).toContainText(`Asked: ${asked.question.slice(0, 40)}`);
    await panel(page)
      .getByLabel('Your answer')
      .fill('Use the IETF RateLimit-* headers and say so in the proposal.');
    await panel(page).getByRole('button', { name: 'Send answer' }).click();

    await expect
      .poll(
        async () =>
          (
            await db('beta')<{ status: string }[]>`
              select status from tw_assignments where id = ${asked.id}`
          )[0]?.status,
      )
      .toMatch(/^(queued|running|succeeded)$/);
    expect(await inboxOf('beta', t.taskId)).toContainEqual(
      expect.objectContaining({ kind: 'question', state: 'resolved' }),
    );
    await expect(panel(page)).not.toContainText('Asked:');
    await page.getByRole('button', { name: 'Close panel' }).click();
    await expect(card(page, t.taskId, 'question')).toContainText('Answered');
    await page.getByRole('button', { name: /^Inbox/ }).click();
    await expect(page.locator(`button.row[data-task="${t.taskId}"]`)).toHaveCount(0);

    const status = await waitForStatus(
      'beta',
      t.taskId,
      ['ready', 'completed', 'failed'],
      EXECUTION_MS,
    );
    expect(status, 'the answered assignment finished and the result was written').toBe('ready');
    const [answered] = await db('beta')<{ status: string; answer: string | null }[]>`
      select status, answer from tw_assignments where id = ${asked.id}`;
    expect(answered?.status).toBe('succeeded');
    expect(answered?.answer).toContain('IETF RateLimit');
    const purposes = (await modelCallsOf('beta', t.taskId)).map((c) => c.purpose);
    expect(purposes).toContain('contribution');
    expect(purposes).toContain('synthesis');
    expect((await campaignCalls('beta')) - calls).toBeLessThanOrEqual(4);
  });

  test('a failed contribution is shown honestly and proceeding states the gap in the result', async ({
    page,
  }) => {
    test.setTimeout(EXECUTION_MS + 120_000);
    const source = await stoppedTask('beta', 'missing');
    if (source === undefined) throw new Error('beta has no task with a failed contribution');
    const t = await cloneStoppedTask('beta', source);
    const [missing] = await db('beta')<{ id: string; key: string; error_code: string | null }[]>`
      select id, key, error_code from tw_assignments where task_id = ${t.taskId} and status = 'failed'`;
    if (missing === undefined) throw new Error('the copy has no failed contribution');
    const calls = await campaignCalls('beta');
    await signInLocal(page, 'alice@local.test');
    await page.goto(`/s/beta/teammates/${t.teammateId}/tasks/${t.taskId}`);
    const failed = panel(page).locator('.asg', { hasText: missing.key.split('-')[0] ?? '' });
    await expect(panel(page)).toContainText('Needs your input');
    await expect(panel(page).locator('.asg .chip', { hasText: 'Failed' })).toHaveCount(1);
    await expect(panel(page)).toContainText('1 contribution did not finish');
    expect(failed).toBeDefined();
    await panel(page).getByRole('button', { name: 'Proceed with what finished' }).click();
    await waitForStatus('beta', t.taskId, ['synthesizing', 'ready', 'failed']);
    const [event] = await db('beta')<{ summary: string }[]>`
      select summary from wb_events where task_id = ${t.taskId} and type = 'task.proceed_partial'`;
    expect(event?.summary).toContain(missing.key);
    expect(await inboxOf('beta', t.taskId)).toContainEqual(
      expect.objectContaining({ kind: 'question', state: 'resolved' }),
    );
    const status = await waitForStatus(
      'beta',
      t.taskId,
      ['ready', 'completed', 'failed'],
      EXECUTION_MS,
    );
    expect(status).toBe('ready');
    const [revision] = await db('beta')<{ missing_assignments: string[] }[]>`
      select missing_assignments from tw_revisions where task_id = ${t.taskId} and revision = 1`;
    expect(revision?.missing_assignments).toHaveLength(1);
    expect(revision?.missing_assignments[0]).toContain(missing.key);
    await page.goto(`/s/beta/teammates/${t.teammateId}/tasks/${t.taskId}/results/1`);
    const limits = page.locator('.result-limits');
    await expect(limits).toContainText('Limitations and uncertainties');
    await expect(limits).toContainText(`Contribution ${missing.key}`);
    await expect(limits).toContainText('did not finish and is not reflected here.');
    await page.getByRole('button', { name: 'Close panel' }).click();
    await expect(card(page, t.taskId, 'failure').first()).toContainText('Resolved');
    expect((await campaignCalls('beta')) - calls).toBeLessThanOrEqual(2);
  });
});

test.describe('cancellation', () => {
  test('cancelling from the task panel stops further work and no model call starts after it', async ({
    page,
  }) => {
    test.setTimeout(300_000);
    const owner = await coordinator('alpha');
    const objective = `Cancel probe ${Date.now()}: which feature-flag service has the best SLA?`;
    await signInLocal(page, 'alice@local.test');
    await page.goto(`/s/alpha/teammates/${owner.id}`);
    const message = page.getByRole('textbox', { name: 'Message' });
    await message.fill(objective);
    await page.getByRole('button', { name: 'Add to the message' }).click();
    await page.getByRole('option', { name: /Create task/ }).click();
    const draft = page.locator('.card[data-kind="task_draft"]');
    await expect(draft).toBeVisible();
    await draft.getByLabel('Workflow').selectOption('research_brief');
    await draft.getByRole('button', { name: 'Add specialist' }).click();
    await page
      .getByRole('list', { name: 'Teammates to add' })
      .getByRole('button')
      .filter({ hasText: 'Research analyst' })
      .first()
      .click();
    await expect(draft.locator('#td-problems')).toHaveCount(0);
    await draft.getByRole('button', { name: 'Start' }).click();
    await expect(draft).toBeHidden();
    const rows = () =>
      db('alpha')<{ id: string }[]>`
        select id from wb_tasks where owner_sub = 'local-test:alice' and objective = ${objective}`;
    await expect.poll(async () => (await rows()).length, { timeout: 30_000 }).toBe(1);
    const taskId = (await rows())[0]?.id ?? '';
    await expect
      .poll(async () => (await modelCallsOf('alpha', taskId)).length, { timeout: 90_000 })
      .toBeGreaterThan(0);

    const running = card(page, taskId, 'running');
    await expect(running).toBeVisible();
    await running.getByRole('button', { name: 'Open task' }).click();
    await expect(page.getByRole('heading', { level: 2, name: 'Task', exact: true })).toBeVisible();
    await panel(page).getByRole('button', { name: 'Cancel task' }).click();
    await expect(panel(page)).toContainText('Stop this task? Nothing more runs');
    await panel(page).getByRole('button', { name: 'Yes, cancel it' }).click();
    const requestedAt = () =>
      db('alpha')<{ at: Date }[]>`
        select at from wb_events where task_id = ${taskId} and type = 'task.cancel_requested'`;
    await expect.poll(async () => (await requestedAt()).length).toBe(1);
    const [requested] = await requestedAt();
    const status = await waitForStatus('alpha', taskId, ['cancelled'], 180_000);
    expect(status).toBe('cancelled');
    await expect(panel(page)).toContainText('Cancelled');
    const calls = await modelCallsOf('alpha', taskId);
    expect(
      calls.filter((c) => c.at.getTime() > (requested?.at.getTime() ?? 0)),
      'no model call started after the cancellation',
    ).toEqual([]);
    expect(calls.map((c) => c.purpose)).not.toContain('synthesis');
    const [live] = await db('alpha')<{ n: number }[]>`
      select count(*)::int as n from tw_jobs where task_id = ${taskId} and state in ('queued', 'running')`;
    expect(live?.n).toBe(0);
    expect(
      (
        await db('alpha')<{ latest_revision: number }[]>`
        select latest_revision from wb_tasks where id = ${taskId}`
      )[0]?.latest_revision,
    ).toBe(0);
    await page.getByRole('button', { name: 'Close panel' }).click();
    await expect(running).toContainText('Cancelled');
    await expect(running).toContainText('Nothing more will run');
  });
});
