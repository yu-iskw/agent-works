import { expect, test } from '@playwright/test';

import { db } from '../../m1/helpers.js';
import { apiPost, signOut } from '../helpers.js';
import { JOURNEYS, runToResult } from '../journeys/steps.js';

import type { Member } from '../helpers.js';

// Prepares what usability tasks 4 and 5 (docs/ui/UX_REVIEW.md) need in a reviewer's workspace, with
// real Gemini: an open publication approval in alpha, and finished no-show work in beta. Each part
// is skipped when the reviewer already has it, so a rerun spends nothing.

const member = process.env.SEED_MEMBER as Member;
const sub = `local-test:${member.split('@')[0]}`;

async function openApproval(): Promise<string | undefined> {
  const [row] = await db('alpha')<{ id: string }[]>`
    select a.id from wb_approvals a join wb_tasks t on t.id = a.task_id
    where t.owner_sub = ${sub} and a.state = 'pending' and a.expires_at > now() limit 1`;
  return row?.id;
}

async function noShowWork(): Promise<string | undefined> {
  const [row] = await db('beta')<{ id: string }[]>`
    select id from wb_tasks where owner_sub = ${sub} and kind = 'teamwork' and llm_mode = 'vertex'
      and objective = ${JOURNEYS[5].objective} and latest_revision >= 1 limit 1`;
  return row?.id;
}

test.describe.configure({ mode: 'serial', timeout: 900_000 });

test('an open publication approval waits in the alpha inbox', async ({ page }) => {
  if ((await openApproval()) !== undefined) return;
  const { task } = await runToResult(page, { ...JOURNEYS[1], n: 0, member });
  const [row] = await db('alpha')<{ latest_revision: number }[]>`
    select latest_revision from wb_tasks where id = ${task.id}`;
  const reply = await apiPost(page, `/api/s/alpha/tasks/${task.id}/publish`, {
    revision: row?.latest_revision,
  });
  expect(reply.status()).toBe(200);
  expect(await openApproval()).toBeDefined();
  await signOut(page);
});

test('finished work about no-shows is in beta', async ({ page }) => {
  if ((await noShowWork()) !== undefined) return;
  await runToResult(page, { ...JOURNEYS[5], n: 0, member });
  expect(await noShowWork()).toBeDefined();
  await signOut(page);
});
