import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createSealer } from '@agent-works/domain/sealer';
import postgres from 'postgres';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { startDisposablePostgres } from '../ledger/disposable-postgres.js';
import { applyWorkbenchMigration } from '../workbench/migration.js';

import {
  createStarterTeam,
  customizeSkill,
  exportTeammate,
  importTeammate,
  listSkills,
  listTeammates,
  setSkill,
  updateTeammate,
  seedCatalog,
} from './catalog.js';
import { readSegmentConfig } from './config.js';
import { Conflict } from './context.js';
import { createModelGate } from './model.js';
import { createFixtureSources } from './sources/fixture.js';
import {
  createTask,
  decideAction,
  decideMissing,
  decidePlan,
  editPlan,
  followUp,
  inbox,
  preparePublish,
  reconcileTask,
  taskDetail,
} from './tasks.js';
import { createWorker } from './worker.js';

import type { Deps, Member } from './context.js';
import type { DisposablePostgres } from '../ledger/disposable-postgres.js';
import type { GenerateRequest, ModelPort } from '../workbench/model-port.js';

/**
 * State-machine and policy tests with a scripted model port. These prove the invariants (no
 * dispatch before approval, version binding, budget, isolation, privacy); they are not evidence
 * of live reasoning, which only the live suites provide.
 */
const alice: Member = { sub: 'local-test:alice', email: 'alice@local.test' };
const bob: Member = { sub: 'local-test:bob', email: 'bob@local.test' };
const root = new URL('../../../../', import.meta.url).pathname;

let database: DisposablePostgres | undefined;
let sql: postgres.Sql;
const purposes: string[] = [];

function scripted(): ModelPort {
  return {
    mode: 'vertex',
    modelId: 'gemini-3.8-flash',
    generate(request: GenerateRequest) {
      const schema = JSON.stringify(request.jsonSchema ?? {});
      const reply = (value: unknown) =>
        Promise.resolve({
          text: JSON.stringify(value),
          modelVersion: 'gemini-3.8-flash',
          responseId: `r${purposes.length}`,
          latencyMs: 5,
        });
      if (schema.includes('"expectedEffects"')) {
        purposes.push('plan');
        const roster = JSON.parse(/Roster: (\[.*\])/.exec(request.prompt)?.[1] ?? '[]') as {
          id: string;
          capabilities: string[];
        }[];
        const readers = roster.filter((r) => r.capabilities.includes('drive.read')).slice(0, 2);
        return reply({
          summary: 'Two readers in parallel',
          assignments: readers.map((r, i) => ({
            key: `part-${i + 1}`,
            teammateId: r.id,
            brief: 'Compare the options',
            deliverable: 'Cited findings',
            sources: ['drive_research', 'github_code'],
            dependsOn: [],
          })),
          expectedEffects: [],
        });
      }
      if (schema.includes('"limitations"')) {
        purposes.push('synthesis');
        const headings = [
          ...(
            /exactly these section headings, in this order: (.*)\./.exec(request.system)?.[1] ??
            '"Findings"'
          ).matchAll(/"([^"]+)"/g),
        ].map((m) => m[1]);
        const revised = request.prompt.includes('Member revision request');
        return reply({
          title: revised ? 'Brief (revised)' : 'Brief',
          summary: revised ? 'Revised summary' : 'Summary',
          sections: headings.map((heading) => ({
            heading,
            statements: [
              {
                kind: 'recommendation',
                text: `${heading}${revised ? ' revised' : ''}`,
                evidenceIds: ['E1'],
                calculationIds: [],
              },
            ],
          })),
          limitations: [],
        });
      }
      if (schema.includes('"gaps"')) {
        purposes.push('contribution');
        return reply({
          summary: 'Findings',
          statements: [
            {
              kind: 'fact',
              text: 'Togglr costs USD 600 per month for every seat tier.',
              evidenceIds: ['E1'],
              calculationIds: [],
            },
            {
              kind: 'recommendation',
              text: 'Prefer the option with EU residency.',
              evidenceIds: ['E1', 'E99'],
              calculationIds: [],
            },
          ],
          gaps: [],
          question: '',
        });
      }
      purposes.push('reply');
      return reply('ok');
    },
  };
}

