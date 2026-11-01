import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';

import { expect, test as base } from '@playwright/test';

import { db, expectCalculations } from '../../m1/helpers.js';
import { signInLocal } from '../helpers.js';

import type { Member } from '../helpers.js';
import type { Locator, Page } from '@playwright/test';

// The six real-model journeys of docs/ui/ACCEPTANCE_REPORT.md share these seven steps. Every
// wait is condition-based against the segment database or the page; nothing is mocked and every
// model call is real, so each journey spends about five calls under campaign ui-2026-10.

type Segment = 'alpha' | 'beta';
type Workflow = 'research_brief' | 'metrics_explanation' | 'engineering_proposal';
type Mode = 'manual' | 'coordinated';
type Theme = 'light' | 'dark';

export type Journey = {
  readonly n: number;
  readonly workflow: Workflow;
  readonly segment: Segment;
  readonly theme: Theme;
  readonly mode: Mode;
  /** Whose conversation the work starts in. */
  readonly teammate: string;
  /** Manual mode: every specialist on the draft, in the order they are added. */
  readonly specialists: readonly string[];
  readonly objective: string;
  readonly revision: string;
  /** Defaults to alice; the visual-baseline setup runs one journey as carol. */
  readonly member?: Member;
  /** The context the member selects before creating the task: an @ source or a + file. */
  readonly context:
    | { readonly kind: 'source'; readonly name: string; readonly source: string }
    | { readonly kind: 'file'; readonly path: string };
  readonly metrics?: {
    readonly baseline: string;
    readonly current: string;
    readonly groupBy: 'region' | 'channel';
  };
  /** Key into fixtures/m1/expected/<segment>-metrics.json. */
  readonly calculations?: string;
};

/** The only teammate with a multi-section synthesis skill, so every task's result owner. */
const OWNER = 'Coordinator';
const CAMPAIGN = 'ui-2026-10';
/** The campaign cap per segment, retries included; a journey needs about eight calls. */
const BUDGET = 300;
const RESERVE = 8;
const EXECUTION_MS = 480_000;
const RECORDS = 'artifacts/ui/journeys';
const VIDEOS = 'artifacts/ui/videos';

export const JOURNEYS = {
  1: {
    n: 1,
    workflow: 'research_brief',
    segment: 'alpha',
    theme: 'light',
    mode: 'coordinated',
    teammate: OWNER,
    specialists: [],
    objective:
      'Which feature-flag service should the platform team adopt: Flagship, Togglr or self-hosted OpenFlags? Weigh price, single sign-on, uptime SLA, EU data residency and the security review, and flag stale or conflicting sources.',
    revision:
      'Add a short section that ranks the three options on EU data residency, citing the source for each.',
    context: { kind: 'source', name: 'Drive research folder', source: 'drive_research' },
  },
  2: {
    n: 2,
    workflow: 'metrics_explanation',
    segment: 'alpha',
    theme: 'dark',
    mode: 'manual',
    teammate: 'Data analyst',
    specialists: ['Data analyst', 'Business context researcher'],
    objective:
      '2026年9月から10月にかけて地域別のサインアップ数がどう変わったか、特にEUの減少とAPACの増加の要因を、承認済み指標と社内ドキュメントから説明してください。',
    revision:
      'Add a section on revenue by region for the same two months, and state the EU signups change as both an absolute count and a percentage.',
    context: { kind: 'source', name: 'BigQuery metrics (read-only)', source: 'bigquery_metrics' },
    metrics: { baseline: '2026-09', current: '2026-10', groupBy: 'region' },
    calculations: 'region:2026-09->2026-10',
  },
  3: {
    n: 3,
    workflow: 'engineering_proposal',
    segment: 'alpha',
    theme: 'light',
    mode: 'manual',
    teammate: 'Software engineer',
    specialists: ['Software engineer', 'Requirements analyst'],
    objective:
      'Propose how to let members download a task report as CSV for the linked issue, using the attached acceptance notes. List the files the change touches and the tests to add.',
    revision: 'Narrow the scope to the evidence table only and list the tests that must change.',
    context: { kind: 'file', path: 'e2e/ui/fixtures/csv-export-acceptance-notes.md' },
  },
  4: {
    n: 4,
    workflow: 'research_brief',
    segment: 'beta',
    theme: 'dark',
    mode: 'manual',
    teammate: 'Research analyst',
    specialists: ['Research analyst', 'Risk and compliance reviewer'],
    objective:
      'Which appointment-reminder channel should the clinics adopt: SMS, app push or email? Compare cost, measured reach, two-way replies and the compliance review, and call out the conflicting SMS delivery rates.',
    revision:
      'Add a short section that lists the compliance requirement for each of the three channels.',
    context: { kind: 'source', name: 'Drive research folder', source: 'drive_research' },
  },
  5: {
    n: 5,
    workflow: 'metrics_explanation',
    segment: 'beta',
    theme: 'light',
    mode: 'coordinated',
    teammate: OWNER,
    specialists: [],
    objective:
      'Explain how bookings, completed visits and no-shows changed by region between September and October 2026, and which operational events explain the NA no-show drop and the EMEA dip.',
    revision:
      'In Unresolved questions, add which further data would confirm whether the NA late-cancellation fee caused the no-show drop.',
    context: { kind: 'source', name: 'Drive business context folder', source: 'drive_context' },
    metrics: { baseline: '2026-09', current: '2026-10', groupBy: 'region' },
    calculations: 'region:2026-09->2026-10',
  },
  6: {
    n: 6,
    workflow: 'engineering_proposal',
    segment: 'beta',
    theme: 'dark',
    mode: 'coordinated',
    teammate: OWNER,
    specialists: [],
    objective:
      'Propose how to return rate-limit headers from the workbench API for the linked issue. Name the files that change and the tests to add.',
    revision: 'Drop the per-member limit and keep only a per-segment limit; explain the trade-off.',
    context: { kind: 'source', name: 'GitHub code at pinned commit', source: 'github_code' },
  },
} as const satisfies Readonly<Record<1 | 2 | 3 | 4 | 5 | 6, Journey>>;

