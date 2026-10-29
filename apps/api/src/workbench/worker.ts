import { safeWorkbenchUrl, workbenchActionProposalSchema } from '@agent-works/domain/workbench';

import { createScheduleWorker } from '../scheduling/worker.js';

import { ModelError, modelRemediation } from './model-port.js';
import {
  approvalDigest,
  documentFor,
  proposalFor,
  reportRequest,
  validateReport,
} from './report.js';
import {
  appendEvent,
  approvalTtlMs,
  ensureBudget,
  event,
  lockTask,
  move,
  recordModelCall,
  transition,
} from './service.js';
import { WorkspaceError, faultsIn } from './workspace.js';

import type { GenerateResult, ModelPort } from './model-port.js';
import type { DocumentBody } from './report.js';
import type { WorkbenchDeps } from './service.js';
import type { DriveHit } from './workspace.js';
import type { WorkbenchEvidence, WorkbenchStatus } from '@agent-works/domain/workbench';
import type postgres from 'postgres';

type Claimed = {
  id: string;
  owner_sub: string;
  owner_email: string | null;
  objective: string;
  status: WorkbenchStatus;
  attempt: number;
  lease_token: string;
};

type Draft = {
  readonly model: ModelPort;
  readonly result: GenerateResult;
  readonly validated: ReturnType<typeof validateReport>;
  readonly evidence: readonly WorkbenchEvidence[];
};

const leaseSeconds = 180;

const plural = (count: number, noun: string): string => `${count} ${noun}${count === 1 ? '' : 's'}`;

export type WorkerOptions = {
  readonly deps: WorkbenchDeps;
  readonly pollMs?: number;
  readonly onError?: (error: unknown) => void;
};

async function claim(sql: postgres.Sql): Promise<Claimed | undefined> {
  const rows = await sql<Claimed[]>`
    update wb_tasks set lease_until = now() + make_interval(secs => ${leaseSeconds}),
      lease_token = gen_random_uuid()
    where id = (
      select id from wb_tasks
      where status in ('queued', 'running', 'cancel_requested', 'executing')
        and (lease_until is null or lease_until < now())
      order by updated_at
      limit 1
      for update skip locked
    )
    returning id, owner_sub, owner_email, objective, status, attempt, lease_token
  `;
  return rows.at(0);
}

/**
 * An unexpected error must end the task, or the next tick re-claims it forever and re-spends
 * model calls. A write that may have been sent becomes uncertain rather than failed.
 */
async function quarantine(deps: WorkbenchDeps, task: Claimed): Promise<void> {
  if (task.status === 'executing') {
    await transition(deps, task.id, 'executing', {
      to: 'outcome_uncertain',
      events: [
        {
          type: 'action.uncertain',
          summary: 'An internal error interrupted the write. Reconcile before retrying.',
        },
      ],
      error: {
        code: 'outcome_uncertain',
        message:
          'An internal error interrupted the write. Reconcile checks for the document first.',
      },
    });
    return;
  }
  await fail(
    deps,
    task.id,
    'running',
    'internal_error',
    'An internal error stopped this task. Nothing was written. Retry it; reads are safe to repeat.',
  );
}

async function stopIfCancelled(deps: WorkbenchDeps, id: string): Promise<boolean> {
  return transition(deps, id, 'cancel_requested', {
    to: 'cancelled',
    events: [
      {
        type: 'task.cancelled',
        summary: 'Task cancelled at a step boundary. Nothing was written.',
      },
    ],
  });
}

async function fail(
  deps: WorkbenchDeps,
  id: string,
  from: WorkbenchStatus,
  code: string,
  message: string,
): Promise<void> {
  const moved = await transition(deps, id, from, {
    to: 'failed',
    events: [{ type: 'task.failed', summary: message, detail: { code } }],
    error: { code, message },
  });
  if (!moved) await stopIfCancelled(deps, id);
}

