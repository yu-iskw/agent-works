import { existsSync } from 'node:fs';

import { expect, test } from '@playwright/test';

import { db } from '../m1/helpers.js';

import type { APIResponse, Page } from '@playwright/test';

const ARTIFACTS = 'artifacts/ui';
const SCREENSHOTS = `${ARTIFACTS}/screenshots`;
const APPROVED = `${ARTIFACTS}/baselines/approved`;

/** carol exists only for the visual baselines, so no other test changes what she sees. */
export type Member =
  | 'alice@local.test'
  | 'bob@local.test'
  | 'carol@local.test'
  | 'review1@local.test'
  | 'review2@local.test'
  | 'review3@local.test';

/** Mock identity sign-in; the stack labels it as simulated on the page. */
export async function signInLocal(page: Page, email: Member = 'alice@local.test'): Promise<void> {
  await page.goto('/sign-in');
  await page.getByRole('button', { name: `Continue as ${email}` }).click();
  await expect(page).not.toHaveURL(/\/sign-in/);
}

/** Posts the sign-out form the workspace renders, so the session and browser drafts are cleared. */
export async function signOut(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Sign out' }).click();
  await expect(page).toHaveURL(/\/sign-in/);
}

/** URL predicates for `toHaveURL`, so ids built at run time need no regular expression. */
export const endsWith =
  (path: string) =>
  (url: URL): boolean =>
    url.pathname.endsWith(path);
export const includes =
  (path: string) =>
  (url: URL): boolean =>
    url.pathname.includes(path);

async function shot(page: Page, name: string): Promise<void> {
  await page.screenshot({
    path: `${SCREENSHOTS}/${name}.png`,
    fullPage: true,
    mask: volatile(page),
  });
}

/** The live model-call counter changes with every call anywhere in the segment; it is masked. */
const volatile = (page: Page) => [page.locator('.hd-calls')];

/**
 * Writes the capture for human review and compares it only when an approved baseline exists.
 * Without one the test records a `pending-baseline` annotation, which `ui:visual` reports as
 * PENDING; nothing here can create an approved file.
 */
export async function captureForBaseline(page: Page, name: string): Promise<void> {
  await shot(page, name);
  // eslint-disable-next-line security/detect-non-literal-fs-filename
  if (existsSync(`${APPROVED}/${name}.png`)) {
    // Soft, so one run reports every capture that differs instead of stopping at the first.
    await expect
      .soft(page)
      .toHaveScreenshot(`${name}.png`, { fullPage: true, mask: volatile(page) });
    return;
  }
  test.info().annotations.push({ type: 'pending-baseline', description: name });
}

export const SEED_PREFIX = 'ui-seed';
const ALICE = 'local-test:alice';
/** The full strict task scope the segment's detail contract expects, even for a seeded row. */
const scope = (question: string) => ({
  question,
  metrics: null,
  repository: null,
  issueNumber: null,
  attachmentIds: [],
});
const seedId = (kind: number, n: number): string =>
  `aaaaaaaa-5eed-4${String(kind).padStart(3, '0')}-8000-${String(n).padStart(12, '0')}`;

export type SeededHistory = {
  readonly teammateId: string;
  readonly conversationId: string;
  /** Oldest first; `taskIds[n]` is "ui-seed task <n>". */
  readonly taskIds: readonly string[];
  /** Tasks that carry revision 1, titled "ui-seed result <n>". */
  readonly resultTaskIds: readonly string[];
  readonly runningTaskId: string;
  readonly attentionTaskId: string;
};

/**
 * Inserts `count` teamwork tasks for alice straight into the segment database, every third one
 * with an artifact revision, plus one running task with an open question so the Teammates row
 * shows Working and Needs you. Rows are labelled with the `ui-seed` title prefix and keyed by
 * deterministic ids, so running it twice changes nothing. No model is called: `llm_mode` is `stub`.
 */