const slug = (j: Journey): string =>
  `journey-${j.n}-${j.workflow.split('_')[0]}-${j.segment}-${j.theme}`;

export const test = base.extend<{ journey: Journey; journeyVideo: void }>({
  journey: [JOURNEYS[1], { option: true }],
  // Closes the page so the recording is complete, then keeps a named copy next to the records.
  journeyVideo: [
    async ({ page, journey }, use, testInfo) => {
      await use();
      const video = page.video();
      await page.close();
      if (video === null) return;
      mkdirSync(VIDEOS, { recursive: true });
      const failed = testInfo.status !== testInfo.expectedStatus;
      await video.saveAs(`${VIDEOS}/${slug(journey)}${failed ? '-failed' : ''}.webm`);
    },
    { auto: true },
  ],
});

type Assignment = {
  readonly id: string;
  readonly key: string;
  readonly name: string;
  readonly status: string;
  readonly sources: readonly string[];
  readonly startedAt: string | null;
  readonly finishedAt: string | null;
  readonly modelVersion: string | null;
  readonly responseId: string | null;
};

type Statement = {
  readonly text: string;
  readonly support: string;
  readonly evidenceIds: readonly string[];
  readonly calculationIds: readonly string[];
};

type Revision = {
  readonly revision: number;
  readonly title: string;
  readonly evidenceIds: readonly string[];
  readonly statements: readonly Statement[];
  readonly digest: string;
  readonly diff: {
    readonly added: readonly unknown[];
    readonly removed: readonly unknown[];
    readonly changedSections: readonly string[];
  } | null;
};

type ModelCall = {
  readonly purpose: string;
  readonly responseId: string;
  readonly version: string;
};

export type JourneyRecord = {
  readonly journey: number;
  readonly workflow: Workflow;
  readonly segment: Segment;
  readonly theme: Theme;
  readonly mode: Mode;
  readonly member: string;
  readonly taskId: string;
  readonly title: string;
  readonly conversationId: string;
  readonly teammateId: string;
  readonly context: Journey['context'];
  readonly plan: { readonly version: number; readonly decidedAt: string } | null;
  readonly assignments: readonly Assignment[];
  readonly overlap: boolean;
  readonly revisions: readonly { readonly revision: number; readonly digest: string }[];
  /** Member retries from a failure card after a provider fault, at most two. */
  readonly retries: number;
  readonly modelCalls: { readonly count: number; readonly calls: readonly ModelCall[] };
  readonly durationsMs: Readonly<Record<string, number>>;
  readonly videoPath: string;
  readonly recordedAt: string;
};

const message = (page: Page): Locator => page.getByRole('textbox', { name: 'Message' });
const plus = (page: Page): Locator => page.getByRole('button', { name: 'Add to the message' });
const draftCard = (page: Page): Locator => page.locator('.card[data-kind="task_draft"]');
const cardOf = (page: Page, taskId: string, kind: string): Locator =>
  page.locator(`li.card[data-kind="${kind}"][id^="card:${taskId}:"]`);
/** The result card whose status chip reads "Revision n" or "Revision n of m". */
const resultCard = (page: Page, taskId: string, revision: number): Locator =>
  cardOf(page, taskId, 'result').filter({
    // eslint-disable-next-line security/detect-non-literal-regexp
    has: page.locator('.card-status', { hasText: new RegExp(`^Revision ${revision}( of \\d+)?$`) }),
  });