/** Drive search with its events; undefined means the task was already failed. */
async function retrieve(
  deps: WorkbenchDeps,
  task: Claimed,
): Promise<readonly DriveHit[] | undefined> {
  const faults = faultsIn(task.objective, deps.faultsEnabled);
  await event(deps, task.id, {
    type: 'retrieval.started',
    summary: 'Searching Drive documents you can read (simulated fixture)',
  });
  const searchStart = Date.now();
  let hits: readonly DriveHit[];
  try {
    hits = await deps.workspace.search(task.owner_sub, task.objective, faults);
  } catch (error) {
    if (!(error instanceof WorkspaceError)) throw error;
    await event(deps, task.id, {
      type: 'retrieval.denied',
      summary: 'Drive denied access to the requested documents',
      durationMs: Date.now() - searchStart,
    });
    await fail(
      deps,
      task.id,
      'running',
      'drive_denied',
      'Drive access was denied. Check that you can open the documents, then retry.',
    );
    return undefined;
  }
  await event(deps, task.id, {
    type: 'retrieval.completed',
    summary: `Found ${plural(hits.length, 'matching document')}`,
    detail: { count: hits.length },
    durationMs: Date.now() - searchStart,
  });
  if (hits.length === 0) {
    await fail(
      deps,
      task.id,
      'running',
      'no_evidence',
      'No authorised documents matched this objective. Broaden the wording or check the time range, then retry.',
    );
    return undefined;
  }
  return hits;
}

/** Stores this attempt's evidence in one insert and returns it as the API presents it. */
async function recordEvidence(
  deps: WorkbenchDeps,
  task: Claimed,
  hits: readonly DriveHit[],
): Promise<readonly WorkbenchEvidence[]> {
  const retrievedAt = deps.now().toISOString();
  const evidence: WorkbenchEvidence[] = [];
  let blocked = 0;
  for (const [index, hit] of hits.entries()) {
    const url = safeWorkbenchUrl(hit.url);
    const unsafe = url === null && hit.url !== null;
    if (unsafe) blocked += 1;
    evidence.push({
      id: `E${index + 1}`,
      ordinal: index + 1,
      sourceId: hit.sourceId,
      title: hit.title,
      excerpt: hit.excerpt,
      url,
      modifiedAt: new Date(hit.modifiedAt).toISOString(),
      retrievedAt,
      provenance: unsafe
        ? 'Simulated Drive (fixture). Unsafe link removed.'
        : 'Simulated Drive (fixture)',
    });
  }
  const rows = evidence.map((item) => ({
    id: item.id,
    task_id: task.id,
    attempt: task.attempt,
    ordinal: item.ordinal,
    source_id: item.sourceId,
    title: item.title,
    excerpt: item.excerpt,
    url: item.url,
    modified_at: item.modifiedAt,
    retrieved_at: item.retrievedAt,
    provenance: item.provenance,
  }));
  await deps.sql.begin(async (tx) => {
    await tx`delete from wb_evidence where task_id = ${task.id} and attempt = ${task.attempt}`;
    await tx`insert into wb_evidence ${tx(rows)}`;
  });
  const removed = blocked > 0 ? `; removed ${plural(blocked, 'unsafe link')}` : '';
  await event(deps, task.id, {
    type: 'evidence.recorded',
    summary: `Recorded ${plural(hits.length, 'source excerpt')}${removed}`,
    detail: { count: hits.length, blockedLinks: blocked },
  });
  return evidence;
}

/** One gated model call with its budget check and ledger rows; undefined means the task was failed. */
async function generate(
  deps: WorkbenchDeps,
  task: Claimed,
  model: ModelPort,
  evidence: readonly WorkbenchEvidence[],
): Promise<GenerateResult | undefined> {
  let result: GenerateResult;
  try {
    await ensureBudget(deps);
    await event(deps, task.id, {
      type: 'model.requested',
      summary: `Asked ${model.mode === 'stub' ? 'the offline stub model' : model.modelId} to analyse ${evidence.length} sources`,
      detail: { mode: model.mode, model: model.modelId },
    });
    result = await model.generate(reportRequest(task.objective, evidence));
  } catch (error) {
    if (!(error instanceof ModelError)) throw error;
    if (error.code !== 'budget_exhausted')
      await recordModelCall(deps, task.id, { outcome: error.code, sent: error.sent });
    await event(deps, task.id, {
      type: 'model.failed',
      summary: `Model call failed: ${error.code.replaceAll('_', ' ')}`,
      detail: { code: error.code },
    });
    await fail(deps, task.id, 'running', error.code, modelRemediation[error.code]);
    return undefined;
  }
  await recordModelCall(deps, task.id, {
    outcome: 'ok',
    sent: true,
    modelVersion: result.modelVersion,
    responseId: result.responseId,
    latencyMs: result.latencyMs,
    promptTokens: result.promptTokens,
    outputTokens: result.outputTokens,
  });
  await event(deps, task.id, {
    type: 'model.completed',
    summary: `Model responded (${model.mode === 'stub' ? 'stub' : result.modelVersion})`,
    detail: {
      mode: model.mode,
      model: model.modelId,
      modelVersion: result.modelVersion,
      responseId: result.responseId ?? null,
      outputTokens: result.outputTokens ?? null,
    },
    durationMs: result.latencyMs,
  });
  return result;
}