export async function seedHistory(count = 120): Promise<SeededHistory> {
  const sql = db('alpha');
  const [teammate] = await sql<{ id: string; conversation_id: string }[]>`
    select id, conversation_id from tw_teammates
    where owner_sub = ${ALICE} and not archived order by created_at limit 1`;
  if (teammate === undefined) throw new Error('seedHistory needs alice to have a starter team');
  const base = Date.parse('2026-10-01T00:00:00.000Z');
  const taskIds: string[] = [];
  const resultTaskIds: string[] = [];
  for (let n = 0; n < count; n += 1) {
    const id = seedId(1, n);
    taskIds.push(id);
    const withResult = n % 3 === 0;
    const at = new Date(base + n * 3_600_000).toISOString();
    const status = withResult ? 'completed' : n % 3 === 1 ? 'ready' : 'cancelled';
    await sql`
      insert into wb_tasks (id, owner_sub, owner_email, client_request_id, title, objective, status, version,
        llm_mode, model_id, kind, segment, workflow, mode, result_owner, conversation_id, scope,
        latest_revision, created_at, updated_at)
      values (${id}, ${ALICE}, 'alice@local.test', ${seedId(2, n)}, ${`${SEED_PREFIX} task ${n}`},
        ${`${SEED_PREFIX} objective ${n}`}, ${status}, 1, 'stub', 'ui-seed', 'teamwork', 'alpha',
        'research_brief', 'manual', ${teammate.id}, ${teammate.conversation_id},
        ${sql.json(scope(`${SEED_PREFIX} ${n}`))}, ${withResult ? 1 : 0}, ${at}, ${at})
      on conflict (id) do update set scope = excluded.scope`;
    if (!withResult) continue;
    resultTaskIds.push(id);
    const digest = '0'.repeat(52) + String(n).padStart(12, '0');
    const content = {
      title: `${SEED_PREFIX} result ${n}`,
      summary: `Seeded artifact ${n}.`,
      sections: [{ heading: 'Summary', statements: [] }],
      limitations: [],
    };
    const generation = {
      modelId: 'ui-seed',
      modelVersion: 'ui-seed',
      responseId: null,
      planVersion: null,
      skills: [],
      repositoryRevision: null,
    };
    await sql`
      insert into tw_revisions (task_id, revision, parent, request, content, evidence_ids, calculations,
        unsupported, dropped_citations, missing_assignments, generation, diff, digest, created_at)
      values (${id}, 1, null, null, ${sql.json(content)}, '[]'::jsonb, '[]'::jsonb, 0, 0, '[]'::jsonb,
        ${sql.json(generation)}, null, ${digest}, ${at})
      on conflict (task_id, revision) do update set content = excluded.content, generation = excluded.generation`;
  }
  const runningTaskId = seedId(3, 0);
  const now = new Date().toISOString();
  await sql`
    insert into wb_tasks (id, owner_sub, owner_email, client_request_id, title, objective, status, version,
      llm_mode, model_id, kind, segment, workflow, mode, result_owner, conversation_id, scope,
      latest_revision, created_at, updated_at)
    values (${runningTaskId}, ${ALICE}, 'alice@local.test', ${seedId(4, 0)}, ${`${SEED_PREFIX} running task`},
      ${`${SEED_PREFIX} running`}, 'running', 1, 'stub', 'ui-seed', 'teamwork', 'alpha',
      'research_brief', 'manual', ${teammate.id}, ${teammate.conversation_id},
      ${sql.json(scope(`${SEED_PREFIX} running`))}, 0, ${now}, ${now})
    on conflict (id) do update set scope = excluded.scope, updated_at = excluded.updated_at`;
  const attentionTaskId = seedId(3, 1);
  await sql`
    insert into wb_tasks (id, owner_sub, owner_email, client_request_id, title, objective, status, version,
      llm_mode, model_id, kind, segment, workflow, mode, result_owner, conversation_id, scope,
      latest_revision, created_at, updated_at)
    values (${attentionTaskId}, ${ALICE}, 'alice@local.test', ${seedId(4, 1)}, ${`${SEED_PREFIX} question task`},
      ${`${SEED_PREFIX} question`}, 'needs_input', 1, 'stub', 'ui-seed', 'teamwork', 'alpha',
      'research_brief', 'manual', ${teammate.id}, ${teammate.conversation_id},
      ${sql.json(scope(`${SEED_PREFIX} question`))}, 0, ${now}, ${now})
    on conflict (id) do update set scope = excluded.scope, updated_at = excluded.updated_at`;
  // Re-seeding keeps these rows the newest of their kind, so bounded lists still show them.
  await sql`
    insert into tw_inbox (id, owner_sub, task_id, kind, ref, summary, state, created_at)
    values (${seedId(5, 1)}, ${ALICE}, ${attentionTaskId}, 'question', 'question:ui-seed:1',
      ${`${SEED_PREFIX} needs an answer`}, 'open', ${now})
    on conflict (task_id, ref) do update set state = 'open', created_at = excluded.created_at`;
  return {
    teammateId: teammate.id,
    conversationId: teammate.conversation_id,
    taskIds,
    resultTaskIds,
    runningTaskId,
    attentionTaskId,
  };
}

