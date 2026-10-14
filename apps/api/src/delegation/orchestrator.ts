import { randomUUID } from 'node:crypto';

import { authorityHash } from '@agent-works/domain/delegation-authority';

import { budgetGuard } from '../finops/budget-guard.js';

import { childContext } from './context.js';
import { DelegationDenied } from './errors.js';
import { delegationEnabled } from './flag.js';
import { resultDigest } from './verifier.js';

import type { DelegationRequest } from './context.js';
import type { ChildVerifier } from './verifier.js';
import type { RunnerOutput } from '../agent/runner-port.js';
import type { BudgetPolicy, BudgetPort } from '../finops/budget-port.js';
import type { DelegationPort } from '../ports/delegation.js';
import type { DelegationAudit, DelegationContext } from '@agent-works/domain/delegation';
export type DelegationOptions = {
  readonly flag?: string;
  readonly maxDepth: number;
  readonly records: DelegationPort;
  readonly budget: BudgetPort;
  readonly budgetPolicy: BudgetPolicy;
  readonly verifier: ChildVerifier;
  readonly execute: (context: DelegationContext) => Promise<RunnerOutput>;
  readonly now?: () => Date;
};
export function createDelegator(options: DelegationOptions) {
  const enabled = delegationEnabled(options.flag);
  const now = options.now ?? (() => new Date());
  const guard = budgetGuard(options.budget, options.budgetPolicy);
  async function audit(
    parent: DelegationContext,
    childTaskId: string,
    reason: DelegationAudit['reason'],
  ): Promise<void> {
    await options.records.audit({
      eventId: randomUUID(),
      parentTaskId: parent.taskId,
      childTaskId,
      traceId: parent.traceId,
      occurredAt: now().toISOString(),
      reason,
    });
  }
  async function spawn(
    parent: DelegationContext,
    request: DelegationRequest,
  ): Promise<RunnerOutput> {
    if (!enabled) {
      await audit(parent, request.childTaskId, 'disabled');
      throw new DelegationDenied('disabled');
    }
    let child;
    try {
      child = childContext(parent, request, options.maxDepth, now());
    } catch (error) {
      if (error instanceof DelegationDenied)
        await audit(parent, request.childTaskId, error.reason as DelegationAudit['reason']);
      throw error;
    }
    const ownership = await options.records.create(
      {
        childTaskId: child.taskId,
        parentTaskId: parent.taskId,
        rootTaskId: child.rootTaskId,
        traceId: child.traceId,
        depth: child.depth,
        delegatedAuthorityHash: authorityHash(child.authority),
        budgetShare: child.budgetShare,
        state: 'pending',
        resultDigest: null,
        verifierRef: null,
        occurredAt: now().toISOString(),
      },
      parent.budgetShare,
    );
    if (ownership !== 'created') {
      const reason = ownership === 'replay' ? 'identity' : 'budget_share';
      await audit(parent, child.taskId, reason);
      throw new DelegationDenied(reason);
    }
    let result: RunnerOutput;
    try {
      result = await guard.run(
        {
          operationId: `delegation:${child.taskId}`,
          scope: child.budgetScope,
          estimatedCostMicros: child.budgetShare.estimatedCostMicros,
          inferenceSteps: child.budgetShare.inferenceSteps,
          parallelism: child.budgetShare.parallelism,
        },
        () => options.execute(structuredClone(child)),
      );
    } catch (error) {
      await options.records.settle(child.taskId, 'failed', null, null);
      await audit(parent, child.taskId, 'execution_failed');
      throw error;
    }
    const output = structuredClone(result);
    const digest = resultDigest(output);
    let verification;
    try {
      verification = await options.verifier.verify(structuredClone(child), structuredClone(output));
    } catch {
      await options.records.settle(child.taskId, 'rejected', digest, null);
      await audit(parent, child.taskId, 'verification_failed');
      throw new DelegationDenied('verification_failed');
    }
    if (!verification.accepted || verification.verifierRef.length === 0) {
      await options.records.settle(
        child.taskId,
        'rejected',
        digest,
        verification.verifierRef || null,
      );
      await audit(parent, child.taskId, 'verification_failed');
      throw new DelegationDenied('verification_failed');
    }
    await options.records.settle(child.taskId, 'verified', digest, verification.verifierRef);
    return output;
  }
  return {
    spawn(parent: DelegationContext, request: DelegationRequest): Promise<RunnerOutput> {
      return spawn(structuredClone(parent), structuredClone(request));
    },
  };
}
