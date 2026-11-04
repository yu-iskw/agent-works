import { authorityForCall, chainUsable } from '@agent-works/domain/standing-grant-contract';

import { capabilitiesFor } from '../../catalog.js';
import { assertEntitled } from '../../gateway.js';
import { segmentCapabilities } from '../../installations.js';

import { costView } from './cost.js';
import { capabilities, approvalsFor, checkpointDigest, stepsFor } from './store.js';

import type { ExecutionOptions, RunRow } from './types.js';
import type { StandingGrant } from '@agent-works/domain/standing-grant-contract';

export async function grantValid(
  options: ExecutionOptions,
  run: RunRow,
  grant: StandingGrant,
  starting = false,
): Promise<boolean> {
  const { deps } = options;
  if (
    grant.sponsor !== run.owner_sub ||
    grant.grantee.botId !== run.teammate_id ||
    grant.grantee.botVersion !== run.revision
  )
    return false;
  if (!chainUsable(await options.grants.chain(grant.grantId), deps.now().toISOString()))
    return false;
  if (
    'denied' in
    authorityForCall(grant, {
      action: 'bot.run',
      resource: run.digest,
      now: deps.now().toISOString(),
    })
  )
    return false;
  const [usage] = await deps.sql<
    { n: number }[]
  >`select count(*)::int as n from tw_bot_runs where grant_id = ${grant.grantId}`;
  return (
    usage.n + (starting ? 1 : 0) <= grant.limits.budget.inferenceSteps &&
    (await grantBudget(options, run, grant, starting))
  );
}
async function memberAuthority(options: ExecutionOptions, run: RunRow): Promise<string | null> {
  const { deps } = options;
  const binding = (
    await deps.sql<
      { owner_email: string | null }[]
    >`select owner_email from tw_bots where teammate_id = ${run.teammate_id}`
  ).at(0);
  if (!binding?.owner_email) return 'identity_unbound';
  const member = { sub: run.execution_sub, email: binding.owner_email };
  if (!deps.config.members.has(member.email)) return 'membership_revoked';
  if (deps.config.readOnlyMembers.has(member.email)) return 'read_only_member';
  try {
    await assertEntitled(deps, member);
  } catch {
    return 'authority_denied';
  }
  const teammate =
    await deps.sql`select 1 from tw_teammates where id = ${run.teammate_id} and owner_sub = ${run.owner_sub} and not archived`;
  if (!teammate.length) return 'authority_denied';
  const requested = capabilities(run.definition);
  const segment = await segmentCapabilities(deps);
  const states = await capabilitiesFor(deps, member, requested, new Set(requested));
  if (
    requested.some((c) => !segment.has(c)) ||
    states.some((s) => requested.includes(s.capability) && !s.effective)
  )
    return 'authority_denied';
  return null;
}
async function resources(options: ExecutionOptions, run: RunRow): Promise<string | null> {
  for (const step of run.definition.workflow.steps) {
    if (step.kind === 'mcp_delegate' && !options.registry.get(step.agent.agentId))
      return 'unknown_agent';
    if (step.kind === 'skill') {
      const result = await options.skills.resolve(step.skill);
      if (!result.ok) return result.code;
      if (result.skill.digest !== step.skill.digest) return 'digest_mismatch';
    }
  }
  return null;
}
export async function recheck(options: ExecutionOptions, run: RunRow): Promise<string | null> {
  if (run.cancel_requested_at || ['cancel_requested', 'cancelled'].includes(run.status))
    return 'cancel_requested';
  if (options.deps.now() >= run.deadline_at) return 'run_timeout';
  if (await admissionExpired(options, run)) return 'admission_expired';
  if (await staleCheckpoint(options, run)) return 'stale_approval';
  const denial = (await memberAuthority(options, run)) ?? (await resources(options, run));
  if (denial) return denial;
  if (run.approval_mode !== 'standing_grant') return null;
  const grant = run.grant_id ? await options.grants.get(run.grant_id) : undefined;
  return grant && (await grantValid(options, run, grant)) ? null : 'grant_invalid';
}

async function staleCheckpoint(options: ExecutionOptions, run: RunRow) {
  const approvals = await approvalsFor(options.deps.sql, run.task_id);
  const steps = await stepsFor(options.deps.sql, run.task_id);
  if (
    approvals.some(
      (a) =>
        a.subject === 'bot_checkpoint' &&
        a.state === 'approved' &&
        a.step_id &&
        checkpointDigest(run, a.step_id, steps) !== a.payload_sha256,
    )
  )
    return true;
  return false;
}

async function admissionExpired(options: ExecutionOptions, run: RunRow) {
  const reservation = (
    await options.deps.sql<
      { state: string; expires_at: Date }[]
    >`select state,expires_at from admission_reservations where execution_id=${run.task_id}`
  ).at(0);
  if (
    reservation &&
    (reservation.state === 'expired' ||
      (reservation.state === 'active' && reservation.expires_at <= options.deps.now()))
  )
    return true;
  return false;
}

async function grantBudget(
  options: ExecutionOptions,
  run: RunRow,
  grant: StandingGrant,
  starting: boolean,
) {
  const ceiling = grant.limits.budget.estimatedCostMicros;
  if (ceiling === Number.MAX_SAFE_INTEGER) return true;
  const rows = await options.deps.sql<
    { task_id: string }[]
  >`select task_id from tw_bot_runs where grant_id=${grant.grantId}`;
  const costs = await Promise.all(
    rows.map(async (row) =>
      costView(options.deps.sql, row.task_id, await stepsFor(options.deps.sql, row.task_id)),
    ),
  );
  const total = costs.reduce((sum, c) => sum + (c.reportedMicros ?? 0), 0);
  if (total > ceiling) return false;
  if (!starting) return true;
  const paid = run.definition.workflow.steps.some(
    (s) => s.kind === 'skill' || s.kind === 'mcp_delegate',
  );
  return !paid || (total < ceiling && costs.every((c) => c.unknownItems.length === 0));
}
