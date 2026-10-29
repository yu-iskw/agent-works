import { readFileSync } from 'node:fs';

import { expect } from '@playwright/test';

import { db, taskIdFrom, waitForStatus } from '../helpers.js';

import type { Page } from '@playwright/test';

export type Segment = 'alpha' | 'beta';

/** Member emails come from the stack itself (gated like the session endpoint), never from a file in the repo. */
export async function liveMembers(): Promise<Record<Segment, readonly string[]>> {
  const secret = readFileSync('/run/aw-m1/e2e-session.secret', 'utf8').trim();
  const response = await fetch(
    `${process.env.M1_INTERNAL_URL ?? 'http://web:8081'}/internal/e2e/members`,
    { headers: { 'x-e2e-secret': secret } },
  );
  if (!response.ok) throw new Error(`live members unavailable: ${response.status}`);
  return (await response.json()) as Record<Segment, readonly string[]>;
}

export function manifest<T>(name: string): T {
  // eslint-disable-next-line security/detect-non-literal-fs-filename
  return JSON.parse(readFileSync(`fixtures/m1/expected/${name}.json`, 'utf8')) as T;
}

export type AssignmentSpec = { readonly teammate: string; readonly brief: string };

/** Starts a task from the UI; manual mode fills specialist rows, coordinated mode approves the real plan. */
export async function startTask(
  page: Page,
  segment: Segment,
  input: {
    readonly workflow: string;
    readonly question: string;
    readonly mode: 'manual' | 'coordinated';
    readonly assignments?: readonly AssignmentSpec[];
    readonly fill?: (page: Page) => Promise<void>;
  },
): Promise<string> {
  await page.goto(`/s/${segment}/tasks/new?workflow=${input.workflow}`);
  await page.getByLabel('What do you need?').fill(input.question);
  await input.fill?.(page);
  if (input.mode === 'coordinated')
    await page.getByRole('radio', { name: /Coordinator proposes a plan/ }).check();
  else
    for (const [index, assignment] of (input.assignments ?? []).entries()) {
      await chooseTeammate(page, index, assignment.teammate);
      await page.getByLabel('Assignment').nth(index).fill(assignment.brief);
    }
  await page.getByRole('button', { name: 'Start task' }).click();
  const id = taskIdFrom(page);
  if (input.mode === 'coordinated') {
    await waitForStatus(page, segment, id, ['plan_review', 'failed'], 240_000);
    await page.reload();
    await expect(page.getByRole('heading', { name: /Review plan version 1/ })).toBeVisible();
    const jobs = await db(segment)<
      { n: number }[]
    >`select count(*)::int as n from tw_jobs where task_id = ${id} and kind = 'assignment'`;
    expect(jobs[0]?.n, 'no dispatch before approval').toBe(0);
    await page.getByRole('button', { name: 'Approve plan v1 and start' }).click();
  }
  return id;
}

export async function chooseTeammate(page: Page, index: number, name: string): Promise<void> {
  const select = page.getByLabel(`Specialist ${index + 1}`);
  const value = await select
    .locator('option', { hasText: `${name} ·` })
    .first()
    .getAttribute('value');
  if (value === null) throw new Error(`no teammate option ${name}`);
  await select.selectOption(value);
}

export async function resultText(page: Page): Promise<string> {
  return (await page.locator('[data-live="result"]').textContent()) ?? '';
}

/** Overlapping execution windows of two assignments, proven from stored timestamps and model calls. */
export async function overlap(
  segment: Segment,
  taskId: string,
): Promise<{ readonly overlapMs: number; readonly calls: number }> {
  const rows = await db(segment)<{ started_at: Date; finished_at: Date }[]>`
    select started_at, finished_at from tw_assignments where task_id = ${taskId} and started_at is not null and finished_at is not null order by started_at
  `;
  let best = 0;
  for (const a of rows)
    for (const b of rows)
      if (a !== b)
        best = Math.max(
          best,
          Math.min(a.finished_at.getTime(), b.finished_at.getTime()) -
            Math.max(a.started_at.getTime(), b.started_at.getTime()),
        );
  const calls = await db(segment)<
    { n: number }[]
  >`select count(*)::int as n from wb_model_calls where task_id = ${taskId} and purpose = 'contribution' and outcome = 'ok'`;
  return { overlapMs: best, calls: calls[0]?.n ?? 0 };
}