async function validate(
  deps: WorkbenchDeps,
  task: Claimed,
  text: string,
  evidence: readonly WorkbenchEvidence[],
): Promise<ReturnType<typeof validateReport> | undefined> {
  let validated: ReturnType<typeof validateReport>;
  try {
    validated = validateReport(text, evidence);
  } catch {
    await fail(deps, task.id, 'running', 'invalid_output', modelRemediation.invalid_output);
    return undefined;
  }
  await event(deps, task.id, {
    type: 'citations.validated',
    summary:
      validated.dropped === 0
        ? 'Every citation matches a retrieved source'
        : `Removed ${plural(validated.dropped, 'citation')} that did not match a retrieved source`,
    detail: { dropped: validated.dropped },
  });
  return validated;
}

async function persistDraft(deps: WorkbenchDeps, task: Claimed, draft: Draft): Promise<void> {
  const { model, result, validated, evidence } = draft;
  const document = documentFor(validated.report, evidence);
  const account = task.owner_email ?? task.owner_sub;
  const proposal = proposalFor(document, account);
  const digest = approvalDigest(proposal, document);
  const at = deps.now();
  await deps.sql.begin(async (tx) => {
    const locked = await lockTask(tx, undefined, task.id);
    if (locked?.status !== 'running') return;
    await tx`
      insert into wb_artifacts (task_id, report, model, dropped_citations, created_at)
      values (${task.id}, ${tx.json(validated.report)},
        ${tx.json({
          mode: model.mode,
          modelId: model.modelId,
          modelVersion: result.modelVersion,
          responseId: result.responseId ?? null,
          latencyMs: result.latencyMs,
          promptTokens: result.promptTokens ?? null,
          outputTokens: result.outputTokens ?? null,
          at: at.toISOString(),
        })}, ${validated.dropped}, ${at})
      on conflict (task_id) do update set report = excluded.report, model = excluded.model,
        dropped_citations = excluded.dropped_citations, created_at = excluded.created_at
    `;
    await appendEvent(deps, tx, task.id, {
      type: 'draft.created',
      summary: `Draft report ready: ${document.sections.length} sections, ${document.sources.length} cited sources`,
    });
    await tx`
      insert into wb_approvals (id, task_id, proposal, document, payload_sha256, state,
        requested_at, expires_at)
      values (${deps.newId()}, ${task.id}, ${tx.json(proposal)}, ${tx.json(document)}, ${digest},
        'pending', ${at}, ${new Date(at.getTime() + approvalTtlMs)})
      on conflict (task_id) do update set id = excluded.id, proposal = excluded.proposal,
        document = excluded.document, payload_sha256 = excluded.payload_sha256, state = 'pending',
        requested_at = excluded.requested_at, expires_at = excluded.expires_at,
        decided_by = null, decided_at = null
    `;
    await move(deps, tx, locked, {
      to: 'waiting_approval',
      events: [
        {
          type: 'approval.requested',
          summary: 'Waiting for your approval to create one document',
          detail: { tool: proposal.tool, simulated: proposal.simulated },
        },
      ],
    });
  });
}

async function analyse(deps: WorkbenchDeps, task: Claimed): Promise<void> {
  if (task.status === 'queued') {
    const started = await transition(deps, task.id, 'queued', {
      to: 'running',
      events: [
        {
          type: 'task.started',
          summary: 'Worker picked up the task',
          detail: { attempt: task.attempt },
        },
      ],
    });
    if (!started) return;
  }
  if (deps.model.kind !== 'ready') {
    await fail(deps, task.id, 'running', 'not_configured', modelRemediation.not_configured);
    return;
  }
  const model = deps.model.model;
  const hits = await retrieve(deps, task);
  if (hits === undefined) return;
  const evidence = await recordEvidence(deps, task, hits);
  if (await stopIfCancelled(deps, task.id)) return;
  const result = await generate(deps, task, model, evidence);
  if (result === undefined) return;
  const validated = await validate(deps, task, result.text, evidence);
  if (validated === undefined) return;
  await persistDraft(deps, task, { model, result, validated, evidence });
  await stopIfCancelled(deps, task.id);
}