async function calls(segment: Segment): Promise<number> {
  const [row] = await db(segment)<{ n: number }[]>`
    select count(*)::int as n from wb_model_calls
    where mode = 'vertex' and sent and campaign = ${CAMPAIGN}`;
  return row?.n ?? 0;
}

/** The mock member who runs a journey; the six acceptance journeys are alice's. */
const memberOf = (journey: Journey): Member => journey.member ?? 'alice@local.test';
const subOf = (journey: Journey): string => `local-test:${memberOf(journey).split('@')[0]}`;

async function teammateId(journey: Journey): Promise<string> {
  const rows = await db(journey.segment)<{ id: string }[]>`
    select id from tw_teammates where owner_sub = ${subOf(journey)} and name = ${journey.teammate}
      and not archived
    order by created_at limit 1`;
  const id = rows[0]?.id;
  if (id === undefined)
    throw new Error(`${memberOf(journey)} has no teammate named ${journey.teammate}`);
  return id;
}

/** Enter or Ctrl+Enter, whichever the member's visible hint says sends. */
async function send(page: Page): Promise<void> {
  const hint = await page.locator('.cp-hint').first().innerText();
  await message(page).press(hint.startsWith('Ctrl/Cmd+Enter') ? 'Control+Enter' : 'Enter');
}

/** Emulates the OS theme; a member preference other than System would override it, so reset. */
async function openTheme(page: Page, theme: Theme): Promise<void> {
  await page.emulateMedia({ colorScheme: theme });
  const chosen = await page.evaluate(() => document.documentElement.dataset.theme);
  if (chosen !== undefined) {
    await page.getByRole('button', { name: 'Preferences' }).click();
    await page.getByRole('radio', { name: 'System' }).check();
    await page.getByRole('button', { name: 'Close panel' }).click();
  }
  const scheme = () => page.evaluate(() => getComputedStyle(document.documentElement).colorScheme);
  if (theme === 'dark') await expect.poll(scheme).toBe('dark');
  else await expect.poll(scheme).not.toBe('dark');
}

async function selectContext(page: Page, journey: Journey): Promise<void> {
  const chips = page.getByRole('group', { name: 'Context' });
  if (journey.context.kind === 'file') {
    const [chooser] = await Promise.all([
      page.waitForEvent('filechooser'),
      (async () => {
        await plus(page).click();
        await page.getByRole('option', { name: /Attach a file/ }).click();
      })(),
    ]);
    await chooser.setFiles(journey.context.path);
    await expect(page.locator('.cx-ready')).toHaveCount(1);
    await expect(chips).toContainText(journey.context.path.split('/').at(-1) ?? '');
    return;
  }
  await message(page).click();
  await page.keyboard.press('End');
  await page.keyboard.type(' @');
  const list = page.getByRole('listbox');
  await expect(list).toBeVisible();
  const option = list.getByRole('option', { name: journey.context.name });
  await expect(option, `source ${journey.context.name} is offered`).toBeVisible();
  await option.click();
  await expect(chips).toContainText(journey.context.name);
  expect((await message(page).inputValue()).trim(), 'the trigger text is gone').toBe(
    journey.objective,
  );
}

async function addSpecialists(page: Page, card: Locator, journey: Journey): Promise<void> {
  const rows = card.getByRole('list', { name: 'Specialists' }).getByRole('listitem');
  for (const name of journey.specialists) {
    if ((await rows.filter({ hasText: name }).count()) > 0) continue;
    await card.getByRole('button', { name: 'Add specialist' }).click();
    await page
      .getByRole('list', { name: 'Teammates to add' })
      .getByRole('button')
      .filter({ hasText: name })
      .first()
      .click();
    await expect(rows.filter({ hasText: name })).toHaveCount(1);
  }
  await expect(rows).toHaveCount(journey.specialists.length);
}

async function optionValue(select: Locator, text: string): Promise<string> {
  const value = await select.locator('option', { hasText: text }).first().getAttribute('value');
  if (value === null) throw new Error(`no option matching ${text}`);
  return value;
}

type Created = { readonly id: string; readonly title: string; readonly conversationId: string };

