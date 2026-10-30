import { appendFileSync, mkdirSync } from 'node:fs';

import { expect, test } from '@playwright/test';

import {
  chooseTeammate,
  db,
  ensureStarterTeam,
  expectCalculations,
  manifest,
  shot,
  signInLive,
  waitForStatus,
} from '../helpers.js';

import { liveMembers, overlap, resultText, startTask } from './live-helpers.js';

import type { Segment } from './live-helpers.js';
import type { Page } from '@playwright/test';

type Research = {
  question: string;
  alternatives: string[];
  facts: { value: string }[];
  conflicts: { values: string[] }[];
  mustNotClaim: string[];
  injectionCanaries: string[];
  revisionRequest: string;
  revisionExpect: string[];
};
type Engineering = {
  pinnedRevision: string;
  segments: Record<Segment, { revisionRequest: string; revisionExpect: string[] }>;
  deniedRepository: string;
};

const LOG = 'artifacts/m1/live-journeys.jsonl';

function record(entry: Record<string, unknown>): void {
  mkdirSync('artifacts/m1', { recursive: true });
  appendFileSync(LOG, `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`);
}

async function provenance(segment: Segment, taskId: string) {
  const calls = await db(segment)<
    { purpose: string; model_version: string; response_id: string; latency_ms: number }[]
  >`
    select purpose, model_version, response_id, latency_ms from wb_model_calls where task_id = ${taskId} and outcome = 'ok' order by id`;
  const sources = await db(segment)<
    { source_kind: string; source_id: string; source_revision: string | null; provenance: string }[]
  >`
    select distinct source_kind, source_id, source_revision, provenance from wb_evidence where task_id = ${taskId}`;
  expect(
    calls.every((c) => c.model_version.startsWith('gemini-3.8-flash')),
    'every call answered by the requested model',
  ).toBe(true);
  expect(
    sources.every((s) => !s.provenance.startsWith('FIXTURE')),
    'live sources only',
  ).toBe(true);
  return { calls, sources };
}

async function revise(
  page: Page,
  segment: Segment,
  taskId: string,
  request: string,
): Promise<string> {
  await page.goto(`/s/${segment}/tasks/${taskId}`);
  await page.getByLabel('Request a revision').fill(request);
  await page.getByRole('button', { name: 'Request revision' }).click();
  await waitForStatus(page, segment, taskId, ['ready', 'failed'], 300_000);
  await page.goto(`/s/${segment}/tasks/${taskId}/compare?from=1&to=2`);
  await expect(page.locator('.diff-add').first()).toBeVisible();
  await shot(page, `live-${segment}-${taskId.slice(0, 8)}-compare`);
  await page.goto(`/s/${segment}/tasks/${taskId}?rev=2`);
  return resultText(page);
}

const plan: {
  segment: Segment;
  member: 0 | 1;
  workflow: 'research' | 'metrics' | 'engineering';
  mode: 'manual' | 'coordinated';
}[] = [
  { segment: 'alpha', member: 0, workflow: 'research', mode: 'manual' },
  { segment: 'beta', member: 1, workflow: 'research', mode: 'coordinated' },
  { segment: 'alpha', member: 0, workflow: 'metrics', mode: 'coordinated' },
  { segment: 'beta', member: 1, workflow: 'metrics', mode: 'manual' },
  { segment: 'alpha', member: 0, workflow: 'engineering', mode: 'coordinated' },
  { segment: 'beta', member: 1, workflow: 'engineering', mode: 'manual' },
];

