import { readFileSync } from 'node:fs';

import { expect, test } from '@playwright/test';

import { db } from '../../m1/helpers.js';
import { campaignCalls, modelCallsOf, taskRow } from '../helpers.js';

import type { RestartState } from './before.spec.js';

// Second half of `pnpm ui:restart`, in the same browser state as before.spec.ts: the interrupted
// task resumes through lease recovery and finishes once, and the conversation and the typed
// draft survive the restart.

const STATE = 'artifacts/ui/restart-state.json';
const STORAGE = 'artifacts/ui/restart-storage.json';

test.use({ storageState: STORAGE });

test('interrupted work resumes once after the restart; conversation and draft survive', async ({
  page,
}) => {
  const state = JSON.parse(readFileSync(STATE, 'utf8')) as RestartState;
  const sql = db('alpha');
  await expect
    .poll(async () => (await taskRow('alpha', state.taskId)).status, {
      timeout: 300_000,
      intervals: [3_000],
    })
    .toMatch(/^(ready|completed|needs_input|failed)$/);
  expect((await taskRow('alpha', state.taskId)).status).toBe('ready');

  const assignments = await sql<{ key: string; status: string; attempt: number }[]>`
    select key, status, attempt from tw_assignments where task_id = ${state.taskId} and status <> 'superseded'
    order by key`;
  expect(assignments.map((a) => a.status)).toEqual(['succeeded', 'succeeded']);
  expect(new Set(assignments.map((a) => a.key)).size, 'no duplicated assignment').toBe(2);
  const [jobs] = await sql<{ n: number }[]>`
    select count(*)::int as n from tw_jobs where task_id = ${state.taskId} and state in ('queued', 'running')`;
  expect(jobs?.n, 'no job left behind').toBe(0);
  const [revisions] = await sql<{ n: number }[]>`
    select count(*)::int as n from tw_revisions where task_id = ${state.taskId}`;
  expect(revisions?.n, 'exactly one result').toBe(1);
  const [evidence] = await sql<{ dupes: number }[]>`
    select count(*)::int as dupes from (
      select source_id, location from wb_evidence where task_id = ${state.taskId}
      group by 1, 2 having count(*) > 1) d`;
  expect(evidence?.dupes, 'no duplicated evidence after resume').toBe(0);
  const [cards] = await sql<{ dupes: number }[]>`
    select count(*)::int as dupes from (
      select card->>'kind', card->>'ref' from tw_messages where task_id = ${state.taskId} and card is not null
      group by 1, 2 having count(*) > 1) d`;
  expect(cards?.dupes, 'no duplicated card').toBe(0);
  const calls = await modelCallsOf('alpha', state.taskId);
  expect(calls.filter((c) => c.purpose === 'synthesis' && c.outcome === 'ok')).toHaveLength(1);
  // Lease recovery: the killed process left its call pending in the ledger and its job leased;
  // the restarted worker reclaimed that job (a second attempt) and the contribution ran once more.
  const contributions = calls.filter((c) => c.purpose === 'contribution');
  expect(contributions.filter((c) => c.outcome === 'ok')).toHaveLength(2);
  expect(
    contributions.filter((c) => c.outcome !== 'ok').length,
    'the interrupted call stayed in the ledger',
  ).toBeGreaterThanOrEqual(1);
  const jobs2 = await sql<{ attempts: number }[]>`
    select attempts from tw_jobs where task_id = ${state.taskId} and kind = 'assignment'`;
  expect(
    jobs2.some((j) => j.attempts >= 2),
    'an assignment job was reclaimed after the restart',
  ).toBe(true);

  await page.goto(`/s/alpha/teammates/${state.teammateId}`);
  const message = page.getByRole('textbox', { name: 'Message' });
  await expect(message).toBeVisible();
  await expect(message, 'the draft typed before the restart').toHaveValue(state.draft);
  await expect(
    page.locator(`li.card[data-kind="result"][id^="card:${state.taskId}:"]`),
  ).toHaveCount(1);
  await expect(page.locator(`li.card[id^="card:${state.taskId}:"]`).first()).toContainText(
    state.title.slice(0, 40),
  );
  const [messages] = await sql<{ n: number }[]>`
    select count(*)::int as n from tw_messages where conversation_id = ${state.conversationId}`;
  expect(messages?.n ?? 0).toBeGreaterThanOrEqual(state.messagesBefore);
  const ids = await page
    .locator('.tl-list > li[id]')
    .evaluateAll((nodes) => nodes.map((n) => n.id));
  expect(new Set(ids).size, 'no duplicated timeline entry').toBe(ids.length);
  expect((await campaignCalls('alpha')) - state.callsBefore).toBeLessThanOrEqual(8);
});