/** Fills the draft card the way a member would, then starts it; returns the row the segment made. */
async function createTask(page: Page, journey: Journey, since: Date): Promise<Created> {
  await plus(page).click();
  await page
    .getByRole('option', {
      name: journey.mode === 'manual' ? /Create task/ : /Ask the coordinator for a plan/,
    })
    .click();
  const card = draftCard(page);
  await expect(card).toBeVisible();
  await expect(card.getByLabel('Objective')).toHaveValue(journey.objective);
  await card.getByLabel('Workflow').selectOption(journey.workflow);
  await expect(
    card.getByRole('radio', {
      name: journey.mode === 'manual' ? 'Manual' : 'Reviewed plan (coordinator)',
    }),
  ).toBeChecked();
  if (journey.metrics !== undefined) {
    await card.getByLabel('Baseline month').fill(journey.metrics.baseline);
    await card.getByLabel('Current month').fill(journey.metrics.current);
    await card.getByLabel('Group by').selectOption(journey.metrics.groupBy);
  }
  if (journey.workflow === 'engineering_proposal')
    await expect(card.getByLabel('Repository'), 'a repository is allowlisted').not.toHaveValue('');
  if (journey.mode === 'manual') {
    await addSpecialists(page, card, journey);
    if (journey.teammate !== OWNER) {
      await card.getByRole('button', { name: 'Edit' }).click();
      const owner = card.getByLabel('Result owner');
      await owner.selectOption(await optionValue(owner, `${OWNER} ·`));
    }
  }
  await expect(card.locator('#td-problems')).toHaveCount(0);
  await card.getByRole('button', { name: 'Start' }).click();
  await expect(card).toBeHidden();
  await expect(message(page)).toHaveValue('');
  const rows = () =>
    db(journey.segment)<{ id: string; title: string; conversation_id: string }[]>`
      select id, title, conversation_id from wb_tasks
      where owner_sub = ${subOf(journey)} and kind = 'teamwork' and objective = ${journey.objective}
        and created_at >= ${since}
      order by created_at desc`;
  await expect.poll(async () => (await rows()).length, { timeout: 30_000 }).toBe(1);
  const [row] = await rows();
  if (row === undefined) throw new Error('the task row disappeared');
  return { id: row.id, title: row.title, conversationId: row.conversation_id };
}

type TaskRow = {
  readonly status: string;
  readonly latest_revision: number;
  readonly error_code: string | null;
  readonly error_message: string | null;
};

const DEAD = new Set(['failed', 'cancelled', 'declined']);
const ANSWER =
  'Keep to what the sources show. Where the issue leaves a choice open, take the smallest change that fits the existing conventions and say so in the result.';

/**
 * Polls the task row until it reaches one of `wanted` at `minRevision`. A terminal or stuck state
 * fails at once, unless `orFailed` lets the caller recover from a `failed` row.
 */
async function waitForTask(
  page: Page,
  segment: Segment,
  taskId: string,
  wanted: readonly string[],
  minRevision = 0,
  orFailed = false,
): Promise<TaskRow> {
  const read = async (): Promise<TaskRow> => {
    const [row] = await db(segment)<TaskRow[]>`
      select status, latest_revision, error_code, error_message from wb_tasks where id = ${taskId}`;
    if (row === undefined) throw new Error(`task ${taskId} vanished`);
    if (row.status === 'needs_input') await answerQuestion(page, taskId);
    if (DEAD.has(row.status) && !(orFailed && row.status === 'failed'))
      throw new Error(
        `task ${taskId} went ${row.status}: ${row.error_code ?? ''} ${row.error_message ?? ''}`,
      );
    return row;
  };
  await expect
    .poll(
      async () => {
        const row = await read();
        return (
          row.status === 'failed' ||
          (wanted.includes(row.status) && row.latest_revision >= minRevision)
        );
      },
      { timeout: EXECUTION_MS, intervals: [3_000] },
    )
    .toBe(true);
  return read();
}

/**
 * A specialist may ask the member something before it can finish. The member answers from the
 * question card in the conversation; the answer is generic on purpose, since the journey proves
 * the path and not the content. Each open question is answered once.
 */
async function answerQuestion(page: Page, taskId: string): Promise<void> {
  const card = cardOf(page, taskId, 'question').last();
  await expect(card).toBeVisible({ timeout: 60_000 });
  await expect(card).toContainText('Needs your answer');
  await card.getByLabel('Your answer').fill(ANSWER);
  await card.getByRole('button', { name: 'Send answer' }).click();
  await expect(card).toContainText('Answered', { timeout: 60_000 });
}

/** Provider faults a member may retry from the failure card; anything else fails the journey. */
const TRANSIENT = new Set(['timeout', 'invalid_output']);
const MAX_RETRIES = 2;

/**
 * Waits for revision 2. A provider fault fails the task honestly; the member retries from the
 * failure card, the product's own visible recovery, at most twice, and the count is recorded.
 */
async function waitForRevision2(page: Page, journey: Journey, taskId: string): Promise<number> {
  for (let retries = 0; ; retries += 1) {
    const row = await waitForTask(
      page,
      journey.segment,
      taskId,
      ['ready', 'completed'],
      2,
      retries < MAX_RETRIES,
    );
    if (row.status !== 'failed') return retries;
    expect(TRANSIENT.has(row.error_code ?? ''), `retrying ${row.error_code}`).toBe(true);
    const card = cardOf(page, taskId, 'failure').last();
    await expect(card).toBeVisible({ timeout: 60_000 });
    await expect(card).not.toContainText('Resolved');
    await expect(card).toContainText('Writing the result failed');
    await card.getByRole('button', { name: 'Retry' }).click();
    await expect(card).toContainText('Resolved', { timeout: 60_000 });
  }
}