function deps(limit = 50): Deps {
  const config = readSegmentConfig({
    AW_SEGMENT_ID: 'alpha',
    AW_IDENTITY: 'local-test',
    AW_SOURCE_MODE: 'fixture',
    AW_LOCAL_TEST_MEMBERS: 'alice@local.test,bob@local.test',
    AW_KEY_DIR: mkdtempSync(join(tmpdir(), 'tw-keys-')),
    AW_MAX_MODEL_CALLS: String(limit),
  });
  return {
    sql,
    config,
    gate: createModelGate({
      sql,
      segment: 'alpha',
      model: scripted(),
      limit,
      now: () => new Date(),
      sleep: () => Promise.resolve(),
    }),
    sources: createFixtureSources({ root, segment: 'alpha', sql, faults: true }),
    sealer: createSealer(Buffer.alloc(32, 1), 'test'),
    now: () => new Date(),
    newId: () => crypto.randomUUID(),
    fetch,
  };
}

beforeAll(async () => {
  database = await startDisposablePostgres();
  // Same client options as the segment API, which relies on array type inference.
  sql = postgres(database.url, { onnotice: () => undefined });
  await applyWorkbenchMigration(sql);
}, 60_000);

afterAll(async () => {
  await sql.end({ timeout: 1 });
  await database?.stop();
});

beforeEach(async () => {
  purposes.length = 0;
  await sql`truncate wb_tasks, wb_model_calls, wb_fixture_docs, tw_teammates, tw_conversations, tw_messages, tw_audit, tw_jobs, tw_connections cascade`;
});

async function team(d: Deps, member: Member) {
  await seedCatalog(d);
  const teammates = await createStarterTeam(d, member);
  const by = (name: string) => teammates.find((t) => t.name === name)?.id ?? '';
  return {
    coordinator: by('Coordinator'),
    research: by('Research analyst'),
    risk: by('Risk and compliance reviewer'),
  };
}

const research = (
  resultOwner: string,
  mode: 'manual' | 'coordinated',
  assignments: { teammateId: string; brief: string; sources: ['drive_research'] }[] = [],
  question = 'Which feature-flag service should we adopt?',
) => ({
  clientRequestId: crypto.randomUUID(),
  workflow: 'research_brief' as const,
  mode,
  scope: { question, metrics: null, repository: null, issueNumber: null },
  resultOwner,
  conversationId: null,
  assignments,
});

const fixedToken = () => Promise.resolve('x');

async function jobs(kind: string): Promise<number> {
  return Number((await sql`select count(*)::int as n from tw_jobs where kind = ${kind}`).at(0)?.n);
}

