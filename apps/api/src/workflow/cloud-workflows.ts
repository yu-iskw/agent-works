import { createHash } from 'node:crypto';

import {
  terminalStatuses,
  workflowCheckpointSchema,
  workflowSignalSchema,
} from '@agent-works/domain';

import type { WorkflowLog } from './workflow-log.js';
import type { LedgerPort } from '../ports/ledger-port.js';
import type { WorkflowPort } from '../ports/workflow.js';
import type { Task, TaskStatus, WorkflowSignal } from '@agent-works/domain';

const executionBase = 'https://workflowexecutions.googleapis.com/v1/';
const activeStates = new Set(['ACTIVE', 'QUEUED']);
const dispatchStatuses = new Set<TaskStatus>([
  'QUEUED',
  'RUNNING',
  'WAITING_APPROVAL',
  'WAITING_INPUT',
  'BLOCKED_AUTH',
  'PAUSED',
  'RETRYING',
]);

function mustWait(status: TaskStatus): boolean {
  // Only an explicit ledger resume may release a pause; callbacks are wake-up hints.
  return status === 'PAUSED' || status === 'CREATED' || status === 'AUTHORIZED';
}

const waitingStatuses = new Set<TaskStatus>([
  'WAITING_APPROVAL',
  'WAITING_INPUT',
  'BLOCKED_AUTH',
  'PAUSED',
]);

export type CloudRequest = {
  readonly method: 'GET' | 'POST';
  readonly url: string;
  readonly body?: unknown;
};

/** Transport supplies keyless OAuth and redacts errors; this module never obtains credentials. */
type CloudTransport = {
  request(this: void, request: CloudRequest): Promise<unknown>;
};

type Execution = {
  readonly name: string;
  readonly state: string;
  readonly labels: Record<string, string>;
};

export type CloudWorkflowDeps = {
  readonly workflowName: string;
  readonly transport: CloudTransport;
  readonly checkpoints: WorkflowPort;
  readonly ledger: LedgerPort;
  readonly subjectForTask: (taskId: string) => Promise<string>;
  /** Cross-process lock, held through remote dispatch. Must be durable, never a process-local mutex. */
  readonly withTaskLock: <T>(taskId: string, operation: () => Promise<T>) => Promise<T>;
  /** Must commit cancellation and its outbox event transactionally before returning. */
  readonly cancelInLedger: (task: Task, signal: WorkflowSignal) => Promise<void>;
  /** Fresh, payload-bound approval and user/source authorization; throws on denial. */
  readonly authorizeResume: (task: Task) => Promise<void>;
};

/** Cloud executions schedule work; checkpoint rows are cursors, not business task status. */
export function createCloudWorkflowsPort(deps: CloudWorkflowDeps): WorkflowPort {
  validateWorkflowName(deps.workflowName);
  return {
    async read(taskId) {
      const task = await readTask(deps, taskId);
      const cursor = await deps.checkpoints.read(taskId);
      return cursor === undefined ? undefined : { ...cursor, status: task.status };
    },
    async save(checkpoint) {
      const parsed = workflowCheckpointSchema.parse(checkpoint);
      return deps.withTaskLock(parsed.taskId, async () => {
        const task = await readTask(deps, parsed.taskId);
        // The caller must first commit its task transition in the ledger.
        if (parsed.status !== task.status) throw new Error('checkpoint disagrees with ledger');
        const stored = await deps.checkpoints.save(parsed);
        if (terminalStatuses.includes(task.status)) await cancelExecutions(deps, task.id);
        else await ensureExecution(deps, task);
        return { ...stored, status: task.status };
      });
    },
    async signal(signal) {
      const parsed = workflowSignalSchema.parse(signal);
      const apply = async () => {
        let task = await readTask(deps, parsed.taskId);
        if (parsed.kind === 'resume' && !terminalStatuses.includes(task.status)) {
          await deps.authorizeResume(task);
        }
        const outcome = await deps.checkpoints.signal(parsed);
        // Reconcile even duplicates: a process may die after recording but before dispatch.
        if (parsed.kind === 'cancel') {
          if (!terminalStatuses.includes(task.status)) await deps.cancelInLedger(task, parsed);
          task = await readTask(deps, task.id);
          if (!terminalStatuses.includes(task.status))
            throw new Error('cancellation was not committed');
          await cancelExecutions(deps, task.id);
        } else if (!terminalStatuses.includes(task.status)) {
          await wakeExecution(deps, task, parsed);
        }
        return outcome;
      };
      // Cancellation is a control-plane transition and must not queue behind an external write.
      return parsed.kind === 'cancel' ? apply() : deps.withTaskLock(parsed.taskId, apply);
    },
  };
}