/**
 * A message after alice's read marker, so her row shows Unread until she reads it. With
 * `role: 'system'` it is persisted activity, the kind a poll delivers while she reads.
 */
export async function seedUnreadReply(
  conversationId: string,
  text: string,
  role: 'teammate' | 'system' = 'teammate',
): Promise<string> {
  const sql = db('alpha');
  const id = seedId(6, Date.now() % 1_000_000_000_000);
  const clientRequestId = `ui-seed:${id}`;
  await sql`
    insert into tw_messages (id, conversation_id, owner_sub, client_request_id, role, body, task_id, card,
      reply_state, created_at)
    values (${id}, ${conversationId}, ${ALICE}, ${clientRequestId}, ${role}, ${text}, null, null,
      'done', now())
    on conflict (id) do nothing`;
  return id;
}

/** The persisted card anchor for the seeded running task, so its conversation shows a running card. */
export async function seedRunningCard(seeded: SeededHistory): Promise<string> {
  const id = seedId(7, 0);
  await db('alpha')`
    insert into tw_messages (id, conversation_id, owner_sub, client_request_id, role, body, task_id, card,
      reply_state, created_at)
    values (${id}, ${seeded.conversationId}, ${ALICE}, ${`ui-seed:${id}`}, 'system',
      ${`${SEED_PREFIX} running task`}, ${seeded.runningTaskId},
      ${db('alpha').json({ kind: 'task_created', title: `${SEED_PREFIX} running task`, taskId: seeded.runningTaskId })},
      'done', now())
    on conflict (id) do nothing`;
  return id;
}

/** A task that belongs to bob in alpha; alice must never see its title through any URL. */
export async function seedBobTask(): Promise<{ readonly id: string; readonly title: string }> {
  const sql = db('alpha');
  const [teammate] = await sql<{ id: string; conversation_id: string }[]>`
    select id, conversation_id from tw_teammates
    where owner_sub = 'local-test:bob' and not archived order by created_at limit 1`;
  if (teammate === undefined) throw new Error('seedBobTask needs bob to have a starter team');
  const id = seedId(8, 0);
  const title = `${SEED_PREFIX} bob private task`;
  const now = new Date().toISOString();
  await sql`
    insert into wb_tasks (id, owner_sub, owner_email, client_request_id, title, objective, status, version,
      llm_mode, model_id, kind, segment, workflow, mode, result_owner, conversation_id, scope,
      latest_revision, created_at, updated_at)
    values (${id}, 'local-test:bob', 'bob@local.test', ${seedId(8, 1)}, ${title}, ${title}, 'ready', 1,
      'stub', 'ui-seed', 'teamwork', 'alpha', 'research_brief', 'manual', ${teammate.id},
      ${teammate.conversation_id}, ${sql.json(scope(title))}, 0, ${now}, ${now})
    on conflict (id) do update set scope = excluded.scope`;
  return { id, title };
}

