import { expect, test } from '@playwright/test';

import { db } from '../../m1/helpers.js';
import { apiPost, captureForBaseline, signInLocal, signOut } from '../helpers.js';
import { JOURNEYS, runJourney } from '../journeys/steps.js';

import type { Page } from '@playwright/test';

// The visual baselines a person approves (gate U18). Everything renders carol's data, and no other
// test signs in as carol, so a later comparison sees the same content. Her reviewed research task
// is real Gemini output, generated once by the journey steps; the running and failed tasks are
// seeded rows (llm_mode 'stub'), labelled as such on the contact sheet. The clock is frozen ten
// minutes after carol's approval was requested, so the approval is still open and relative times
// do not drift. Nothing here writes an approved baseline.

const CAROL = 'local-test:carol';
const SEGMENT = 'alpha';
const WIDTHS = [1440, 768, 375] as const;
const THEMES = ['light', 'dark'] as const;
const SEEDED = 'ui-visual';

type Setup = {
  /** The frozen clock for every capture, derived from persisted data so reruns agree. */
  readonly now: Date;
  readonly coordinator: string;
  readonly researcher: string;
  readonly analyst: string;
  readonly taskId: string;
  readonly latest: number;
  readonly cited: string;
  readonly approvalId: string;
};

const seedId = (kind: number, n: number): string =>
  `cccccccc-5eed-4${String(kind).padStart(3, '0')}-8000-${String(n).padStart(12, '0')}`;

async function teammate(name: string): Promise<{ id: string; conversation_id: string }> {
  const [row] = await db(SEGMENT)<{ id: string; conversation_id: string }[]>`
    select id, conversation_id from tw_teammates
    where owner_sub = ${CAROL} and name = ${name} and not archived order by created_at limit 1`;
  if (row === undefined) throw new Error(`carol has no ${name}`);
  return row;
}

async function reviewedTask(): Promise<{ id: string; latest: number } | undefined> {
  const [row] = await db(SEGMENT)<{ id: string; latest_revision: number }[]>`
    select id, latest_revision from wb_tasks
    where owner_sub = ${CAROL} and kind = 'teamwork' and llm_mode = 'vertex'
      and latest_revision >= 2 and status in ('ready', 'completed', 'awaiting_action_approval')
    order by created_at limit 1`;
  return row === undefined ? undefined : { id: row.id, latest: row.latest_revision };
}

/** A stub-mode task with one assignment working and one queued, so the running card has content. */
async function seedRunning(
  owner: { id: string },
  home: { id: string; conversation_id: string },
  stamp: Date,
) {
  const sql = db(SEGMENT);
  const id = seedId(1, 0);
  const scope = {
    question: 'Compare onboarding drop-off by channel for October 2026.',
    metrics: null,
    repository: null,
    issueNumber: null,
    attachmentIds: [],
  };
  await sql`
    insert into wb_tasks (id, owner_sub, owner_email, client_request_id, title, objective, status, version,
      llm_mode, model_id, kind, segment, workflow, mode, result_owner, conversation_id, scope,
      latest_revision, created_at, updated_at)
    values (${id}, ${CAROL}, 'carol@local.test', ${seedId(2, 0)}, 'Onboarding drop-off by channel',
      ${scope.question}, 'running', 3, 'stub', ${SEEDED}, 'teamwork', ${SEGMENT}, 'research_brief',
      'manual', ${owner.id}, ${home.conversation_id}, ${sql.json(scope)}, 0, ${stamp}, ${stamp})
    on conflict (id) do update set created_at = excluded.created_at, updated_at = excluded.updated_at`;
  const specialists = [
    { key: 'research-analyst-1', status: 'running', started: stamp },
    { key: 'risk-reviewer-1', status: 'queued', started: null },
  ] as const;
  for (const [n, s] of specialists.entries()) {
    const [mate] = await sql<{ id: string; name: string; role: string; instructions: string }[]>`
      select id, name, role, instructions from tw_teammates
      where owner_sub = ${CAROL} and name = ${n === 0 ? 'Research analyst' : 'Risk and compliance reviewer'}`;
    if (mate === undefined) throw new Error('carol lacks a starter specialist');
    await sql`
      insert into tw_assignments (id, task_id, key, teammate_id, teammate_snapshot, skills, brief, deliverable,
        sources, capabilities, status, deadline_at, started_at, created_at, updated_at)
      values (${seedId(3, n)}, ${id}, ${s.key}, ${mate.id},
        ${sql.json({ name: mate.name, role: mate.role, instructions: mate.instructions, version: 1 })},
        '[]'::jsonb, 'Read the onboarding sources for October.', 'Findings with citations',
        '["drive_research"]'::jsonb, '["drive.read"]'::jsonb, ${s.status},
        ${new Date(stamp.getTime() + 300_000)}, ${s.started}, ${stamp}, ${stamp})
      on conflict (id) do update set started_at = excluded.started_at, deadline_at = excluded.deadline_at,
        created_at = excluded.created_at, updated_at = excluded.updated_at`;
  }
  await anchor(
    home.conversation_id,
    id,
    seedId(4, 0),
    'task_created',
    'Onboarding drop-off by channel',
    stamp,
  );
}