describe('coordinator planning', () => {
  it('proposes with a real planning call, dispatches nothing before version-bound approval', async () => {
    const d = deps();
    const ids = await team(d, alice);
    const worker = createWorker(d, (error) => {
      throw error;
    });
    const { task } = await createTask(d, alice, research(ids.coordinator, 'coordinated'));
    await worker.drain();
    let detail = await taskDetail(d, alice, task.id);
    expect(detail?.task.status).toBe('plan_review');
    expect(purposes).toEqual(['plan']);
    expect(await jobs('assignment')).toBe(0);
    expect(detail?.assignments).toEqual([]);
    const plan = detail?.plans[0];
    // github_code is not a research source and the readers cannot use it; policy strips it.
    expect(plan?.content.assignments.every((a) => a.sources.join() === 'drive_research')).toBe(
      true,
    );
    await expect(
      decidePlan(d, alice, task.id, {
        version: 1,
        expectedDigest: '0'.repeat(64),
        decision: 'approve',
      }),
    ).rejects.toThrow('stale_plan');
    await editPlan(d, alice, task.id, {
      baseVersion: 1,
      content: { ...plan!.content, assignments: plan!.content.assignments.slice(0, 1) },
    });
    await expect(
      decidePlan(d, alice, task.id, {
        version: 1,
        expectedDigest: plan!.digest,
        decision: 'approve',
      }),
    ).rejects.toThrow('plan_not_current');
    expect(await jobs('assignment')).toBe(0);
    detail = await taskDetail(d, alice, task.id);
    const v2 = detail!.plans.find((p) => p.version === 2)!;
    await decidePlan(d, alice, task.id, {
      version: 2,
      expectedDigest: v2.digest,
      decision: 'approve',
    });
    await worker.drain();
    detail = await taskDetail(d, alice, task.id);
    expect(detail?.assignments.map((a) => a.planVersion)).toEqual([2]);
    expect([detail?.task.status, detail?.task.errorCode]).toEqual(['ready', null]);
    expect(purposes).toEqual(['plan', 'contribution', 'synthesis']);
  });

  it('records no work after rejection', async () => {
    const d = deps();
    const ids = await team(d, alice);
    const worker = createWorker(d, () => undefined);
    const { task } = await createTask(d, alice, research(ids.coordinator, 'coordinated'));
    await worker.drain();
    const plan = (await taskDetail(d, alice, task.id))!.plans[0];
    await decidePlan(d, alice, task.id, {
      version: 1,
      expectedDigest: plan.digest,
      decision: 'reject',
    });
    await worker.drain();
    expect((await taskDetail(d, alice, task.id))?.task.status).toBe('declined');
    expect(await jobs('assignment')).toBe(0);
  });
});

