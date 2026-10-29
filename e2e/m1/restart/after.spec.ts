import { readFileSync } from 'node:fs';

import { expect, test } from '@playwright/test';

import { db, signInLocal, waitForStatus } from '../helpers.js';

test('work interrupted by a killed worker and a full restart finishes once, with nothing lost', async ({
  page,
}) => {
  const { taskId } = JSON.parse(readFileSync('artifacts/m1/restart-state.json', 'utf8')) as {
    taskId: string;
  };
  await signInLocal(page);
  const status = await waitForStatus(
    page,
    'alpha',
    taskId,
    ['ready', 'needs_input', 'failed'],
    300_000,
  );
  expect(status).toBe('ready');
  const sql = db('alpha');
  const assignments = await sql<
    { status: string }[]
  >`select status from tw_assignments where task_id = ${taskId}`;
  expect(assignments.map((a) => a.status)).toEqual(['succeeded', 'succeeded']);
  const live = await sql<
    { n: number }[]
  >`select count(*)::int as n from tw_jobs where task_id = ${taskId} and state in ('queued', 'running')`;
  expect(live[0]?.n, 'no job left behind').toBe(0);
  const revisions = await sql<
    { n: number }[]
  >`select count(*)::int as n from tw_revisions where task_id = ${taskId}`;
  expect(revisions[0]?.n, 'exactly one result').toBe(1);
  const evidence = await sql<{ dupes: number }[]>`
    select count(*)::int as dupes from (select source_id, location from wb_evidence where task_id = ${taskId} group by 1, 2 having count(*) > 1) d`;
  expect(evidence[0]?.dupes, 'no duplicated evidence after resume').toBe(0);
  await page.goto(`/s/alpha/tasks/${taskId}`);
  await expect(page.getByText(/Result · revision 1 of 1/)).toBeVisible();
  await page.goto('/s/alpha/inbox');
  await expect(page.getByRole('link', { name: /Restart probe/ }).first()).toBeVisible();
});