/** Alice's alpha conversation with a result card and the fewest messages, for Tab-key journeys. */
export async function smallestConversationWithResult(): Promise<{
  readonly teammateId: string;
  readonly conversationId: string;
}> {
  const [row] = await db('alpha')<{ teammate_id: string; conversation_id: string }[]>`
    select c.teammate_id, c.id as conversation_id from tw_messages m
    join tw_conversations c on c.id = m.conversation_id
    where m.owner_sub = ${ALICE}
    group by 1, 2 having count(*) filter (where m.card->>'kind' = 'result_ready') > 0
    order by count(*) asc limit 1`;
  if (row === undefined) throw new Error('alice has no result card in alpha');
  return { teammateId: row.teammate_id, conversationId: row.conversation_id };
}

export type Subject = {
  readonly taskId: string;
  readonly title: string;
  readonly teammateId: string;
  readonly latest: number;
  /** An evidence id cited by the latest revision, when it has one. */
  readonly cited: string | undefined;
};

/** Alice's most recent task with two or more revisions in `segment`, created by the journeys. */
export async function revisedTask(segment: 'alpha' | 'beta'): Promise<Subject | undefined> {
  const rows = await db(segment)<
    {
      id: string;
      title: string;
      teammate_id: string;
      latest_revision: number;
      evidence_ids: string[];
    }[]
  >`
    select t.id, t.title, c.teammate_id, t.latest_revision,
           coalesce((select r.evidence_ids from tw_revisions r
                     where r.task_id = t.id and r.revision = t.latest_revision), '[]'::jsonb) as evidence_ids
    from wb_tasks t
    join tw_conversations c on c.id = t.conversation_id
    where t.kind = 'teamwork' and t.owner_email = 'alice@local.test'
      and t.latest_revision >= 2 and t.status in ('ready', 'completed')
      and t.title not like 'ui-seed%'
      and exists (select 1 from tw_revisions r where r.task_id = t.id
                  and r.revision = t.latest_revision and jsonb_array_length(r.evidence_ids) > 0)
    order by t.updated_at desc limit 1`;
  const row = rows.at(0);
  if (row === undefined) return undefined;
  return {
    taskId: row.id,
    title: row.title,
    teammateId: row.teammate_id,
    latest: row.latest_revision,
    cited: row.evidence_ids.at(0),
  };
}

/** Alice's alpha conversation with the most messages, where earlier content needs scrolling. */
export async function busiestConversation(): Promise<{
  readonly teammateId: string;
  readonly conversationId: string;
}> {
  const [row] = await db('alpha')<{ teammate_id: string; conversation_id: string }[]>`
    select c.teammate_id, c.id as conversation_id from tw_messages m
    join tw_conversations c on c.id = m.conversation_id
    where m.owner_sub = ${ALICE} group by 1, 2 order by count(*) desc limit 1`;
  if (row === undefined) throw new Error('alice has no messages in alpha');
  return { teammateId: row.teammate_id, conversationId: row.conversation_id };
}

/** The CSRF token the page's own fetches carry, from the server-rendered bootstrap JSON. */
export async function csrfToken(page: Page): Promise<string> {
  return page.evaluate(() => {
    const json = document.getElementById('aw-bootstrap')?.textContent ?? '{}';
    return (JSON.parse(json) as { scope?: { csrf?: string } }).scope?.csrf ?? '';
  });
}

/** Posts to the BFF JSON API as the page would, with its CSRF token and origin. */
export async function apiPost(page: Page, path: string, body: unknown): Promise<APIResponse> {
  const origin = new URL(page.url()).origin;
  return page.request.post(path, {
    headers: {
      'content-type': 'application/json',
      origin,
      'x-csrf-token': await csrfToken(page),
    },
    data: body,
  });
}

export type Segment = 'alpha' | 'beta';

const memberSub = (member: Member): string => `local-test:${member.split('@')[0] ?? ''}`;