/** Periodic recovery input comes from the ledger's nonterminal task scan, outside WorkflowPort. */
export async function recoverCloudWorkflow(deps: CloudWorkflowDeps, taskId: string): Promise<void> {
  validateWorkflowName(deps.workflowName);
  await deps.withTaskLock(taskId, async () => {
    const task = await readTask(deps, taskId);
    if (terminalStatuses.includes(task.status)) await cancelExecutions(deps, taskId);
    else await ensureExecution(deps, task);
  });
}

async function readTask(deps: CloudWorkflowDeps, taskId: string): Promise<Task> {
  const subject = await deps.subjectForTask(taskId);
  const task = await deps.ledger.read(subject, taskId);
  if (task === undefined) throw new Error('workflow task not found');
  return task;
}

function validateWorkflowName(name: string): void {
  if (
    !/^projects\/[a-z][a-z0-9-]+\/locations\/[a-z0-9-]+\/workflows\/[a-z][a-z0-9_-]*$/.test(name)
  ) {
    throw new Error('invalid workflow resource name');
  }
}

export function cloudTaskLabel(taskId: string): string {
  return createHash('sha256').update(taskId).digest('hex').slice(0, 63);
}

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    throw new Error('invalid cloud response');
  return value as Record<string, unknown>;
}

function execution(value: unknown, parent: string): Execution {
  const row = record(value);
  if (
    typeof row.name !== 'string' ||
    !row.name.startsWith(`${parent}/executions/`) ||
    !/^[a-zA-Z0-9-]+$/.test(row.name.slice(`${parent}/executions/`.length)) ||
    typeof row.state !== 'string'
  ) {
    throw new Error('invalid execution response');
  }
  const labels = record(row.labels ?? {});
  const task = labels.task;
  return { name: row.name, state: row.state, labels: typeof task === 'string' ? { task } : {} };
}

function pageToken(response: Record<string, unknown>, seen: Set<string>): string {
  const next = response.nextPageToken;
  if (next === undefined || next === '') return '';
  if (typeof next !== 'string' || seen.has(next)) throw new Error('invalid pagination token');
  seen.add(next);
  return next;
}

function pageRows(response: Record<string, unknown>, key: string): unknown[] {
  // The key is an internal API field, never supplied by a user.
  // eslint-disable-next-line security/detect-object-injection
  const rows: unknown = response[key] ?? [];
  if (!Array.isArray(rows)) throw new Error('invalid cloud list');
  return rows as unknown[];
}

async function listExecutions(deps: CloudWorkflowDeps, taskId: string): Promise<Execution[]> {
  const matches: Execution[] = [];
  const seen = new Set<string>();
  let nextPage = '';
  do {
    const query = new URLSearchParams({ pageSize: '100', view: 'FULL' });
    if (nextPage.length > 0) query.set('pageToken', nextPage);
    const response = record(
      await deps.transport.request({
        method: 'GET',
        url: `${executionBase}${deps.workflowName}/executions?${query.toString()}`,
      }),
    );
    const rows = pageRows(response, 'executions').map((value) =>
      execution(value, deps.workflowName),
    );
    matches.push(
      ...rows.filter(
        (row) => row.labels.task === cloudTaskLabel(taskId) && activeStates.has(row.state),
      ),
    );
    nextPage = pageToken(response, seen);
  } while (nextPage.length > 0);
  return matches;
}

async function ensureExecution(deps: CloudWorkflowDeps, task: Task): Promise<void> {
  if (!dispatchStatuses.has(task.status)) return;
  if ((await listExecutions(deps, task.id)).length > 0) return;
  // POST create has no client-selected execution id. Never retry an ambiguous POST here.
  // A recovery scan lists remote executions before attempting another create.
  await deps.transport.request({
    method: 'POST',
    url: `${executionBase}${deps.workflowName}/executions`,
    body: {
      argument: JSON.stringify({ taskId: task.id }),
      labels: { task: cloudTaskLabel(task.id) },
      callLogLevel: 'LOG_NONE',
    },
  });
}