/** A stub-mode task that stopped at synthesis, so the failure card and its recovery show. */
async function seedFailed(
  owner: { id: string },
  home: { id: string; conversation_id: string },
  stamp: Date,
) {
  const sql = db(SEGMENT);
  const id = seedId(1, 1);
  const scope = {
    question: 'Summarize churn reasons from the October interviews.',
    metrics: null,
    repository: null,
    issueNumber: null,
    attachmentIds: [],
  };
  await sql`
    insert into wb_tasks (id, owner_sub, owner_email, client_request_id, title, objective, status, version,
      llm_mode, model_id, kind, segment, workflow, mode, result_owner, conversation_id, scope,
      latest_revision, error_code, error_message, failed_stage, created_at, updated_at)
    values (${id}, ${CAROL}, 'carol@local.test', ${seedId(2, 1)}, 'Churn reasons from interviews',
      ${scope.question}, 'failed', 4, 'stub', ${SEEDED}, 'teamwork', ${SEGMENT}, 'research_brief',
      'manual', ${owner.id}, ${home.conversation_id}, ${sql.json(scope)}, 0, 'timeout',
      'The model did not answer in time while writing the result.', 'synthesis', ${stamp}, ${stamp})
    on conflict (id) do update set created_at = excluded.created_at, updated_at = excluded.updated_at`;
  await anchor(
    home.conversation_id,
    id,
    seedId(4, 1),
    'task_created',
    'Churn reasons from interviews',
    stamp,
  );
  await anchor(
    home.conversation_id,
    id,
    seedId(4, 2),
    'failed',
    'Churn reasons from interviews',
    stamp,
    'failed:4',
  );
}

async function anchor(
  conversationId: string,
  taskId: string,
  id: string,
  kind: string,
  title: string,
  stamp: Date,
  ref?: string,
) {
  const sql = db(SEGMENT);
  await sql`
    insert into tw_messages (id, conversation_id, owner_sub, client_request_id, role, body, task_id, card,
      reply_state, created_at)
    values (${id}, ${conversationId}, ${CAROL}, ${`${SEEDED}:${id}`}, 'system', ${title}, ${taskId},
      ${sql.json(ref === undefined ? { kind, taskId, title } : { kind, taskId, title, ref })}, 'done', ${stamp})
    on conflict (id) do update set created_at = excluded.created_at`;
}

async function setUp(page: Page): Promise<Setup> {
  await signInLocal(page, 'carol@local.test');
  await page.goto(`/s/${SEGMENT}/teammates`);
  const starter = page.getByRole('button', { name: /starter team/i });
  if (await starter.isVisible()) await starter.click();
  const coordinator = await teammate('Coordinator');
  const researcher = await teammate('Research analyst');
  const analyst = await teammate('Data analyst');

  if ((await reviewedTask()) === undefined) {
    // The journey signs in on its own.
    await signOut(page);
    await runJourney(page, { ...JOURNEYS[1], n: 0, member: 'carol@local.test' });
  }
  const task = await reviewedTask();
  if (task === undefined) throw new Error('carol has no reviewed task after the journey');

  const [approval] = await db(SEGMENT)<{ id: string }[]>`
    select id from wb_approvals where task_id = ${task.id} and subject_ref = ${task.latest}
    order by requested_at desc limit 1`;
  if (approval === undefined) {
    const reply = await apiPost(page, `/api/s/${SEGMENT}/tasks/${task.id}/publish`, {
      revision: task.latest,
    });
    expect(reply.status()).toBe(200);
  }
  const [pending] = await db(SEGMENT)<{ id: string; requested_at: Date }[]>`
    select id, requested_at from wb_approvals where task_id = ${task.id} and subject_ref = ${task.latest}
    order by requested_at desc limit 1`;
  if (pending === undefined) throw new Error('publishing created no approval');
  const now = new Date(pending.requested_at.getTime() + 10 * 60_000);
  const [revision] = await db(SEGMENT)<{ evidence_ids: string[] }[]>`
    select evidence_ids from tw_revisions where task_id = ${task.id} and revision = ${task.latest}`;
  const cited = revision?.evidence_ids.at(0);
  if (cited === undefined) throw new Error('the reviewed revision cites nothing');

  await seedRunning(coordinator, researcher, now);
  await seedFailed(coordinator, analyst, now);
  return {
    now,
    coordinator: coordinator.id,
    researcher: researcher.id,
    analyst: analyst.id,
    taskId: task.id,
    latest: task.latest,
    cited,
    approvalId: pending.id,
  };
}

const at = (s: Setup, teammateId: string, rest = '') =>
  `/s/${SEGMENT}/teammates/${teammateId}${rest}`;
const result = (s: Setup, rest = '') =>
  at(s, s.coordinator, `/tasks/${s.taskId}/results/${s.latest}${rest}`);