/** Reviews plan v1 in the panel and approves that exact version; returns the decision time. */
async function approvePlan(page: Page, journey: Journey, taskId: string): Promise<string> {
  await waitForTask(page, journey.segment, taskId, ['plan_review']);
  const card = cardOf(page, taskId, 'plan');
  await expect(card).toBeVisible({ timeout: 60_000 });
  await expect(card).toContainText('Pending your review');
  await card.getByRole('button', { name: 'Review plan' }).click();
  await expect(page.getByRole('heading', { level: 2, name: 'Review plan' })).toBeVisible();
  const panel = page.locator('.pn-body');
  await expect(panel).toContainText('Version 1 · Pending your review');
  await expect(panel.locator('.plan-asg > li')).not.toHaveCount(0);
  const started = await db(journey.segment)<{ n: number }[]>`
    select count(*)::int as n from tw_assignments where task_id = ${taskId} and started_at is not null`;
  expect(started[0]?.n, 'nothing runs before approval').toBe(0);
  await panel.getByRole('button', { name: 'Approve plan v1' }).click();
  const plan = () =>
    db(journey.segment)<{ state: string; decided_at: Date | null; decided_by: string | null }[]>`
      select state, decided_at, decided_by from tw_plans where task_id = ${taskId} and version = 1`;
  await expect.poll(async () => (await plan())[0]?.state).toBe('approved');
  const [row] = await plan();
  expect(row?.decided_by).toBe(subOf(journey));
  await expect(panel).toContainText('Version 1 · Approved');
  await page.getByRole('button', { name: 'Close panel' }).click();
  return row?.decided_at?.toISOString() ?? '';
}

async function assignmentsOf(segment: Segment, taskId: string): Promise<Assignment[]> {
  const rows = await db(segment)<
    {
      id: string;
      key: string;
      name: string;
      status: string;
      sources: string[];
      started_at: Date | null;
      finished_at: Date | null;
      model: { modelVersion?: string; responseId?: string } | null;
    }[]
  >`
    select id, key, teammate_snapshot->>'name' as name, status, sources, started_at, finished_at, model
    from tw_assignments where task_id = ${taskId} order by created_at`;
  return rows.map((row) => ({
    id: row.id,
    key: row.key,
    name: row.name,
    status: row.status,
    sources: row.sources,
    startedAt: row.started_at?.toISOString() ?? null,
    finishedAt: row.finished_at?.toISOString() ?? null,
    modelVersion: row.model?.modelVersion ?? null,
    responseId: row.model?.responseId ?? null,
  }));
}

/** True when any two assignments were running at the same moment. */
function overlapping(assignments: readonly Assignment[]): boolean {
  return assignments.some((a, i) =>
    assignments
      .slice(i + 1)
      .some(
        (b) =>
          a.startedAt !== null &&
          a.finishedAt !== null &&
          b.startedAt !== null &&
          b.finishedAt !== null &&
          a.startedAt < b.finishedAt &&
          b.startedAt < a.finishedAt,
      ),
  );
}

async function revisionOf(segment: Segment, taskId: string, revision: number): Promise<Revision> {
  const [row] = await db(segment)<
    {
      content: { title: string; sections: { statements: Statement[] }[] };
      evidence_ids: string[];
      digest: string;
      diff: Revision['diff'];
    }[]
  >`
    select content, evidence_ids, digest, diff from tw_revisions
    where task_id = ${taskId} and revision = ${revision}`;
  if (row === undefined) throw new Error(`revision ${revision} of ${taskId} is missing`);
  return {
    revision,
    title: row.content.title,
    evidenceIds: row.evidence_ids,
    statements: row.content.sections.flatMap((s) => s.statements),
    digest: row.digest,
    diff: row.diff,
  };
}

async function modelCalls(segment: Segment, taskId: string): Promise<ModelCall[]> {
  const rows = await db(segment)<{ purpose: string; response_id: string; model_version: string }[]>`
    select purpose, response_id, model_version from wb_model_calls
    where task_id = ${taskId} and mode = 'vertex' and sent and outcome = 'ok'
      and campaign = ${CAMPAIGN} order by id`;
  return rows.map((r) => ({
    purpose: r.purpose,
    responseId: r.response_id,
    version: r.model_version,
  }));
}