type ApprovedRow = {
  state: string;
  proposal: unknown;
  document: DocumentBody;
  payload_sha256: string;
  idempotency_key: string;
  status: string;
};

async function execute(deps: WorkbenchDeps, task: Claimed): Promise<void> {
  const { sql } = deps;
  const rows = await sql<ApprovedRow[]>`
    select ap.state, ap.proposal, ap.document, ap.payload_sha256, ac.idempotency_key, ac.status
    from wb_approvals ap join wb_actions ac on ac.approval_id = ap.id
    where ap.task_id = ${task.id}
  `;
  const row = rows.at(0);
  const proposal = workbenchActionProposalSchema.safeParse(row?.proposal);
  if (
    row === undefined ||
    row.state !== 'approved' ||
    !proposal.success ||
    approvalDigest(proposal.data, row.document) !== row.payload_sha256
  ) {
    await fail(
      deps,
      task.id,
      'executing',
      'approval_invalid',
      'The approval no longer matches the proposed write. Nothing was written.',
    );
    return;
  }
  await sql`update wb_actions set attempts = attempts + 1, updated_at = ${deps.now()} where task_id = ${task.id}`;
  await event(deps, task.id, {
    type: 'action.started',
    summary: 'Creating the document in Simulated Google Docs',
    detail: { simulated: true },
  });
  const started = Date.now();
  try {
    const created = await deps.workspace.createDoc(
      task.owner_sub,
      { idempotencyKey: row.idempotency_key, title: row.document.title, body: row.document },
      faultsIn(task.objective, deps.faultsEnabled),
    );
    await sql.begin(async (tx) => {
      const locked = await lockTask(tx, undefined, task.id);
      if (locked?.status !== 'executing') return;
      await tx`
        update wb_actions set status = 'succeeded', external_id = ${created.docId},
          external_url = ${created.url}, updated_at = ${deps.now()}
        where task_id = ${task.id}
      `;
      await move(deps, tx, locked, {
        to: 'completed',
        events: [
          {
            type: 'action.completed',
            summary: 'Created 1 simulated document',
            detail: { docId: created.docId, simulated: true },
            durationMs: Date.now() - started,
          },
          { type: 'task.completed', summary: 'Task completed' },
        ],
        error: null,
      });
    });
  } catch (error) {
    const code = error instanceof WorkspaceError ? error.code : 'unknown';
    if (code === 'docs_failed') {
      await sql`update wb_actions set status = 'failed', updated_at = ${deps.now()} where task_id = ${task.id}`;
      await event(deps, task.id, {
        type: 'action.failed',
        summary: 'Docs rejected the write. No document was created.',
        durationMs: Date.now() - started,
      });
      await fail(
        deps,
        task.id,
        'executing',
        'docs_failed',
        'The document could not be created. Retry uses the same idempotency key, so it cannot duplicate.',
      );
      return;
    }
    await sql`update wb_actions set status = 'uncertain', updated_at = ${deps.now()} where task_id = ${task.id}`;
    await transition(deps, task.id, 'executing', {
      to: 'outcome_uncertain',
      events: [
        {
          type: 'action.uncertain',
          summary:
            'The write may or may not have happened (no response). Reconcile before retrying.',
          durationMs: Date.now() - started,
        },
      ],
      error: {
        code: 'outcome_uncertain',
        message:
          'The document service did not confirm the write. Use Reconcile to check for the document; it will not be created twice.',
      },
    });
  }
}

export function createWorkbenchWorker(options: WorkerOptions) {
  const { deps } = options;
  const { sql } = deps;

  async function work(task: Claimed): Promise<void> {
    try {
      if (task.status === 'cancel_requested') await stopIfCancelled(deps, task.id);
      else if (task.status === 'executing') await execute(deps, task);
      else await analyse(deps, task);
    } catch (error) {
      options.onError?.(error);
      await quarantine(deps, task);
    } finally {
      await sql`
        update wb_tasks set lease_until = null, lease_token = null
        where id = ${task.id} and lease_token = ${task.lease_token}
      `;
    }
  }

  /** Drains every claimable task, then returns; the poll loop calls it again after `pollMs`. */
  async function tick(): Promise<void> {
    for (;;) {
      const task = await claim(sql);
      if (task === undefined) return;
      await work(task);
    }
  }

  const loop = createScheduleWorker(
    { tick },
    (error) => options.onError?.(error),
    options.pollMs ?? 500,
  );
  return { start: () => loop.start(), tick, stop: () => loop.stop() };
}