describe('manual work, evidence and revisions', () => {
  it('marks unsupported numbers, drops unknown citations, versions revisions and binds publication to one revision', async () => {
    const d = deps();
    const ids = await team(d, alice);
    const worker = createWorker(d, () => undefined);
    const { task } = await createTask(
      d,
      alice,
      research(ids.coordinator, 'manual', [
        { teammateId: ids.research, brief: 'Prices', sources: ['drive_research'] },
        { teammateId: ids.risk, brief: 'Conflicts', sources: ['drive_research'] },
      ]),
    );
    await worker.drain();
    let detail = (await taskDetail(d, alice, task.id))!;
    expect(detail.task.status).toBe('ready');
    const contribution = detail.assignments[0].output!;
    expect(contribution.statements[0]).toMatchObject({ kind: 'fact', support: 'unsupported' });
    expect(contribution.statements[1]?.evidenceIds).toEqual(['E1']);
    expect(detail.revisions[0]?.content.sections.map((s) => s.heading)).toEqual([
      'Alternatives',
      'Comparison',
      'Conclusion',
      'Unresolved questions',
    ]);
    // Both specialists read the same folder; each document is recorded once for the task.
    expect(new Set(detail.evidence.map((e) => e.sourceId)).size).toBe(detail.evidence.length);

    await preparePublish(d, alice, task.id, 1);
    detail = (await taskDetail(d, alice, task.id))!;
    const first = detail.approvals.find((a) => a.state === 'pending')!;
    expect(first.proposal.contentMarkdown).toContain('Brief');
    await decideAction(d, alice, task.id, {
      approvalId: first.id,
      expectedDigest: first.digest,
      decision: 'reject',
    });
    expect(Number((await sql`select count(*)::int as n from wb_fixture_docs`).at(0)?.n)).toBe(0);

    await followUp(d, alice, task.id, {
      clientRequestId: crypto.randomUUID(),
      kind: 'revise',
      text: 'Treat the SLA as unresolved',
      assignmentId: null,
      metrics: null,
    });
    await worker.drain();
    detail = (await taskDetail(d, alice, task.id))!;
    expect(detail.revisions.map((r) => r.revision)).toEqual([1, 2]);
    expect(detail.revisions[0]?.content.title).toBe('Brief');
    expect(detail.revisions[1]?.diff?.changedSections).toContain('Conclusion');
    await expect(preparePublish(d, alice, task.id, 1)).rejects.toThrow('stale_revision');

    await preparePublish(d, alice, task.id, 2);
    detail = (await taskDetail(d, alice, task.id))!;
    const second = detail.approvals.find((a) => a.state === 'pending')!;
    await expect(
      decideAction(d, alice, task.id, {
        approvalId: second.id,
        expectedDigest: first.digest,
        decision: 'approve',
      }),
    ).rejects.toThrow('stale_digest');
    await decideAction(d, alice, task.id, {
      approvalId: second.id,
      expectedDigest: second.digest,
      decision: 'approve',
    });
    await expect(
      decideAction(d, alice, task.id, {
        approvalId: second.id,
        expectedDigest: second.digest,
        decision: 'approve',
      }),
    ).rejects.toThrow('already_decided');
    await worker.drain();
    detail = (await taskDetail(d, alice, task.id))!;
    expect(detail.task.status).toBe('completed');
    expect(Number((await sql`select count(*)::int as n from wb_fixture_docs`).at(0)?.n)).toBe(1);
    expect((await inbox(d, alice)).filter((i) => i.state === 'open').map((i) => i.kind)).toEqual([
      'completed',
    ]);
  });

  it('reconciles an uncertain write without a second document', async () => {
    const d = deps();
    const ids = await team(d, alice);
    const worker = createWorker(d, () => undefined);
    const { task } = await createTask(
      d,
      alice,
      research(
        ids.coordinator,
        'manual',
        [{ teammateId: ids.research, brief: 'Prices', sources: ['drive_research'] }],
        'Compare vendors [fault:publish-uncertain]',
      ),
    );
    await worker.drain();
    await sql`update tw_revisions set content = jsonb_set(content, '{summary}', '"Summary [fault:publish-uncertain]"') where task_id = ${task.id}`;
    await preparePublish(d, alice, task.id, 1);
    const approval = (await taskDetail(d, alice, task.id))!.approvals[0];
    await decideAction(d, alice, task.id, {
      approvalId: approval.id,
      expectedDigest: approval.digest,
      decision: 'approve',
    });
    await worker.drain();
    expect((await taskDetail(d, alice, task.id))?.task.status).toBe('outcome_uncertain');
    await reconcileTask(d, alice, task.id, (key) => d.sources.findPublished(fixedToken, key));
    expect((await taskDetail(d, alice, task.id))?.task.status).toBe('completed');
    expect(Number((await sql`select count(*)::int as n from wb_fixture_docs`).at(0)?.n)).toBe(1);
  });

  it('asks the member about missing contributions and states the limitation when proceeding', async () => {
    const d = deps();
    const ids = await team(d, alice);
    const worker = createWorker(d, () => undefined);
    const { task } = await createTask(
      d,
      alice,
      research(
        ids.coordinator,
        'manual',
        [{ teammateId: ids.research, brief: 'Prices', sources: ['drive_research'] }],
        'Compare [fault:denied]',
      ),
    );
    await worker.drain();
    let detail = (await taskDetail(d, alice, task.id))!;
    expect(detail.task.status).toBe('needs_input');
    expect(detail.assignments[0]?.errorCode).toBe('source_denied');
    await expect(
      decideMissing(d, alice, task.id, { decision: 'proceed', assignmentIds: [] }),
    ).rejects.toThrow('nothing_to_synthesize');
    expect((await inbox(d, alice)).some((i) => i.kind === 'question' && i.state === 'open')).toBe(
      true,
    );
    await decideMissing(d, alice, task.id, { decision: 'retry', assignmentIds: [] });
    detail = (await taskDetail(d, alice, task.id))!;
    expect(detail.assignments[0]?.attempt).toBe(2);
  });
});