/** Backend truth after execution: assignments, ledger rows, revision 1 and its evidence. */
async function assertExecution(
  journey: Journey,
  taskId: string,
  planDecidedAt: string | null,
): Promise<{ readonly assignments: Assignment[]; readonly revision: Revision }> {
  const assignments = await assignmentsOf(journey.segment, taskId);
  expect(assignments.length, 'specialists ran').toBeGreaterThanOrEqual(
    journey.mode === 'manual' ? journey.specialists.length : 1,
  );
  for (const a of assignments) {
    expect(a.status, a.key).toBe('succeeded');
    expect(a.modelVersion, a.key).toMatch(/^gemini-3\.8-flash/);
    expect(a.responseId, a.key).toMatch(/\S/);
    if (planDecidedAt !== null)
      expect((a.startedAt ?? '') >= planDecidedAt, `${a.key} started after approval`).toBe(true);
  }
  if (journey.mode === 'manual')
    expect(assignments.map((a) => a.name).sort()).toEqual([...journey.specialists].sort());
  const sourceKinds = new Set(assignments.flatMap((a) => a.sources));
  const wanted = journey.context.kind === 'file' ? 'member_file' : journey.context.source;
  expect([...sourceKinds], `selected context ${wanted} reached an assignment`).toContain(wanted);
  const ledger = await modelCalls(journey.segment, taskId);
  const purposes = new Set(ledger.map((c) => c.purpose));
  expect(purposes.has('contribution'), 'contribution calls').toBe(true);
  expect(purposes.has('synthesis'), 'synthesis call').toBe(true);
  if (journey.mode === 'coordinated') expect(purposes.has('plan'), 'plan call').toBe(true);
  expect(ledger.filter((c) => c.purpose === 'contribution').length).toBeGreaterThanOrEqual(
    assignments.length,
  );
  const revision = await revisionOf(journey.segment, taskId, 1);
  expect(revision.title).toMatch(/\S/);
  const evidence = await db(journey.segment)<{ id: string; source_kind: string }[]>`
    select id, source_kind from wb_evidence where task_id = ${taskId}`;
  const known = new Set(evidence.map((e) => e.id));
  expect(revision.evidenceIds.length, 'revision 1 cites evidence').toBeGreaterThan(0);
  for (const id of revision.evidenceIds) expect(known.has(id), `evidence ${id} exists`).toBe(true);
  const supported = revision.statements.filter((s) => s.support === 'supported');
  expect(supported.length, 'at least one supported statement').toBeGreaterThan(0);
  const calculations = new Set(
    (
      await db(journey.segment)<{ id: string }[]>`
        select c->>'id' as id from tw_revisions r, jsonb_array_elements(r.calculations) c
        where r.task_id = ${taskId} and r.revision = 1`
    ).map((c) => c.id),
  );
  for (const s of supported) {
    expect(
      s.evidenceIds.length + s.calculationIds.length,
      `supported statement cites evidence or a calculation: ${s.text}`,
    ).toBeGreaterThan(0);
    for (const id of s.evidenceIds) expect(known.has(id), `cited ${id} exists`).toBe(true);
    for (const id of s.calculationIds)
      expect(calculations.has(id), `calculation ${id} exists`).toBe(true);
  }
  if (journey.context.kind === 'file')
    expect(
      evidence.some((e) => e.source_kind === 'member_file'),
      'member_file evidence',
    ).toBe(true);
  if (journey.calculations !== undefined)
    await expectCalculations(journey.segment, taskId, journey.calculations);
  return { assignments, revision };
}

async function assertTimeline(
  page: Page,
  taskId: string,
  title: string,
  assignments: readonly Assignment[],
  revision: Revision,
): Promise<Locator> {
  for (const a of assignments) {
    const item = page.locator(`#ctb-${a.id}`);
    await expect(item).toBeVisible({ timeout: 60_000 });
    await expect(item).toHaveAttribute('data-status', 'succeeded');
    await expect(item.locator('.ctb-head')).toContainText(a.name);
    await expect(item.getByRole('button', { name: `for ${title}` })).toBeVisible();
  }
  const card = resultCard(page, taskId, 1);
  await expect(card).toBeVisible({ timeout: 60_000 });
  await expect(card).toContainText(revision.title);
  return card;
}

