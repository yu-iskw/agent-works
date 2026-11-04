import { createExternalHandler } from './external.js';
import { createBotGraph } from './graph.js';
import { createStepHandler } from './handlers.js';
import { createBotLease } from './lease.js';
import { createBotPreparation } from './preparation.js';
import { createBotRecovery } from './recovery.js';
import { createBotSettlement } from './settlement.js';

import type { BotJob, ExecutionOptions } from './types.js';

const executors = new WeakMap<
  object,
  ReturnType<typeof createBotExecution> & { recover: () => Promise<number> }
>();
export function registerBotExecution(options: ExecutionOptions) {
  const core = createBotExecution(options);
  const execution = { ...core, recover: createBotRecovery(options, core) };
  executors.set(options.deps, execution);
  return execution;
}
export const botExecutionFor = (deps: ExecutionOptions['deps']) => executors.get(deps);
export async function handleBotJob(deps: ExecutionOptions['deps'], job: BotJob): Promise<void> {
  await executors.get(deps)?.handle(job);
}

export function createBotExecution(options: ExecutionOptions) {
  const graph = createBotGraph(options);
  const lease = createBotLease(options);
  const settle = createBotSettlement(options, lease, graph);
  const prepare = createBotPreparation(options, lease, graph);
  const delegate = createExternalHandler(options, lease, graph, settle);
  return {
    ...graph,
    renew: (taskId: string) => options.admission.renew(taskId),
    handle: createStepHandler(options, { lease, graph, prepare, settle, delegate }),
    pollMs: options.pollMs ?? 2000,
  };
}