/** Alice's Coordinator in a segment: the one teammate whose template requests docs.publish. */
export async function coordinator(
  segment: Segment,
  member: Member = 'alice@local.test',
): Promise<{ readonly id: string; readonly conversationId: string }> {
  const [row] = await db(segment)<{ id: string; conversation_id: string }[]>`
    select id, conversation_id from tw_teammates
    where owner_sub = ${memberSub(member)} and name = 'Coordinator' and not archived
    order by created_at limit 1`;
  if (row === undefined) throw new Error(`${member} has no Coordinator in ${segment}`);
  return { id: row.id, conversationId: row.conversation_id };
}

export type SeededResult = {
  readonly taskId: string;
  readonly title: string;
  readonly teammateId: string;
  readonly conversationId: string;
};

/**
 * A ready task owned by the Coordinator with one revision whose summary carries `marker`, and
 * the result card in the Coordinator's conversation. The fixture store reads `[fault:...]`
 * markers from the published text, so a seeded summary drives the publish outcome without a
 * model call. A fresh id per call; the title names the marker so runs stay distinguishable.
 */
export async function seedResultTask(segment: Segment, marker: string): Promise<SeededResult> {
  const sql = db(segment);
  const owner = await coordinator(segment);
  const n = Date.now() % 1_000_000_000_000;
  const taskId = seedId(9, n);
  const title = `${SEED_PREFIX} publish ${marker.replaceAll(/[^a-z-]/g, '') || 'plain'} ${n}`;
  const now = new Date().toISOString();
  await sql`
    insert into wb_tasks (id, owner_sub, owner_email, client_request_id, title, objective, status, version,
      llm_mode, model_id, kind, segment, workflow, mode, result_owner, conversation_id, scope,
      latest_revision, created_at, updated_at)
    values (${taskId}, ${ALICE}, 'alice@local.test', ${seedId(10, n)}, ${title}, ${title}, 'ready', 1,
      'stub', 'ui-seed', 'teamwork', ${segment}, 'research_brief', 'manual', ${owner.id},
      ${owner.conversationId}, ${sql.json(scope(title))}, 1, ${now}, ${now})`;
  const content = {
    title,
    summary: `Seeded result for a publish check. ${marker}`.trim(),
    sections: [
      {
        heading: 'Summary',
        statements: [
          {
            kind: 'recommendation',
            text: 'This content exists only to exercise the publish path.',
            evidenceIds: [],
            calculationIds: [],
            support: 'not_required',
          },
        ],
      },
    ],
    limitations: [],
  };
  const generation = {
    modelId: 'ui-seed',
    modelVersion: 'ui-seed',
    responseId: null,
    planVersion: null,
    skills: [],
    repositoryRevision: null,
  };
  await sql`
    insert into tw_revisions (task_id, revision, parent, request, content, evidence_ids, calculations,
      unsupported, dropped_citations, missing_assignments, generation, diff, digest, created_at)
    values (${taskId}, 1, null, null, ${sql.json(content)}, '[]'::jsonb, '[]'::jsonb, 0, 0, '[]'::jsonb,
      ${sql.json(generation)}, null, ${'1'.repeat(52) + String(n).padStart(12, '0')}, ${now})`;
  const messageId = seedId(11, n);
  await sql`
    insert into tw_messages (id, conversation_id, owner_sub, client_request_id, role, body, task_id, card,
      reply_state, created_at)
    values (${messageId}, ${owner.conversationId}, ${ALICE}, ${`card:${taskId}:revision:1`}, 'system',
      ${`Revision 1 is ready: ${title}`}, ${taskId},
      ${sql.json({ kind: 'result_ready', taskId, title, ref: 'revision:1' })}, 'done', ${now})`;
  return { taskId, title, teammateId: owner.id, conversationId: owner.conversationId };
}

/**
 * A revision after the latest one, written the way a concurrent synthesis would: the row, the
 * task's latest_revision and a result card. The task status is left alone, so a pending approval
 * for the earlier revision becomes stale exactly as decideAction defines it.
 */
