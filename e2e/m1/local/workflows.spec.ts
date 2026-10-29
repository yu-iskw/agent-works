import { expect, test } from '@playwright/test';

import {
  chooseTeammate,
  db,
  ensureStarterTeam,
  expectCalculations,
  shot,
  signInLocal,
  taskIdFrom,
  waitForStatus,
} from '../helpers.js';

// Real model, fixture sources: the metrics and engineering workflows end to end. Fixture runs
// prove the product flow and the deterministic numbers. M1 is mock-only, so these are its M10 evidence.

test('metrics: exact calculations, a regrouped comparison as a new revision', async ({ page }) => {
  test.setTimeout(600_000);
  await signInLocal(page);
  await ensureStarterTeam(page, 'alpha');
  await page.goto('/s/alpha/tasks/new?workflow=metrics_explanation');
  await page
    .getByLabel('What do you need?')
    .fill('Why did signups change between September and October, and what might explain it?');
  await chooseTeammate(page, 0, 'Data analyst');
  await page
    .getByLabel('Assignment')
    .nth(0)
    .fill('Report the largest metric changes with exact values and units.');
  await chooseTeammate(page, 1, 'Business context researcher');
  await page
    .getByLabel('Assignment')
    .nth(1)
    .fill('Find launches or campaigns in the window that could explain the changes.');
  await page.getByRole('button', { name: 'Start task' }).click();
  const id = taskIdFrom(page);
  expect(await waitForStatus(page, 'alpha', id, ['ready', 'needs_input', 'failed'], 420_000)).toBe(
    'ready',
  );
  await expectCalculations('alpha', id, 'region:2026-09->2026-10');
  await page.goto(`/s/alpha/tasks/${id}`);
  await expect(
    page.getByRole('heading', { name: /Calculations \(computed by the workbench/ }),
  ).toBeVisible();
  await page.getByLabel('Group by').last().selectOption('channel');
  await page.getByRole('button', { name: 'Re-run with this comparison' }).click();
  expect(await waitForStatus(page, 'alpha', id, ['ready', 'needs_input', 'failed'], 420_000)).toBe(
    'ready',
  );
  await expectCalculations('alpha', id, 'channel:2026-09->2026-10');
  const revisions = await db('alpha')<
    { revision: number; request: string | null }[]
  >`select revision, request from tw_revisions where task_id = ${id} order by revision`;
  expect(revisions.map((r) => r.revision)).toEqual([1, 2]);
  expect(revisions[1]?.request).toMatch(/by channel/);
  await page.goto(`/s/alpha/tasks/${id}/compare?from=1&to=2`);
  await shot(page, 'local-metrics-compare-1440');
});

test('metrics in beta: exact calculations from the beta fixture data', async ({ page }) => {
  test.setTimeout(600_000);
  await signInLocal(page);
  await ensureStarterTeam(page, 'beta');
  await page.goto('/s/beta/tasks/new?workflow=metrics_explanation');
  await page
    .getByLabel('What do you need?')
    .fill('Why did bookings and no-shows change between September and October?');
  await chooseTeammate(page, 0, 'Data analyst');
  await page
    .getByLabel('Assignment')
    .nth(0)
    .fill('Report the largest metric changes with exact values and units.');
  await chooseTeammate(page, 1, 'Business context researcher');
  await page
    .getByLabel('Assignment')
    .nth(1)
    .fill('Find policy changes or closures in the window that could explain the changes.');
  await page.getByRole('button', { name: 'Start task' }).click();
  const id = taskIdFrom(page);
  expect(await waitForStatus(page, 'beta', id, ['ready', 'needs_input', 'failed'], 420_000)).toBe(
    'ready',
  );
  await expectCalculations('beta', id, 'region:2026-09->2026-10');
});

test('engineering in alpha: one specialist reads the issue and pinned code, the proposal is ready', async ({
  page,
}) => {
  test.setTimeout(600_000);
  await signInLocal(page);
  await ensureStarterTeam(page, 'alpha');
  await page.goto('/s/alpha/tasks/new?workflow=engineering_proposal');
  await page
    .getByLabel('What do you need?')
    .fill('Propose how members could download a finished task report as CSV.');
  await chooseTeammate(page, 0, 'Software engineer');
  await page
    .getByLabel('Assignment')
    .nth(0)
    .fill(
      'Find the code that renders and downloads task reports, and list the files a CSV export would touch. Do not ask questions; state assumptions.',
    );
  await page.getByRole('button', { name: 'Start task' }).click();
  const id = taskIdFrom(page);
  expect(await waitForStatus(page, 'alpha', id, ['ready', 'needs_input', 'failed'], 420_000)).toBe(
    'ready',
  );
  const evidence = await db('alpha')<
    { source_kind: string }[]
  >`select distinct source_kind from wb_evidence where task_id = ${id}`;
  expect(evidence.map((e) => e.source_kind).sort()).toEqual(['github_code', 'github_issue']);
});

test('engineering: reviewed plan, pinned code evidence, a revision, and a refused repository', async ({
  page,
}) => {
  test.setTimeout(600_000);
  await signInLocal(page);
  await ensureStarterTeam(page, 'beta');
  await page.goto('/s/beta/tasks/new?workflow=engineering_proposal');
  await page
    .getByLabel('What do you need?')
    .fill('Propose how to return rate-limit headers from the workbench API.');
  await page.getByRole('radio', { name: /Coordinator proposes a plan/ }).check();
  await page.getByRole('button', { name: 'Start task' }).click();
  const id = taskIdFrom(page);
  expect(await waitForStatus(page, 'beta', id, ['plan_review', 'failed'], 240_000)).toBe(
    'plan_review',
  );
  await page.goto(`/s/beta/tasks/${id}`);
  await page.getByRole('button', { name: 'Approve plan v1 and start' }).click();
  let status = await waitForStatus(page, 'beta', id, ['ready', 'needs_input', 'failed'], 420_000);
  // A specialist may ask before guessing (the fixture issue is only a title). Answer it as a member.
  for (let round = 0; status === 'needs_input' && round < 2; round += 1) {
    await page.goto(`/s/beta/tasks/${id}`);
    const answer = page.getByLabel('Your answer').first();
    await expect(answer, 'a needs_input task shows the question to answer').toBeVisible();
    await answer.fill(
      'Return RateLimit-Limit, RateLimit-Remaining and RateLimit-Reset on every workbench API response, counted per segment.',
    );
    await page
      .getByRole('button', { name: /^Answer / })
      .first()
      .click();
    await expect(page.getByText('Answer sent.')).toBeVisible();
    status = await waitForStatus(page, 'beta', id, ['ready', 'needs_input', 'failed'], 420_000);
  }
  expect(status).toBe('ready');
  const evidence = await db('beta')<
    { source_kind: string }[]
  >`select distinct source_kind from wb_evidence where task_id = ${id}`;
  expect(evidence.map((e) => e.source_kind).sort()).toEqual(['github_code', 'github_issue']);
  const sections = await db('beta')<{ headings: string[]; limitations: string[] }[]>`
    select array(select jsonb_array_elements(content->'sections')->>'heading') as headings,
      array(select jsonb_array_elements_text(content->'limitations')) as limitations
    from tw_revisions where task_id = ${id} and revision = 1`;
  expect(
    sections[0]?.limitations.filter((l) => /required section/.test(l)),
    'every required section produced',
  ).toEqual([]);
  await page.goto(`/s/beta/tasks/${id}`);
  await page
    .getByLabel('Request a revision')
    .fill('Drop the per-member limit and keep only a per-segment limit; explain the trade-off.');
  await page.getByRole('button', { name: 'Request revision' }).click();
  expect(await waitForStatus(page, 'beta', id, ['ready', 'failed'], 300_000)).toBe('ready');
  const revised = await db('beta')<
    { text: string }[]
  >`select content::text as text from tw_revisions where task_id = ${id} and revision = 2`;
  expect(revised[0]?.text.toLowerCase()).toContain('segment');
  expect(revised[0]?.text, 'a proposal never claims work happened').not.toMatch(
    /tests (were|have been) run|I (implemented|changed) the code/i,
  );

  await page.goto('/s/beta/tasks/new?workflow=engineering_proposal');
  await page.getByLabel('What do you need?').fill(`Denial probe ${Date.now()}`);
  await page.getByLabel('Repository').fill('yu-iskw/aw-m1-not-allowlisted');
  await chooseTeammate(page, 0, 'Software engineer');
  await page.getByLabel('Assignment').first().fill('Read the code.');
  await page.getByRole('button', { name: 'Start task' }).click();
  await expect(page.getByText('This segment does not allow that repository.')).toBeVisible();
  await expect(page.getByLabel('What do you need?')).toHaveValue(/Denial probe/);
});

test('the setup check reads every source of the segment with the member connection', async ({
  page,
}) => {
  await signInLocal(page);
  await page.goto('/s/alpha/connections');
  await page.getByRole('button', { name: 'Check sources' }).click();
  await expect(page.locator('.check-list .badge-ok')).toHaveCount(5);
  const calls = await db('alpha')<
    { n: number }[]
  >`select count(*)::int as n from tw_audit where action = 'sources.check'`;
  expect(calls[0]?.n).toBeGreaterThan(0);
});
