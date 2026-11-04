import { createHash } from 'node:crypto';

import type { CancelOutcome, SubmitOutcome, TaskResult, TaskStatus } from './contract.js';

type Directive =
  | 'normal'
  | 'drop-submit'
  | 'slow-submit'
  | 'tool-error'
  | 'fail'
  | 'oversized-output'
  | 'invalid-json'
  | 'never'
  | 'unknown-cost';
type ReferenceTask = {
  handle: string;
  fingerprint: string;
  directive: Directive;
  createdAt: number;
  state: 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled';
  input: unknown;
};

export function referenceDirective(instruction: string): Directive {
  const modes: readonly Directive[] = [
    'drop-submit',
    'slow-submit',
    'tool-error',
    'fail',
    'oversized-output',
    'invalid-json',
    'never',
    'unknown-cost',
  ];
  return modes.find((mode) => instruction.startsWith(`[reference:${mode}]`)) ?? 'normal';
}

/** Local reference only. Tasks belong to the service, never to a client or MCP session. */
export function createReferenceAgent(
  opts: { now?: () => number; queuedMs?: number; completionMs?: number } = {},
) {
  const now = opts.now ?? Date.now;
  const byKey = new Map<string, ReferenceTask>();
  const byHandle = new Map<string, ReferenceTask>();
  const queuedMs = opts.queuedMs ?? 100;
  const completionMs = opts.completionMs ?? 1000;
  let sequence = 0;

  function update(task: ReferenceTask) {
    if (task.state !== 'queued' && task.state !== 'running') return;
    const elapsed = now() - task.createdAt;
    if (elapsed >= queuedMs) task.state = 'running';
    if (task.directive !== 'never' && elapsed >= completionMs)
      task.state = task.directive === 'fail' ? 'failed' : 'succeeded';
  }
  function status(handle: string): TaskStatus {
    const task = byHandle.get(handle);
    if (!task) return { state: 'not_found' };
    update(task);
    return task.state === 'failed'
      ? { state: 'failed', code: 'task_failed' }
      : { state: task.state };
  }
  return {
    submit(input: { idempotencyKey: string; instruction: string; input: unknown }): SubmitOutcome {
      const fingerprint = createHash('sha256')
        .update(JSON.stringify([input.instruction, input.input]))
        .digest('hex');
      const existing = byKey.get(input.idempotencyKey);
      if (existing)
        return existing.fingerprint === fingerprint
          ? { kind: 'accepted', handle: existing.handle, duplicate: true }
          : { kind: 'rejected', code: 'idempotency_conflict' };
      const handle = `reference-${++sequence}`;
      const task: ReferenceTask = {
        handle,
        fingerprint,
        directive: referenceDirective(input.instruction),
        createdAt: now(),
        state: 'queued',
        input: input.input,
      };
      byKey.set(input.idempotencyKey, task);
      byHandle.set(handle, task);
      return { kind: 'accepted', handle, duplicate: false };
    },
    status,
    result(handle: string): TaskResult | undefined {
      if (status(handle).state !== 'succeeded') return undefined;
      const task = byHandle.get(handle);
      if (!task) return undefined;
      return {
        output:
          task.directive === 'oversized-output'
            ? 'x'.repeat(128 * 1024)
            : { reference: true, input: task.input },
        cost:
          task.directive === 'unknown-cost'
            ? { basis: 'unknown' }
            : { basis: 'reported', amountMicros: 1234, currency: 'USD' },
      };
    },
    cancel(handle: string): CancelOutcome {
      const state = status(handle).state;
      if (state !== 'queued' && state !== 'running') return { kind: 'already_terminal' };
      const task = byHandle.get(handle);
      if (task) task.state = 'cancelled';
      return { kind: 'cancelled' };
    },
    lookup(idempotencyKey: string) {
      const task = byKey.get(idempotencyKey);
      return task
        ? { kind: 'found' as const, handle: task.handle }
        : { kind: 'not_found' as const };
    },
  };
}