async function cancelExecutions(deps: CloudWorkflowDeps, taskId: string): Promise<void> {
  for (const row of await listExecutions(deps, taskId)) {
    await deps.transport.request({
      method: 'POST',
      url: `${executionBase}${row.name}:cancel`,
      body: {},
    });
  }
}

async function wakeExecution(
  deps: CloudWorkflowDeps,
  task: Task,
  signal: WorkflowSignal,
): Promise<void> {
  const rows = await listExecutions(deps, task.id);
  if (rows.length === 0) {
    await ensureExecution(deps, task);
    return;
  }
  for (const row of rows) {
    await sendCallbacks(deps, row, signal);
  }
}

async function sendCallbacks(
  deps: CloudWorkflowDeps,
  row: Execution,
  signal: WorkflowSignal,
): Promise<void> {
  const seen = new Set<string>();
  let nextPage = '';
  do {
    const query = new URLSearchParams({ pageSize: '100' });
    if (nextPage.length > 0) query.set('pageToken', nextPage);
    const response = record(
      await deps.transport.request({
        method: 'GET',
        url: `${executionBase}${row.name}/callbacks?${query.toString()}`,
      }),
    );
    for (const value of pageRows(response, 'callbacks')) {
      const callback = record(value);
      if (typeof callback.name !== 'string' || callback.method !== 'POST')
        throw new Error('invalid callback');
      // callbacks.list uses singular "callback" in resource names, while delivery uses "callbacks".
      const prefix = `${row.name}/callback/`;
      if (
        !callback.name.startsWith(prefix) ||
        !/^[a-zA-Z0-9-]+$/.test(callback.name.slice(prefix.length))
      )
        throw new Error('invalid callback resource');
      const callbackId = callback.name.slice(prefix.length);
      await deps.transport.request({
        method: 'POST',
        url: `${executionBase}${row.name}/callbacks/${callbackId}`,
        body: { taskId: signal.taskId, signalId: signal.signalId },
      });
    }
    nextPage = pageToken(response, seen);
  } while (nextPage.length > 0);
}

export type CloudStep = {
  readonly id: string;
  /** Canonical digest binds authorization and the external idempotency key. */
  readonly payloadDigest: string;
  authorize(this: void, task: Task): Promise<'allow' | 'wait' | 'deny'>;
  /** Must reauthorize immediately before the write and support this stable idempotency key. */
  execute(
    this: void,
    input: { readonly task: Task; readonly idempotencyKey: string },
  ): Promise<string>;
  /** Query by stable key, including after an ambiguous failure. Unknown fails closed. */
  reconcile(
    this: void,
    idempotencyKey: string,
  ): Promise<
    { readonly kind: 'found'; readonly receipt: string } | { readonly kind: 'absent' | 'unknown' }
  >;
};

export type CloudWorkerDeps = {
  readonly ledger: LedgerPort;
  readonly checkpoints: WorkflowPort;
  readonly log: WorkflowLog;
  readonly subjectForTask: (taskId: string) => Promise<string>;
  readonly withTaskLock: CloudWorkflowDeps['withTaskLock'];
  readonly steps: readonly CloudStep[];
  /** Existing task service transaction: validate transition, receipt/outbox, expected version. */
  readonly commit: (
    task: Task,
    update: { readonly status: TaskStatus; readonly stepId: string; readonly receipt?: string },
  ) => Promise<void>;
  readonly maxAttempts?: number;
};

export type CloudTickResult = {
  readonly action: 'continue' | 'wait' | 'done';
  readonly taskId: string;
};

/** One broker tick, called by the generated definition. No cloud execution state is trusted. */
export async function advanceCloudWorkflow(
  deps: CloudWorkerDeps,
  taskId: string,
): Promise<CloudTickResult> {
  validateSteps(deps);
  return deps.withTaskLock(taskId, async () => {
    const task = await workerTask(deps, taskId);
    if (terminalStatuses.includes(task.status)) return repairTerminalReceipt(deps, task);
    if (mustWait(task.status)) return { action: 'wait', taskId };
    const receipts = await deps.log.list(taskId);
    const step = deps.steps.find(
      (candidate) => !receipts.some((receipt) => receipt.stepId === candidate.id),
    );
    if (step === undefined) {
      const ready = await runningTask(deps, task, 'done');
      if (mustWait(ready.status)) return { action: 'wait', taskId };
      if (ready.status === 'RUNNING')
        await deps.commit(ready, { status: 'COMPLETED', stepId: 'done' });
      return { action: 'done', taskId };
    }
    return advanceStep(deps, task, step);
  });
}