/** Opens revision 1, follows its first citation into Sources, and comes back. */
async function reviewSources(page: Page, card: Locator, revision: Revision): Promise<void> {
  await card.getByRole('button', { name: 'Open result' }).click();
  const panel = page.getByRole('region', { name: 'Result' });
  await expect(panel).toBeVisible();
  await expect(page).toHaveURL(/\/results\/1$/);
  await expect(panel.locator('.rp-title')).toHaveText(revision.title);
  await expect(panel).toContainText('Draft · no external change');
  const cite = panel.locator('button.cite').first();
  await cite.scrollIntoViewIfNeeded();
  const cited = (await cite.textContent())?.trim() ?? '';
  expect(cited).toMatch(/^E\d+$/);
  await cite.click();
  await expect(page.getByRole('tab', { name: 'Sources' })).toHaveAttribute('aria-selected', 'true');
  await expect(page).toHaveURL(
    (url) => url.pathname.endsWith('/sources') && url.searchParams.get('citation') === cited,
  );
  const entry = page.locator(`#ev-${cited}`);
  await expect(entry).toHaveAttribute('aria-current', 'true');
  await expect(entry.locator('mark')).toBeVisible();
  expect(revision.evidenceIds, `${cited} is among revision 1's evidence`).toContain(cited);
  expect(
    revision.statements.some((s) => s.evidenceIds.includes(cited)),
    `${cited} is cited by a statement`,
  ).toBe(true);
  await page.getByRole('button', { name: 'Back to result' }).click();
  await expect(page.getByRole('tab', { name: 'Result', exact: true })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await expect(page).toHaveURL(/\/results\/1$/);
}

/** Sends a revise follow-up from the composer's target chip and inspects revision 2. */
async function revise(
  page: Page,
  journey: Journey,
  taskId: string,
  title: string,
): Promise<Revision & { readonly retries: number }> {
  await page.getByRole('button', { name: 'Close panel' }).click();
  const target = page.getByRole('group', { name: 'Send target' });
  const chip = target.locator('.tg-chip');
  if ((await chip.count()) > 0) await chip.click();
  // By key (a property, not an attribute), so an earlier task with the same title and revision
  // cannot be picked instead.
  const radios = target.getByRole('radio');
  await expect(radios.first()).toBeVisible();
  const values = await radios.evaluateAll((nodes) =>
    nodes.map((node) => (node as HTMLInputElement).value),
  );
  const index = values.indexOf(`revise:${taskId}`);
  expect(index, `a revise target for ${taskId} among ${values.join(', ')}`).toBeGreaterThan(-1);
  const radio = radios.nth(index);
  await expect(radio.locator('xpath=..')).toContainText(`Revise ${title} rev 1`);
  // Picking closes the list and unmounts the radio, so `check` could never verify it.
  await radio.click();
  await expect(target.locator('.tg-label')).toHaveText(`Revise ${title} rev 1`);
  await message(page).fill(journey.revision);
  await send(page);
  await expect(message(page)).toHaveValue('');
  const retries = await waitForRevision2(page, journey, taskId);
  const revision = await revisionOf(journey.segment, taskId, 2);
  const diff = revision.diff;
  if (diff === null) throw new Error('revision 2 carries no diff');
  expect(
    diff.added.length + diff.removed.length + diff.changedSections.length,
    'revision 2 changed content',
  ).toBeGreaterThan(0);
  const ledger = await modelCalls(journey.segment, taskId);
  expect(
    ledger.some((c) => c.purpose === 'revision'),
    'revision call',
  ).toBe(true);

  const card = resultCard(page, taskId, 2);
  await expect(card).toBeVisible({ timeout: 60_000 });
  await card.getByRole('button', { name: 'Open result' }).click();
  await expect(page).toHaveURL(/\/results\/2$/);
  await page.getByRole('tab', { name: 'Changes' }).click();
  const changes = page.locator('#rp-view');
  await expect(changes).toContainText('Revision 1 → revision 2');
  await expect(changes).not.toContainText('No content or source changes');
  if (diff.added.length > 0)
    await expect(changes.locator('.diff-add')).toHaveCount(diff.added.length);
  if (diff.removed.length > 0)
    await expect(changes.locator('.diff-del')).toHaveCount(diff.removed.length);
  const select = page.getByRole('combobox', { name: 'Revision' });
  await select.selectOption('1');
  await expect(page.getByText('You are reading revision 1 of 2')).toBeVisible();
  await expect(changes).toContainText('First revision');
  await select.selectOption('2');
  await expect(page.getByText('You are reading revision 1 of 2')).toHaveCount(0);
  await expect(changes).toContainText('Revision 1 → revision 2');
  await page.getByRole('tab', { name: 'Result', exact: true }).click();
  await expect(page).toHaveURL(/\/results\/2$/);
  await expect(page.locator('.rp-title')).toHaveText(revision.title);
  return { ...revision, retries };
}

/** Reload, then Work tab → task → back: the route, the revision and the typed draft survive. */
async function survive(page: Page, taskId: string, title: string, revision: Revision) {
  const draft = `Follow-up draft typed before reload ${Date.now()}`;
  await message(page).fill(draft);
  await expect
    .poll(() => page.evaluate(() => JSON.stringify(Object.values(localStorage))))
    .toContain(draft);
  await page.reload();
  await expect(page).toHaveURL(/\/results\/2$/);
  await expect(page.getByRole('combobox', { name: 'Revision' })).toHaveValue('2');
  await expect(page.locator('.rp-title')).toHaveText(revision.title);
  await expect(message(page)).toHaveValue(draft);
  await page.getByRole('tab', { name: 'Work' }).click();
  await page
    .getByRole('list', { name: 'Work' })
    .getByRole('button')
    .filter({ hasText: title })
    .first()
    .click();
  await expect(page.getByRole('heading', { level: 2, name: 'Task', exact: true })).toBeVisible();
  await expect(page).toHaveURL((url) => url.pathname.endsWith(`/tasks/${taskId}`));
  // Close is Back: the previous entry is the result the member was reading.
  await page.getByRole('button', { name: 'Close panel' }).click();
  await expect(page).toHaveURL(/\/results\/2$/);
  await expect(page.getByRole('combobox', { name: 'Revision' })).toHaveValue('2');
  await expect(message(page)).toHaveValue(draft);
  await expect(resultCard(page, taskId, 2)).toBeVisible();
}

function writeRecord(record: JourneyRecord): void {
  mkdirSync(RECORDS, { recursive: true });
  // eslint-disable-next-line security/detect-non-literal-fs-filename
  writeFileSync(`${RECORDS}/${record.journey}.json`, `${JSON.stringify(record, null, 2)}\n`);
}

/** Overlap seen in this journey or in any earlier manual journey's record. */
export function manualOverlapSoFar(own: boolean, upTo: number): boolean {
  if (own) return true;
  for (let n = 1; n < upTo; n += 1) {
    const file = `${RECORDS}/${n}.json`;
    // Record paths are built from this module's constant and a small integer.
    // eslint-disable-next-line security/detect-non-literal-fs-filename
    if (!existsSync(file)) continue;
    // eslint-disable-next-line security/detect-non-literal-fs-filename
    const record = JSON.parse(readFileSync(file, 'utf8')) as JourneyRecord;
    if (record.mode === 'manual' && record.overlap) return true;
  }
  return false;
}

export async function runJourney(page: Page, journey: Journey): Promise<JourneyRecord> {
  const used = await calls(journey.segment);
  if (used + RESERVE > BUDGET)
    throw new Error(
      `budget: ${journey.segment} has ${used} of ${BUDGET} calls used; a journey needs ${RESERVE}`,
    );
  const t0 = Date.now();
  const durationsMs: Record<string, number> = {};
  const mark = (name: string, since: number) => {
    // Duration names are literals in this function.
    // eslint-disable-next-line security/detect-object-injection
    durationsMs[name] = Date.now() - since;
  };

  await signInLocal(page, memberOf(journey));
  const teammate = await teammateId(journey);
  await page.goto(`/s/${journey.segment}/teammates/${teammate}`);
  await expect(message(page)).toBeVisible();
  await openTheme(page, journey.theme);
  await expect(page.locator('.hd')).toContainText(journey.teammate);
  await message(page).fill(journey.objective);
  await selectContext(page, journey);

  const created = Date.now();
  const task = await createTask(page, journey, new Date(t0));
  await expect(page.locator(`li.card[id^="card:${task.id}:"]`).first()).toBeVisible({
    timeout: 60_000,
  });
  const planDecidedAt =
    journey.mode === 'coordinated' ? await approvePlan(page, journey, task.id) : null;
  await waitForTask(page, journey.segment, task.id, ['ready', 'completed'], 1);
  mark('createToRevision1', created);

  const { assignments, revision } = await assertExecution(journey, task.id, planDecidedAt);
  const card = await assertTimeline(page, task.id, task.title, assignments, revision);
  await reviewSources(page, card, revision);
  const revised = Date.now();
  const second = await revise(page, journey, task.id, task.title);
  mark('reviseToRevision2', revised);
  await survive(page, task.id, task.title, second);
  mark('total', t0);

  const ledger = await modelCalls(journey.segment, task.id);
  const record: JourneyRecord = {
    journey: journey.n,
    workflow: journey.workflow,
    segment: journey.segment,
    theme: journey.theme,
    mode: journey.mode,
    member: memberOf(journey),
    taskId: task.id,
    title: task.title,
    conversationId: task.conversationId,
    teammateId: teammate,
    context: journey.context,
    plan: planDecidedAt === null ? null : { version: 1, decidedAt: planDecidedAt },
    assignments,
    overlap: overlapping(assignments),
    revisions: [
      { revision: 1, digest: revision.digest },
      { revision: 2, digest: second.digest },
    ],
    retries: second.retries,
    modelCalls: { count: ledger.length, calls: ledger },
    durationsMs,
    videoPath: `${VIDEOS}/${slug(journey)}.webm`,
    recordedAt: new Date().toISOString(),
  };
  writeRecord(record);
  return record;
}