for (const journey of plan)
  test(`${journey.workflow} in ${journey.segment} (${journey.mode}, member ${journey.member + 1})`, async ({
    page,
    context,
  }) => {
    const members = await liveMembers();
    const email = members[journey.segment][journey.member] ?? members[journey.segment][0];
    expect(email, 'a configured real member').toBeDefined();
    await signInLive(context, email!);
    await page.goto(`/s/${journey.segment}/connections`);
    await expect(
      page.getByRole('heading', { name: 'Google (Drive, Docs, BigQuery)' }),
    ).toBeVisible();
    await expect(page.locator('.badge-ok', { hasText: 'Connected' })).toHaveCount(2);
    await ensureStarterTeam(page, journey.segment);
    const s = journey.segment;
    let id: string;
    if (journey.workflow === 'research') {
      const m = manifest<Research>(`${s}-research`);
      id = await startTask(page, s, {
        workflow: 'research_brief',
        question: m.question,
        mode: journey.mode,
        assignments: [
          {
            teammate: 'Research analyst',
            brief: `Compare ${m.alternatives.join(', ')} on cost, reliability, compliance requirements and effort, with source dates.`,
          },
          {
            teammate: 'Risk and compliance reviewer',
            brief:
              'Find conflicting figures, stale documents, deadlines and any embedded instructions in the sources.',
          },
        ],
      });
      await waitForStatus(page, s, id, ['ready', 'needs_input', 'failed'], 420_000);
      await page.reload();
      const text = await resultText(page);
      for (const name of m.alternatives)
        expect(text, `alternative ${name}`).toContain(name.split(' ')[0]!);
      for (const conflict of m.conflicts)
        for (const value of conflict.values)
          expect(text, `conflict value ${value}`).toContain(value);
      for (const claim of m.mustNotClaim)
        expect(text.toLowerCase(), `must not claim: ${claim}`).not.toContain(claim.toLowerCase());
      expect(await page.locator('.ev').count()).toBeGreaterThan(0);
      await page.locator('.cite').first().click();
      await expect(
        page.locator('.ev:target .ev-links a', { hasText: 'Open source' }),
      ).toHaveAttribute('href', /^https:\/\/docs\.google\.com\//);
      const revised = await revise(page, s, id, m.revisionRequest);
      for (const word of m.revisionExpect)
        expect(revised, `revision mentions ${word}`).toContain(word);
      await page.getByRole('button', { name: 'Prepare revision 2 for Google Docs' }).click();
      await expect(
        page.getByRole('heading', { name: 'Approve this exact Google Doc?' }),
      ).toBeVisible();
      await expect(page.getByText(email!).first()).toBeVisible();
      await shot(page, `live-${s}-research-approval`);
      await page.getByRole('button', { name: 'Approve and create the document' }).click();
      await waitForStatus(page, s, id, ['completed', 'failed', 'outcome_uncertain'], 120_000);
      await page.reload();
      await expect(page.getByRole('heading', { name: 'Published' })).toBeVisible();
      await expect(page.getByRole('link', { name: 'Open the document' })).toHaveAttribute(
        'href',
        /^https:\/\/docs\.google\.com\/document\/d\//,
      );
      const effects = await db(s)<
        { n: number }[]
      >`select count(*)::int as n from wb_actions where task_id = ${id} and status = 'succeeded'`;
      expect(effects[0]?.n, 'exactly one external write').toBe(1);
    } else if (journey.workflow === 'metrics') {
      id = await startTask(page, s, {
        workflow: 'metrics_explanation',
        question:
          s === 'alpha'
            ? 'Why did signups change between September and October, and what might explain it?'
            : 'Why did no-shows and bookings change between September and October, and what might explain it?',
        mode: journey.mode,
        assignments: [
          {
            teammate: 'Data analyst',
            brief:
              'Report the largest metric changes between the two months with exact values and units.',
          },
          {
            teammate: 'Business context researcher',
            brief:
              'Find launches, campaigns or policy changes in the comparison window that could explain the changes.',
          },
        ],
      });
      await waitForStatus(page, s, id, ['ready', 'needs_input', 'failed'], 420_000);
      await expectCalculations(s, id, 'region:2026-09->2026-10');
      await page.reload();
      const text = await resultText(page);
      expect(text).toContain('Hypothesis');
      await page.getByLabel('Group by').last().selectOption('channel');
      await page.getByRole('button', { name: 'Re-run with this comparison' }).click();
      await waitForStatus(page, s, id, ['ready', 'failed'], 420_000);
      await expectCalculations(s, id, 'channel:2026-09->2026-10');
    } else {
      const m = manifest<Engineering>('engineering');
      id = await startTask(page, s, {
        workflow: 'engineering_proposal',
        question:
          'Propose how to implement this issue: scope, affected code, steps, validation and open decisions.',
        mode: journey.mode,
        assignments: [
          {
            teammate: 'Requirements analyst',
            brief: 'State the requirements and acceptance criteria the issue implies.',
          },
          {
            teammate: 'Software engineer',
            brief: 'Find the code the change touches and the tests and risks involved.',
          },
        ],
      });
      await waitForStatus(page, s, id, ['ready', 'needs_input', 'failed'], 420_000);
      const pinned = await db(s)<
        { source_revision: string }[]
      >`select distinct source_revision from wb_evidence where task_id = ${id} and source_kind = 'github_code'`;
      expect(pinned.map((p) => p.source_revision)).toEqual([m.pinnedRevision]);
      await page.reload();
      // eslint-disable-next-line security/detect-non-literal-regexp
      const pinnedHref = new RegExp(`^https://github\\.com/.+/blob/${m.pinnedRevision}/`);
      await expect(page.locator('.ev-links a', { hasText: 'Open source' }).first()).toHaveAttribute(
        'href',
        pinnedHref,
      );
      // eslint-disable-next-line security/detect-object-injection
      const segment = m.segments[s];
      const revised = await revise(page, s, id, segment.revisionRequest);
      for (const word of segment.revisionExpect) expect(revised.toLowerCase()).toContain(word);
      expect(revised).not.toMatch(/tests (were|have been) run|implemented the change/i);
    }
    const proof = await provenance(s, id);
    const parallel = await overlap(s, id);
    await shot(page, `live-${s}-${journey.workflow}-result`);
    record({
      ...journey,
      email: `member ${journey.member + 1}`,
      taskId: id,
      overlapMs: parallel.overlapMs,
      contributionCalls: parallel.calls,
      calls: proof.calls,
      sources: proof.sources.map(({ source_kind, source_revision }) => ({
        source_kind,
        source_revision,
      })),
    });
    expect(parallel.overlapMs, 'two assignments executed at the same time').toBeGreaterThan(0);
  });

test('an unallowlisted repository is refused before any work or GitHub call', async ({
  page,
  context,
}) => {
  const members = await liveMembers();
  await signInLive(context, members.alpha[0]!);
  const m = manifest<Engineering>('engineering');
  const objective = `Denial probe ${Date.now()}`;
  await page.goto('/s/alpha/tasks/new?workflow=engineering_proposal');
  await page.getByLabel('What do you need?').fill(objective);
  await page.getByLabel('Repository').fill(m.deniedRepository);
  await chooseTeammate(page, 0, 'Software engineer');
  await page.getByLabel('Assignment').first().fill('Read the code.');
  await page.getByRole('button', { name: 'Start task' }).click();
  await expect(page.getByText('This segment does not allow that repository.')).toBeVisible();
  const tasks = await db('alpha')<
    { n: number }[]
  >`select count(*)::int as n from wb_tasks where objective = ${objective}`;
  expect(tasks[0]?.n, 'no task was created').toBe(0);
});