async function show(page: Page, url: string, ready: () => Promise<void>): Promise<void> {
  await page.goto(url);
  await ready();
  // Fonts and the first poll settle before the capture.
  await page.evaluate(() => document.fonts.ready);
}

test.describe.configure({ mode: 'serial' });

let s: Setup;

// Runs first in this serial file; a later test sees its result. The first run on a fresh stack
// generates carol's reviewed task with real Gemini (about ten calls); later runs reuse it.
test("set up carol's reviewed task, approval and seeded states", async ({ page }) => {
  test.setTimeout(900_000);
  s = await setUp(page);
});

test.beforeEach(async ({ page }, info) => {
  if (info.title.startsWith('set up')) return;
  await page.clock.setFixedTime(s.now);
  await signInLocal(page, 'carol@local.test');
});

for (const theme of THEMES) {
  for (const width of WIDTHS) {
    test(`required states, ${theme}, ${width}`, async ({ page }) => {
      await page.emulateMedia({ colorScheme: theme, reducedMotion: 'reduce' });
      await page.setViewportSize({ width, height: width === 375 ? 812 : 900 });
      const suffix = `${width}-${theme}`;

      await show(page, at(s, s.coordinator), async () => {
        await expect(page.locator(`li.card[id^="card:${s.taskId}:"]`).first()).toBeVisible();
      });
      await captureForBaseline(page, `conversation-${suffix}`);

      await show(page, at(s, s.researcher), async () => {
        await expect(page.locator(`li.card[id^="card:${seedId(1, 0)}:"]`).first()).toBeVisible();
      });
      await captureForBaseline(page, `running-work-${suffix}`);

      await show(page, result(s), async () => {
        await expect(page.getByRole('tab', { name: 'Result', exact: true })).toBeVisible();
      });
      await captureForBaseline(page, `result-review-${suffix}`);

      await show(
        page,
        at(s, s.coordinator, `/tasks/${s.taskId}/approvals/${s.approvalId}`),
        async () => {
          await expect(page.getByRole('button', { name: /Approve once/ })).toBeVisible();
        },
      );
      await captureForBaseline(page, `action-approval-${suffix}`);
    });
  }
}

for (const theme of THEMES) {
  test(`targeted states, ${theme}, 1440`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: theme, reducedMotion: 'reduce' });
    await page.setViewportSize({ width: 1440, height: 900 });
    const suffix = `1440-${theme}`;

    await show(page, result(s, `/sources?citation=${s.cited}`), async () => {
      await expect(page.locator('mark').first()).toBeVisible();
    });
    await captureForBaseline(page, `citation-source-${suffix}`);

    await show(page, result(s, '/changes'), async () => {
      await expect(page.getByRole('tab', { name: 'Changes' })).toHaveAttribute(
        'aria-selected',
        'true',
      );
    });
    await captureForBaseline(page, `revision-changes-${suffix}`);

    await show(page, at(s, s.coordinator, `/tasks/${s.taskId}/plan/1`), async () => {
      await expect(page.getByRole('heading', { level: 2, name: 'Review plan' })).toBeVisible();
    });
    await captureForBaseline(page, `plan-review-${suffix}`);

    await show(page, at(s, s.analyst), async () => {
      await expect(page.locator(`li.card[id^="card:${seedId(1, 1)}:"]`).first()).toBeVisible();
    });
    await captureForBaseline(page, `recoverable-failure-${suffix}`);

    await show(page, at(s, s.coordinator, '/inbox'), async () => {
      await expect(page.getByRole('heading', { level: 2, name: 'Attention inbox' })).toBeVisible();
    });
    await captureForBaseline(page, `inbox-${suffix}`);

    await show(page, at(s, s.coordinator, '/details'), async () => {
      await expect(page.getByLabel('Display name')).toBeVisible();
    });
    await captureForBaseline(page, `teammate-customization-${suffix}`);

    await show(page, at(s, s.coordinator, '/preferences'), async () => {
      await expect(page.getByRole('radio', { name: 'System' })).toBeVisible();
    });
    await captureForBaseline(page, `preferences-${suffix}`);

    await show(page, at(s, s.coordinator), async () => {
      await expect(page.getByRole('textbox', { name: 'Message' })).toBeVisible();
    });
    await page.getByRole('tab', { name: 'Work' }).click();
    await expect(page.getByRole('tab', { name: 'Work' })).toHaveAttribute('aria-selected', 'true');
    await captureForBaseline(page, `sidebar-work-${suffix}`);
    await page.getByRole('tab', { name: 'Results' }).click();
    await captureForBaseline(page, `sidebar-results-${suffix}`);

    await page.getByRole('tab', { name: 'Teammates' }).click();
    const composer = page.getByRole('textbox', { name: 'Message' });
    await composer.fill('@');
    await expect(page.getByRole('listbox')).toBeVisible();
    await captureForBaseline(page, `composer-mention-menu-${suffix}`);
    await composer.fill('');
  });
}
