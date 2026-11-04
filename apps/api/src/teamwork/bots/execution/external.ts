import { Conflict } from '../../context.js';
import { connectAgentTask } from '../../mcp-task/index.js';

import { recheck } from './recheck.js';
import { loadRun, moveRun, moveStep } from './store.js';
import { boundedText } from './types.js';

import type { createBotGraph } from './graph.js';
import type { createBotLease } from './lease.js';
import type { createBotSettlement } from './settlement.js';
import type { BotJob, ExecutionOptions, RunRow, StepRow } from './types.js';
import type { AgentTaskClient } from '../../mcp-task/index.js';
import type { BotStep } from '@agent-works/domain';

type Delegation = {
  run: RunRow;
  step: StepRow;
  definition: Extract<BotStep, { kind: 'mcp_delegate' }>;
  fresh: boolean;
};
async function remoteCancel(client: AgentTaskClient | undefined, step: StepRow) {
  if (!step.external) return 'confirmed' as const;
  if (!client || !step.external.handle) return 'uncertain' as const;
  try {
    const result = await client.cancel(step.external.handle);
    return ['cancelled', 'already_terminal'].includes(result.kind)
      ? ('confirmed' as const)
      : result.kind === 'unsupported'
        ? ('unsupported' as const)
        : ('uncertain' as const);
  } catch {
    return 'uncertain' as const;
  }
}
export function createExternalHandler(
  options: ExecutionOptions,
  lease: ReturnType<typeof createBotLease>,
  graph: ReturnType<typeof createBotGraph>,
  settle: ReturnType<typeof createBotSettlement>,
) {
  const { deps } = options;
  const { owned, delay } = lease;
  const { advance, release } = graph;
  async function stillOwned(job: BotJob) {
    const rows =
      await deps.sql`select 1 from tw_jobs where id=${job.id} and lease_token=${job.lease_token} and state='running' and lease_until > now()`;
    return rows.length > 0;
  }
  async function stopExternal(
    job: BotJob,
    state: Delegation,
    client: AgentTaskClient | undefined,
    reason: string,
  ) {
    if (!(await stillOwned(job))) return;
    const { step } = state;
    await deps.sql`update tw_bot_steps set external=jsonb_set(external,'{cancel}','"requested"'::jsonb) where task_id=${step.task_id} and step_id=${step.step_id} and owner_token=${job.lease_token}`;
    const cancel = await remoteCancel(client, step);
    let released: RunRow | undefined;
    await deps.sql.begin(async (tx) => {
      const current = await owned(tx, job);
      if (!current || current.step.owner_token !== job.lease_token) return;
      const { run, step: row } = current;
      if (row.external)
        await tx`update tw_bot_steps set external=jsonb_set(external,'{cancel}',${tx.json(cancel)}) where task_id=${run.task_id} and step_id=${row.step_id}`;
      if (row.status === 'ready') await moveStep(deps, tx, row, 'running');
      const status =
        cancel === 'confirmed'
          ? run.status === 'cancel_requested'
            ? 'cancelled'
            : 'failed'
          : 'outcome_uncertain';
      await moveStep(deps, tx, row, status, reason);
      if (run.status === 'cancel_requested')
        await moveRun(
          deps,
          tx,
          run,
          cancel === 'confirmed' ? 'cancelled' : 'outcome_uncertain',
          reason,
        );
      else await advance(tx, run);
      released = run;
    });
    if (released) await release(released);
  }
  async function persistExternal(job: BotJob, handle: string | null, lastStatus: string) {
    await deps.sql.begin(async (tx) => {
      const state = await owned(tx, job);
      if (!state || state.step.owner_token !== job.lease_token || !state.step.external) return;
      const { run, step } = state;
      step.external = { ...state.step.external, handle, lastStatus };
      await tx`update tw_bot_steps set external=${tx.json(step.external)} where task_id=${run.task_id} and step_id=${step.step_id}`;
      if (step.status === 'running') await moveStep(deps, tx, step, 'waiting_external');
      if (run.status === 'running') await moveRun(deps, tx, run, 'waiting_external');
      await delay(tx, job);
    });
  }
  async function findHandle(
    job: BotJob,
    state: Delegation,
    client: AgentTaskClient,
  ): Promise<string | null> {
    const { step, definition, fresh } = state;
    if (step.external?.handle) return step.external.handle;
    if (fresh) {
      if (!(await stillOwned(job))) return null;
      const outcome = await client.submit({
        idempotencyKey: step.idempotency_key ?? '',
        instruction: definition.instruction,
        input: step.input,
      });
      if (outcome.kind === 'rejected') {
        await settle(job, { status: 'failed', code: outcome.code });
        return null;
      }
      if (outcome.kind === 'accepted') return outcome.handle;
    }
    const found = await client.lookup(step.idempotency_key ?? '');
    if (found.kind === 'found') return found.handle;
    await settle(job, { status: 'outcome_uncertain', code: 'submit_outcome_uncertain' });
    return null;
  }
  async function poll(job: BotJob, state: Delegation, client: AgentTaskClient, handle: string) {
    const status = await client.status(handle);
    if (status.state === 'queued' || status.state === 'running') {
      await persistExternal(job, handle, status.state);
      return;
    }
    if (status.state !== 'succeeded') {
      const code = status.state === 'failed' ? status.code : `external_${status.state}`;
      await settle(job, {
        status: status.state === 'not_found' ? 'outcome_uncertain' : 'failed',
        code,
      });
      return;
    }
    const denied = await recheck(
      options,
      (await loadRun(deps.sql, state.run.task_id)) ?? state.run,
    );
    if (denied) {
      await stopExternal(job, state, client, denied);
      return;
    }
    if (!(await stillOwned(job))) return;
    const result = await client.result(handle);
    await settle(job, {
      status: 'succeeded',
      output: boundedText(result.output),
      cost:
        result.cost.basis === 'reported' && result.cost.currency === 'USD'
          ? { basis: 'reported', amountMicros: result.cost.amountMicros }
          : { basis: 'unknown' },
    });
  }
  function expired(state: Delegation) {
    return (
      deps.now().getTime() - (state.step.started_at ?? state.run.created_at).getTime() >=
      state.definition.timeoutSeconds * 1000
    );
  }
  async function refuseDispatch(
    job: BotJob,
    state: Delegation,
    client: AgentTaskClient | undefined,
    reason: string,
  ) {
    if (state.fresh) {
      await settle(job, { status: 'failed', code: reason, effectNotSent: true });
      return;
    }
    if (state.step.idempotency_key) await stopExternal(job, state, client, reason);
    else await settle(job, { status: 'failed', code: reason });
  }
  async function act(job: BotJob, state: Delegation, client: AgentTaskClient | undefined) {
    const current = await loadRun(deps.sql, state.run.task_id);
    if (!current || !(await stillOwned(job))) return;
    const denial = await recheck(options, current);
    const timeout = expired(state);
    if (denial || timeout) {
      await refuseDispatch(job, state, client, denial ?? 'external_timeout');
      return;
    }
    if (!client) {
      await settle(job, { status: 'failed', code: 'unknown_agent' });
      return;
    }
    const handle = await findHandle(job, state, client);
    if (!handle) return;
    if (state.fresh || !state.step.external?.handle) {
      await persistExternal(job, handle, 'accepted');
      return;
    }
    await poll(job, state, client, handle);
  }
  return async (job: BotJob, state: Delegation) => {
    const agent = options.registry.get(state.definition.agent.agentId);
    let client: AgentTaskClient | undefined;
    try {
      if (agent)
        client = await connectAgentTask(agent, {
          fetch: deps.fetch,
          allowLoopback: deps.config.identity === 'local-test',
        });
      await act(job, state, client);
    } catch (error) {
      if (state.step.idempotency_key)
        await persistExternal(job, state.step.external?.handle ?? null, 'poll_unavailable');
      else
        await settle(job, {
          status: 'failed',
          code: error instanceof Conflict ? error.code : 'mcp_unavailable',
        });
    } finally {
      await client?.close().catch(() => undefined);
    }
  };
}