export async function seedNextRevision(segment: Segment, taskId: string): Promise<number> {
  const sql = db(segment);
  const [task] = await sql<
    { latest_revision: number; title: string; conversation_id: string | null }[]
  >`select latest_revision, title, conversation_id from wb_tasks where id = ${taskId}`;
  if (task === undefined) throw new Error(`task ${taskId} is missing`);
  const [latest] = await sql<{ content: Record<string, unknown>; generation: unknown }[]>`
    select content, generation from tw_revisions where task_id = ${taskId} and revision = ${task.latest_revision}`;
  if (latest === undefined) throw new Error(`task ${taskId} has no latest revision`);
  const next = task.latest_revision + 1;
  const now = new Date().toISOString();
  const content = {
    ...latest.content,
    limitations: [
      ...((latest.content.limitations as string[] | undefined) ?? []),
      `Revision ${next} was written after the approval for revision ${task.latest_revision} was requested.`,
    ],
  };
  await sql`
    insert into tw_revisions (task_id, revision, parent, request, content, evidence_ids, calculations,
      unsupported, dropped_citations, missing_assignments, generation, diff, digest, created_at)
    select task_id, ${next}, ${task.latest_revision}, 'ui-seed: concurrent revision', ${sql.json(content)},
      evidence_ids, calculations, unsupported, dropped_citations, missing_assignments, generation, null,
      ${'2'.repeat(52) + String(next).padStart(12, '0')}, ${now}
    from tw_revisions where task_id = ${taskId} and revision = ${task.latest_revision}`;
  await sql`update wb_tasks set latest_revision = ${next}, version = version + 1, updated_at = ${now} where id = ${taskId}`;
  if (task.conversation_id !== null)
    await sql`
      insert into tw_messages (id, conversation_id, owner_sub, client_request_id, role, body, task_id, card,
        reply_state, created_at)
      values (${seedId(12, Date.now() % 1_000_000_000_000)}, ${task.conversation_id}, ${ALICE},
        ${`card:${taskId}:revision:${next}`}, 'system', ${`Revision ${next} is ready: ${task.title}`}, ${taskId},
        ${sql.json({ kind: 'result_ready', taskId, title: task.title, ref: `revision:${next}` })}, 'done', ${now})
      on conflict do nothing`;
  return next;
}

export type ApprovalRow = {
  readonly id: string;
  readonly state: string;
  readonly revision: number;
  readonly digest: string;
  readonly expiresAt: Date;
  readonly actionStatus: string | null;
  readonly externalId: string | null;
};

export async function approvalsOf(segment: Segment, taskId: string): Promise<ApprovalRow[]> {
  const rows = await db(segment)<
    {
      id: string;
      state: string;
      subject_ref: number;
      payload_sha256: string;
      expires_at: Date;
      action_status: string | null;
      external_id: string | null;
    }[]
  >`
    select ap.id, ap.state, ap.subject_ref, ap.payload_sha256, ap.expires_at,
           ac.status as action_status, ac.external_id
    from wb_approvals ap left join wb_actions ac on ac.approval_id = ap.id
    where ap.task_id = ${taskId} and ap.subject = 'publish' order by ap.requested_at`;
  return rows.map((r) => ({
    id: r.id,
    state: r.state,
    revision: r.subject_ref,
    digest: r.payload_sha256,
    expiresAt: r.expires_at,
    actionStatus: r.action_status,
    externalId: r.external_id,
  }));
}

/** Moves a pending approval's deadline into the past, as an hour of inactivity would. */
export async function expireApproval(segment: Segment, approvalId: string): Promise<void> {
  await db(segment)`
    update wb_approvals set expires_at = now() - interval '1 minute' where id = ${approvalId} and state = 'pending'`;
}

export async function fixtureDocsOf(
  segment: Segment,
  taskId: string,
): Promise<readonly { readonly docId: string; readonly markdown: string }[]> {
  const rows = await db(segment)<{ doc_id: string; body: { markdown: string } }[]>`
    select f.doc_id, f.body from wb_fixture_docs f
    join wb_actions ac on ac.idempotency_key = f.idempotency_key where ac.task_id = ${taskId}`;
  return rows.map((r) => ({ docId: r.doc_id, markdown: r.body.markdown }));
}