describe('review regressions', () => {
  it('holds a dependent assignment until its dependency succeeds, then gives it that contribution', async () => {
    const d = deps();
    const ids = await team(d, alice);
    const worker = createWorker(d, () => undefined);
    const { task } = await createTask(d, alice, research(ids.coordinator, 'coordinated'));
    await worker.drain();
    const plan = (await taskDetail(d, alice, task.id))!.plans[0];
    const [first, second] = plan.content.assignments;
    await editPlan(d, alice, task.id, {
      baseVersion: 1,
      content: { ...plan.content, assignments: [first, { ...second, dependsOn: [first.key] }] },
    });
    const v2 = (await taskDetail(d, alice, task.id))!.plans.find((p) => p.version === 2)!;
    await decidePlan(d, alice, task.id, {
      version: 2,
      expectedDigest: v2.digest,
      decision: 'approve',
    });
    expect(await jobs('assignment'), 'only the independent assignment starts').toBe(1);
    await worker.drain();
    const detail = (await taskDetail(d, alice, task.id))!;
    expect(detail.assignments.map((a) => a.status)).toEqual(['succeeded', 'succeeded']);
    const [a, b] = detail.assignments;
    expect(new Date(b.startedAt!).getTime()).toBeGreaterThanOrEqual(
      new Date(a.finishedAt!).getTime(),
    );
  });

  it('returns the same task for concurrent submits of one form', async () => {
    const d = deps();
    const ids = await team(d, alice);
    const input = research(ids.coordinator, 'coordinated');
    const [one, two] = await Promise.all([
      createTask(d, alice, input),
      createTask(d, alice, input),
    ]);
    expect(one.task.id).toBe(two.task.id);
    expect([one.created, two.created].sort((x, y) => Number(x) - Number(y))).toEqual([false, true]);
  });

  it('keeps a published task completed when a later publication is rejected', async () => {
    const d = deps();
    const ids = await team(d, alice);
    const worker = createWorker(d, () => undefined);
    const { task } = await createTask(
      d,
      alice,
      research(ids.coordinator, 'manual', [
        { teammateId: ids.research, brief: 'Prices', sources: ['drive_research'] },
      ]),
    );
    await worker.drain();
    await preparePublish(d, alice, task.id, 1);
    let approval = (await taskDetail(d, alice, task.id))!.approvals.at(-1)!;
    await decideAction(d, alice, task.id, {
      approvalId: approval.id,
      expectedDigest: approval.digest,
      decision: 'approve',
    });
    await worker.drain();
    await preparePublish(d, alice, task.id, 1);
    approval = (await taskDetail(d, alice, task.id))!.approvals.at(-1)!;
    await decideAction(d, alice, task.id, {
      approvalId: approval.id,
      expectedDigest: approval.digest,
      decision: 'reject',
    });
    expect((await taskDetail(d, alice, task.id))?.task.status).toBe('completed');
  });
});

