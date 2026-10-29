import { expect, test } from '@playwright/test';

import {
  FLAGSHIP,
  SCREENSHOTS,
  approve,
  captureElement,
  csrfFrom,
  fixtureDocCount,
  signIn,
  taskCount,
  startTask,
  taskIdOf,
  trackConsoleErrors,
  waitForStatus,
  fullShot,
} from '../helpers.js';

test.beforeEach(async ({ page }) => {
  await signIn(page);
});

test('stack is healthy and the app opens without console errors', async ({ page, request }) => {
  for (const url of [
    'http://fake-iap:8080/healthz',
    'http://web:8080/healthz',
    'http://api:8080/healthz',
  ]) {
    expect((await request.get(url)).status(), url).toBe(200);
  }
  const errors = trackConsoleErrors(page);
  await page.goto('/');
  await expect(page.getByRole('main')).toBeVisible();
  await expect(page.getByText('Simulated Workspace').first()).toBeVisible();
  await expect(page.getByText(/STUB MODEL/).first()).toBeVisible();
  const response = await page.request.get('/');
  expect(response.headers()['content-security-policy']).toContain("script-src 'self'");
  expect(errors).toEqual([]);
});

test('creates a task from the keyboard with validation and one submission', async ({ page }) => {
  await page.goto('/');
  const field = page.getByRole('textbox', { name: 'Objective' });
  await field.focus();
  await field.press('Control+Enter');
  await expect(field).toHaveAttribute('aria-invalid', 'true');
  await expect(page).toHaveURL(/\/$/);
  await field.fill(FLAGSHIP);
  const before = await taskCount('alice');
  await expect(page.getByRole('button', { name: 'Start task' })).toBeEnabled();
  await page.evaluate(() => {
    const form = document.querySelector<HTMLFormElement>('form[data-composer]');
    form?.requestSubmit();
    form?.requestSubmit();
  });
  await page.waitForURL(/\/tasks\//);
  await waitForStatus(page, 'waiting_approval');
  expect(await taskCount('alice')).toBe(before + 1);
});

test('server rejects an empty objective with a field error', async ({ page }) => {
  await page.goto('/');
  await page.evaluate(() => {
    const form = document.querySelector<HTMLFormElement>('form[data-composer]');
    const field = form?.querySelector('textarea');
    if (field) field.value = '   ';
    HTMLFormElement.prototype.submit.call(form);
  });
  await expect(page.getByRole('alert')).toContainText('Enter an objective');
  await expect(page.getByRole('textbox', { name: 'Objective' })).toHaveAttribute(
    'aria-invalid',
    'true',
  );
});

test('shows real progress, evidence, draft and a contextual approval', async ({ page }) => {
  const id = await startTask(page, `${FLAGSHIP} [stub:slow]`);
  await expect(page.locator('#task-live')).toHaveAttribute('data-poll', 'true');
  await expect(page.locator('[data-progress]')).toBeVisible();
  await expect(page.getByLabel('Draft report loading')).toBeVisible();
  await fullShot(page, `${SCREENSHOTS}/02-task-running-1440.png`);
  await waitForStatus(page, 'waiting_approval');
  const events = await page
    .locator('[data-event]')
    .evaluateAll((items) => items.map((item) => item.getAttribute('data-event')));
  expect(events).toEqual([
    'task.created',
    'task.started',
    'retrieval.started',
    'retrieval.completed',
    'evidence.recorded',
    'model.requested',
    'model.completed',
    'citations.validated',
    'draft.created',
    'approval.requested',
  ]);
  await expect(page.locator('[data-evidence]')).toHaveCount(5);
  await page.locator('#evidence').scrollIntoViewIfNeeded();
  await fullShot(page, `${SCREENSHOTS}/03-evidence-1440.png`);
  const approval = page.locator('#approval');
  for (const text of [
    'Create 1 Google Doc',
    'Simulated Google Docs (fixture adapter)',
    'alice@example.test',
    'drive.file',
    'Incident review (stub model output)',
    'No real Google Workspace write',
  ]) {
    await expect(approval).toContainText(text);
  }
  await expect(approval.locator('.preview')).toContainText('Recurring causes');
  await fullShot(page, `${SCREENSHOTS}/04-approval-pending-1440.png`);
  await captureElement(page, '#report', `${SCREENSHOTS}/05-report-draft-1440.png`);
  expect(await fixtureDocCount(id)).toBe(0);
});

test('citations match recorded evidence and the exported record', async ({ page }) => {
  await startTask(page, FLAGSHIP);
  await waitForStatus(page, 'waiting_approval');
  const evidenceIds = await page
    .locator('[data-evidence]')
    .evaluateAll((items) => items.map((item) => item.getAttribute('data-evidence')));
  const citeTargets = await page
    .locator('a.cite')
    .evaluateAll((links) => links.map((link) => link.getAttribute('href')));
  expect(citeTargets.length).toBeGreaterThan(0);
  for (const target of citeTargets) expect(evidenceIds.map((id) => `#ev-${id}`)).toContain(target);
  for (const link of await page.locator('[data-source-link]').all()) {
    expect(await link.getAttribute('href')).toMatch(/^\/fixtures\/drive\/[a-z0-9-]+$/);
  }
  const markdown = await (await page.request.get(`${page.url()}/report.md`)).text();
  for (const id of evidenceIds) expect(markdown).toContain(`- ${id}: `);
  await page.locator('a.cite').first().click();
  await expect(page.locator('.ev:target')).toHaveCount(1);
  await page.locator('[data-source-link]').first().click();
  await expect(page.getByRole('heading', { name: 'Simulated Drive document' })).toBeVisible();
});

test('reject writes nothing; approve writes exactly once and links the result', async ({
  page,
}) => {
  const rejected = await startTask(page, FLAGSHIP);
  await waitForStatus(page, 'waiting_approval');
  await page.getByRole('button', { name: 'Reject' }).click();
  await waitForStatus(page, 'declined');
  await expect(page.locator('[data-decision="rejected"]')).toContainText('This decision is final');
  expect(await fixtureDocCount(rejected)).toBe(0);

  const approved = await startTask(page, FLAGSHIP);
  await waitForStatus(page, 'waiting_approval');
  await approve(page);
  await expect(page.locator('[data-decision="approved"]')).toContainText('alice');
  await expect(page.getByText('Published to Simulated Google Docs')).toBeVisible();
  await fullShot(page, `${SCREENSHOTS}/06-success-1440.png`);
  expect(await fixtureDocCount(approved)).toBe(1);
  await page.locator('[data-result-link]').click();
  await expect(page.getByRole('heading', { name: 'Simulated Google Doc' })).toBeVisible();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(
    'Incident review (stub model output)',
  );
  await fullShot(page, `${SCREENSHOTS}/07-simulated-doc-1440.png`);
});

test('stale and replayed approvals fail safely', async ({ page, browser }) => {
  const id = await startTask(page, FLAGSHIP);
  await waitForStatus(page, 'waiting_approval');
  const second = await browser.newPage({ storageState: await page.context().storageState() });
  await second.goto(page.url());
  await approve(page);
  await second.getByRole('button', { name: 'Reject' }).click();
  await expect(second.getByRole('alert').first()).toContainText('already decided');
  await expect(second.locator('#task-live')).toHaveAttribute('data-status', 'completed');

  const csrf = await csrfFrom(page);
  const replay = await page.request.post(`/tasks/${id}/approval`, {
    form: { csrf, decision: 'approve', expectedPayloadSha256: 'f'.repeat(64) },
    headers: { origin: 'http://fake-iap:8080' },
    maxRedirects: 0,
  });
  expect(replay.status()).toBe(303);
  expect(replay.headers().location).toContain('notice=already_decided');
  expect(await fixtureDocCount(id)).toBe(1);

  const fresh = await startTask(page, FLAGSHIP);
  await waitForStatus(page, 'waiting_approval');
  await page
    .locator('#approval input[name="expectedPayloadSha256"]')
    .first()
    .evaluate((input: HTMLInputElement) => {
      input.value = '0'.repeat(64);
    });
  await page.getByRole('button', { name: 'Approve and create' }).click();
  await expect(page.getByRole('alert').first()).toContainText('proposal changed');
  await expect(page.locator('#task-live')).toHaveAttribute('data-status', 'waiting_approval');
  expect(await fixtureDocCount(fresh)).toBe(0);
  expect(taskIdOf(page)).toBe(fresh);
});

test('cancel stops a running task and a waiting one without writing', async ({ page }) => {
  const running = await startTask(page, `${FLAGSHIP} [stub:slow]`);
  await page.getByRole('button', { name: 'Cancel task' }).click();
  await waitForStatus(page, 'cancelled', 20_000);
  await expect(page.getByRole('heading', { name: 'Task cancelled' })).toBeVisible();
  expect(await fixtureDocCount(running)).toBe(0);

  const waiting = await startTask(page, FLAGSHIP);
  await waitForStatus(page, 'waiting_approval');
  await page.getByRole('button', { name: 'Cancel task' }).click();
  await waitForStatus(page, 'cancelled');
  await expect(page.locator('[data-decision="void"]')).toBeVisible();
  expect(await fixtureDocCount(waiting)).toBe(0);
});

test('history lists only my tasks and survives a refresh', async ({ page }) => {
  const id = await startTask(page, FLAGSHIP);
  await waitForStatus(page, 'waiting_approval');
  await page.reload();
  await waitForStatus(page, 'waiting_approval');
  await expect(page.locator('[data-evidence]')).toHaveCount(5);
  const nav = page.getByRole('navigation', { name: 'Primary' });
  await nav.getByRole('link', { name: 'Tasks' }).click();
  await expect(page.locator(`a[href="/tasks/${id}"]`)).toBeVisible();
  await nav.getByRole('link', { name: /Approvals/ }).click();
  await expect(page.locator(`a[href="/tasks/${id}"]`)).toBeVisible();
});