function validateSteps(deps: CloudWorkerDeps): void {
  if (
    deps.maxAttempts !== undefined &&
    (!Number.isInteger(deps.maxAttempts) || deps.maxAttempts < 1)
  )
    throw new Error('invalid attempt limit');
  if (new Set(deps.steps.map((step) => step.id)).size !== deps.steps.length)
    throw new Error('duplicate step id');
  if (deps.steps.some((step) => step.id.length === 0 || !/^[a-f0-9]{64}$/.test(step.payloadDigest)))
    throw new Error('invalid step identity');
}

async function repairTerminalReceipt(deps: CloudWorkerDeps, task: Task): Promise<CloudTickResult> {
  const cursor = await deps.checkpoints.read(task.id);
  const step = deps.steps.find((candidate) => candidate.id === cursor?.stepId);
  const receipts = await deps.log.list(task.id);
  if (step !== undefined && !receipts.some((receipt) => receipt.stepId === step.id)) {
    const outcome = await step.reconcile(cloudStepKey(task.id, step));
    if (outcome.kind === 'found') return storeReceipt(deps, task, step, outcome.receipt);
    if (outcome.kind === 'unknown') return { action: 'wait', taskId: task.id };
  }
  return { action: 'done', taskId: task.id };
}

async function runningTask(deps: CloudWorkerDeps, task: Task, stepId: string): Promise<Task> {
  const fresh = await workerTask(deps, task.id);
  if (mustWait(fresh.status)) return fresh;
  if (!terminalStatuses.includes(fresh.status) && fresh.status !== 'RUNNING') {
    await deps.commit(fresh, { status: 'RUNNING', stepId });
  }
  return workerTask(deps, task.id);
}

async function workerTask(deps: CloudWorkerDeps, taskId: string): Promise<Task> {
  const task = await deps.ledger.read(await deps.subjectForTask(taskId), taskId);
  if (task === undefined) throw new Error('workflow task not found');
  return task;
}

export function cloudStepKey(
  taskId: string,
  step: Pick<CloudStep, 'id' | 'payloadDigest'>,
): string {
  return createHash('sha256')
    .update(JSON.stringify([taskId, step.id, step.payloadDigest]))
    .digest('hex');
}

async function advanceStep(
  deps: CloudWorkerDeps,
  task: Task,
  step: CloudStep,
): Promise<CloudTickResult> {
  const key = cloudStepKey(task.id, step);
  const prior = await step.reconcile(key);
  if (prior.kind === 'found') return storeReceipt(deps, task, step, prior.receipt);
  if (prior.kind === 'unknown') return { action: 'wait', taskId: task.id };
  const verdict = await step.authorize(task);
  if (verdict !== 'allow') {
    const status = verdict === 'deny' ? 'BLOCKED_AUTH' : 'WAITING_APPROVAL';
    if (task.status !== status) {
      const ready = await runningTask(deps, task, step.id);
      if (ready.status === 'RUNNING') await deps.commit(ready, { status, stepId: step.id });
    }
    return { action: 'wait', taskId: task.id };
  }
  return executeStep(deps, task, step, key);
}

async function executeStep(
  deps: CloudWorkerDeps,
  task: Task,
  step: CloudStep,
  key: string,
): Promise<CloudTickResult> {
  const fresh = await runningTask(deps, task, step.id);
  if (terminalStatuses.includes(fresh.status)) return { action: 'done', taskId: task.id };
  if (mustWait(fresh.status) || waitingStatuses.has(fresh.status))
    return { action: 'wait', taskId: task.id };
  const attempts = await deps.log.bump(task.id, step.id);
  if (attempts > (deps.maxAttempts ?? 3)) {
    await deps.commit(fresh, { status: 'FAILED', stepId: step.id });
    return { action: 'done', taskId: task.id };
  }
  await deps.checkpoints.save({ taskId: task.id, status: fresh.status, stepId: step.id });
  let receipt: string;
  try {
    receipt = await step.execute({ task: fresh, idempotencyKey: key });
  } catch {
    return recoverAttempt(deps, fresh, step, attempts);
  }
  return storeReceipt(deps, fresh, step, receipt);
}