describe('budget, isolation and privacy', () => {
  it('fails closed at the call cap and never exceeds it', async () => {
    const d = deps(1);
    const ids = await team(d, alice);
    const worker = createWorker(d, () => undefined);
    const { task } = await createTask(
      d,
      alice,
      research(ids.coordinator, 'manual', [
        { teammateId: ids.research, brief: 'Prices', sources: ['drive_research'] },
      ]),
    );
    await worker.drain();
    const detail = (await taskDetail(d, alice, task.id))!;
    expect(detail.task.status).toBe('failed');
    expect(detail.task.errorCode).toBe('budget_exhausted');
    expect(await d.gate.used()).toBe(1);
  });

  it('hides another member’s work as not found', async () => {
    const d = deps();
    const ids = await team(d, alice);
    await team(d, bob);
    const { task } = await createTask(d, alice, research(ids.coordinator, 'coordinated'));
    expect(await taskDetail(d, bob, task.id)).toBeUndefined();
    await expect(
      decidePlan(d, bob, task.id, {
        version: 1,
        expectedDigest: '0'.repeat(64),
        decision: 'approve',
      }),
    ).rejects.toBeInstanceOf(Conflict);
    await expect(createTask(d, bob, research(ids.coordinator, 'coordinated'))).rejects.toThrow(
      'teammate_not_found',
    );
  });

  it('keeps curated skills immutable and private copies per member', async () => {
    const d = deps();
    const ids = await team(d, alice);
    await team(d, bob);
    const curated = (await listSkills(d, alice)).find(
      (s) => s.origin === 'curated' && s.definition.name === 'Evidence-first comparison',
    )!;
    const copy = await customizeSkill(d, alice, {
      fromSkillId: curated.id,
      fromVersion: curated.version,
      definition: { ...curated.definition, name: 'Alice comparison' },
    });
    expect(copy.origin).toBe('private');
    await setSkill(d, alice, ids.research, {
      skillId: copy.id,
      version: copy.version,
      attach: true,
    });
    await setSkill(d, alice, ids.risk, { skillId: copy.id, version: copy.version, attach: true });
    expect((await listSkills(d, alice)).find((s) => s.id === copy.id)?.attachedTo).toHaveLength(2);
    expect((await listSkills(d, alice)).find((s) => s.id === curated.id)?.definition.name).toBe(
      'Evidence-first comparison',
    );
    expect((await listSkills(d, bob)).some((s) => s.id === copy.id)).toBe(false);
    const v2 = await customizeSkill(d, alice, {
      fromSkillId: copy.id,
      fromVersion: 1,
      definition: { ...copy.definition, summary: 'Changed' },
    });
    expect(v2).toMatchObject({ id: copy.id, version: 2 });
    const teammate = (await listTeammates(d, alice)).find((t) => t.id === ids.research)!;
    expect(teammate.skills.find((s) => s.id === copy.id)?.version).toBe(1);
  });

  it('exports definitions only and imports as the recipient', async () => {
    const d = deps();
    const ids = await team(d, alice);
    await team(d, bob);
    const canaryTask = 'CANARY-TASK-7f3a private question';
    await createTask(
      d,
      alice,
      research(
        ids.coordinator,
        'manual',
        [{ teammateId: ids.research, brief: 'CANARY-BRIEF-91c2', sources: ['drive_research'] }],
        canaryTask,
      ),
    );
    await sql`insert into tw_connections (owner_sub, provider, account, scopes, sealed_access, status, connected_at, updated_at) values (${alice.sub}, 'github', 'alice-gh-canary', '[]', 'sealed-canary', 'active', now(), now())`;
    const teammate = (await listTeammates(d, alice)).find((t) => t.id === ids.research)!;
    const clean = await exportTeammate(d, alice, ids.research);
    expect(clean.findings).toEqual([]);
    for (const canary of [
      canaryTask,
      'CANARY-BRIEF-91c2',
      'alice-gh-canary',
      'sealed-canary',
      alice.email,
      alice.sub,
      teammate.conversationId,
    ])
      expect(clean.json).not.toContain(canary);
    const leaky = `Use token ${['ghp', 'a'.repeat(36)].join('_')} and mail alice@local.test`;
    await updateTeammate(d, alice, ids.research, {
      expectedVersion: teammate.version,
      name: teammate.name,
      role: teammate.role,
      instructions: leaky,
    });
    const blocked = await exportTeammate(d, alice, ids.research);
    expect(blocked.findings.map((f) => f.kind).sort()).toEqual([
      'email',
      'private_identifier',
      'secret',
    ]);
    const imported = await importTeammate(d, bob, clean.json, crypto.randomUUID());
    expect(imported.teammate.origin).toBe('imported');
    expect(
      (await sql`select owner_sub from tw_teammates where id = ${imported.teammate.id}`).at(0)
        ?.owner_sub,
    ).toBe(bob.sub);
    expect(
      await taskDetail(
        d,
        bob,
        (await sql`select id from wb_tasks where owner_sub = ${alice.sub}`).at(0)?.id as string,
      ),
    ).toBeUndefined();
    await expect(
      importTeammate(
        d,
        bob,
        JSON.stringify({ ...clean.definition, connections: [{ token: 'x' }] }),
        crypto.randomUUID(),
      ),
    ).rejects.toThrow('invalid_definition');
  });
});