export async function inboxOf(
  segment: Segment,
  taskId: string,
): Promise<readonly { readonly kind: string; readonly ref: string; readonly state: string }[]> {
  return db(segment)<{ kind: string; ref: string; state: string }[]>`
    select kind, ref, state from tw_inbox where task_id = ${taskId} order by created_at`;
}

export async function taskRow(
  segment: Segment,
  taskId: string,
): Promise<{ readonly status: string; readonly latestRevision: number; readonly version: number }> {
  const [row] = await db(segment)<{ status: string; latest_revision: number; version: number }[]>`
    select status, latest_revision, version from wb_tasks where id = ${taskId}`;
  if (row === undefined) throw new Error(`task ${taskId} is missing`);
  return { status: row.status, latestRevision: row.latest_revision, version: row.version };
}

/** Sent real-model calls for one task under the UI campaign, newest last. */
export async function modelCallsOf(
  segment: Segment,
  taskId: string,
): Promise<readonly { readonly purpose: string; readonly at: Date; readonly outcome: string }[]> {
  return db(segment)<{ purpose: string; at: Date; outcome: string }[]>`
    select purpose, at, outcome from wb_model_calls
    where task_id = ${taskId} and mode = 'vertex' and sent order by id`;
}

export async function campaignCalls(segment: Segment): Promise<number> {
  const [row] = await db(segment)<{ n: number }[]>`
    select count(*)::int as n from wb_model_calls
    where mode = 'vertex' and sent and campaign = 'ui-2026-10'`;
  return row?.n ?? 0;
}

const ROW_COPY = (table: string, overrides: Record<string, unknown>, where: string) => ({
  table,
  overrides,
  where,
});

/**
 * Copies one row with some columns replaced, whatever the table's columns are, so a clone follows
 * schema changes without a column list here. `where` is a fragment over alias `r`.
 */
async function copyRow(
  sql: ReturnType<typeof db>,
  copy: ReturnType<typeof ROW_COPY>,
  params: readonly unknown[],
): Promise<void> {
  await sql.unsafe(
    `insert into ${copy.table}
     select (jsonb_populate_record(null::${copy.table}, to_jsonb(r) || $1::text::jsonb)).*
     from ${copy.table} r where ${copy.where}`,
    [JSON.stringify(copy.overrides), ...params] as never[],
  );
}

export type ClonedTask = {
  readonly taskId: string;
  readonly title: string;
  readonly teammateId: string;
  readonly conversationId: string;
  /** Old assignment id to new assignment id. */
  readonly assignments: ReadonlyMap<string, string>;
};

/**
 * A fresh copy of a task that stopped for the member (a question, or a failed contribution), in
 * the Coordinator's conversation with the same assignments, plan, evidence, inbox item and cards
 * under new ids. The original stays untouched, so the recovery specs rerun on real M1 data without
 * consuming it. Answering or proceeding on the copy runs real work, so it spends calls.
 */