async function recoverAttempt(
  deps: CloudWorkerDeps,
  task: Task,
  step: CloudStep,
  attempts: number,
): Promise<CloudTickResult> {
  const recovered = await step.reconcile(cloudStepKey(task.id, step));
  if (recovered.kind === 'found') return storeReceipt(deps, task, step, recovered.receipt);
  if (recovered.kind === 'unknown') return { action: 'wait', taskId: task.id };
  const current = await workerTask(deps, task.id);
  if (terminalStatuses.includes(current.status)) return { action: 'done', taskId: task.id };
  if (mustWait(current.status)) return { action: 'wait', taskId: task.id };
  const exhausted = attempts >= (deps.maxAttempts ?? 3);
  await deps.commit(current, { status: exhausted ? 'FAILED' : 'RETRYING', stepId: step.id });
  return { action: exhausted ? 'done' : 'continue', taskId: task.id };
}

async function storeReceipt(
  deps: CloudWorkerDeps,
  task: Task,
  step: CloudStep,
  receipt: string,
): Promise<CloudTickResult> {
  // Commit receipt/outbox BEFORE marking step complete in the workflow receipt log.
  // On a crash the external lookup repairs both using the same key and immutable receipt.
  const current = await workerTask(deps, task.id);
  await deps.commit(current, { status: current.status, stepId: step.id, receipt });
  await deps.log.put(task.id, step.id, receipt);
  return {
    action: terminalStatuses.includes(current.status) ? 'done' : 'continue',
    taskId: task.id,
  };
}

/** JSON is valid Workflows source. Only a fixed, operator-provided broker URL is called. */
export function generateCloudWorkflowDefinition(input: {
  readonly brokerUrl: string;
  readonly audience: string;
  readonly waitSeconds?: number;
}): string {
  const url = new URL(input.brokerUrl);
  const audience = new URL(input.audience);
  if (
    url.protocol !== 'https:' ||
    url.username !== '' ||
    url.password !== '' ||
    url.search !== '' ||
    url.hash !== '' ||
    audience.origin !== url.origin
  )
    throw new Error('invalid broker endpoint');
  const timeout = input.waitSeconds ?? 60;
  if (!Number.isInteger(timeout) || timeout < 1 || timeout > 86400)
    throw new Error('invalid callback timeout');
  const tick = {
    try: {
      call: 'http.post',
      args: {
        url: input.brokerUrl,
        auth: { type: 'OIDC', audience: input.audience },
        body: { taskId: '${input.taskId}' },
        timeout: 30,
      },
      result: 'decision',
    },
    retry: {
      predicate: '${http.default_retry_predicate}',
      max_retries: 3,
      backoff: { initial_delay: 1, max_delay: 8, multiplier: 2 },
    },
  };
  return (
    JSON.stringify(
      {
        main: {
          params: ['input'],
          steps: [
            {
              create_callback: {
                call: 'events.create_callback_endpoint',
                args: { http_callback_method: 'POST' },
                result: 'callback',
              },
            },
            { tick },
            {
              dispatch: {
                switch: [
                  { condition: '${decision.body.action == "done"}', next: 'finish' },
                  { condition: '${decision.body.action == "wait"}', next: 'wait' },
                  { condition: '${decision.body.action == "continue"}', next: 'tick' },
                ],
                next: 'invalid_decision',
              },
            },
            { invalid_decision: { raise: 'invalid broker decision' } },
            {
              wait: {
                try: {
                  call: 'events.await_callback',
                  args: { callback: '${callback}', timeout },
                  result: 'wake',
                },
                except: {
                  as: 'error',
                  steps: [
                    {
                      timeout_only: {
                        switch: [{ condition: '${"TimeoutError" in error.tags}', next: 'tick' }],
                      },
                    },
                    { rethrow: { raise: '${error}' } },
                  ],
                },
                next: 'tick',
              },
            },
            { finish: { return: { taskId: '${input.taskId}' } } },
          ],
        },
      },
      null,
      2,
    ) + '\n'
  );
}