export async function cloneStoppedTask(
  segment: Segment,
  sourceTaskId: string,
): Promise<ClonedTask> {
  const sql = db(segment);
  const owner = await coordinator(segment);
  const n = Date.now() % 1_000_000_000_000;
  const taskId = seedId(13, n);
  const [source] = await sql<
    { title: string }[]
  >`select title from wb_tasks where id = ${sourceTaskId}`;
  if (source === undefined) throw new Error(`task ${sourceTaskId} is missing`);
  const title = `${SEED_PREFIX} copy ${n}: ${source.title}`.slice(0, 200);
  const now = new Date().toISOString();
  await copyRow(
    sql,
    ROW_COPY(
      'wb_tasks',
      {
        id: taskId,
        title,
        client_request_id: seedId(14, n),
        conversation_id: owner.conversationId,
        result_owner: owner.id,
        version: 1,
        created_at: now,
        updated_at: now,
      },
      'r.id = $2',
    ),
    [sourceTaskId],
  );
  const rows = await sql<
    { id: string; status: string; question: string | null; attempt: number }[]
  >`
    select id, status, question, attempt from tw_assignments
    where task_id = ${sourceTaskId} and status <> 'superseded' order by created_at`;
  const assignments = new Map<string, string>();
  for (const [i, row] of rows.entries()) {
    const id = seedId(15, n + i);
    assignments.set(row.id, id);
    await copyRow(
      sql,
      ROW_COPY('tw_assignments', { id, task_id: taskId, updated_at: now }, 'r.id = $2'),
      [row.id],
    );
  }
  await copyRow(sql, ROW_COPY('tw_plans', { task_id: taskId }, 'r.task_id = $2'), [sourceTaskId]);
  const evidence = await sql<{ assignment_id: string | null; id: string; attempt: number }[]>`
    select assignment_id, id, attempt from wb_evidence where task_id = ${sourceTaskId}`;
  for (const row of evidence)
    await copyRow(
      sql,
      ROW_COPY(
        'wb_evidence',
        {
          task_id: taskId,
          assignment_id:
            row.assignment_id === null ? null : (assignments.get(row.assignment_id) ?? null),
        },
        'r.task_id = $2 and r.id = $3 and r.attempt = $4',
      ),
      [sourceTaskId, row.id, row.attempt],
    );
  const items = await sql<{ kind: string; ref: string; summary: string }[]>`
    select kind, ref, summary from tw_inbox where task_id = ${sourceTaskId} and state = 'open'`;
  let m = 0;
  for (const item of items) {
    let ref = item.ref;
    for (const [from, to] of assignments) ref = ref.replaceAll(from, to);
    await sql`
      insert into tw_inbox (id, owner_sub, task_id, kind, ref, summary, state, created_at)
      values (${seedId(16, n + m)}, ${ALICE}, ${taskId}, ${item.kind}, ${ref}, ${item.summary}, 'open', ${now})`;
    await sql`
      insert into tw_messages (id, conversation_id, owner_sub, client_request_id, role, body, task_id, card,
        reply_state, created_at)
      values (${seedId(17, n + m)}, ${owner.conversationId}, ${ALICE}, ${`card:${taskId}:${ref}`}, 'system',
        ${item.summary}, ${taskId}, ${sql.json({ kind: item.kind, taskId, title, ref })}, 'done', ${now})`;
    m += 1;
  }
  await sql`
    insert into tw_messages (id, conversation_id, owner_sub, client_request_id, role, body, task_id, card,
      reply_state, created_at)
    values (${seedId(18, n)}, ${owner.conversationId}, ${ALICE}, ${`card:${taskId}:created`}, 'system',
      ${`Task started: ${title}`}, ${taskId}, ${sql.json({ kind: 'task_created', taskId, title })}, 'done',
      ${new Date(Date.parse(now) - 1000).toISOString()})`;
  return { taskId, title, teammateId: owner.id, conversationId: owner.conversationId, assignments };
}

/** The newest task of alice that waits on `what`: an open question, or a failed contribution. */
export async function stoppedTask(
  segment: Segment,
  what: 'question' | 'missing',
): Promise<string | undefined> {
  const status = what === 'question' ? 'needs_input' : 'failed';
  const rows = await db(segment)<{ id: string }[]>`
    select t.id from wb_tasks t
    where t.owner_sub = ${ALICE} and t.kind = 'teamwork' and t.status = 'needs_input'
      and t.title not like ${`${SEED_PREFIX}%`}
      and exists (select 1 from tw_assignments a where a.task_id = t.id and a.status = ${status}
                  and (${what} <> 'question' or a.question is not null))
      and exists (select 1 from tw_assignments a where a.task_id = t.id and a.status = 'succeeded')
    order by t.updated_at desc limit 1`;
  return rows[0]?.id;
}
