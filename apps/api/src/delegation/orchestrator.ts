import { randomUUID } from 'node:crypto';

import { authorityHash } from '../../../../packages/domain/dist/delegation-authority.js';
import { budgetGuard } from '../finops/budget-guard.js';

import { childContext } from './context.js';
import { DelegationDenied } from './errors.js';
import { delegationEnabled } from './flag.js';
import { resultDigest } from './verifier.js';

import type { DelegationRequest } from './context.js';
import type { ChildVerifier } from './verifier.js';
import type {
  DelegationAudit,
  DelegationContext,
} from '../../../../packages/domain/dist/delegation.js';
import type { RunnerOutput } from '../agent/runner-port.js';
import type { BudgetPolicy, BudgetPort } from '../finops/budget-port.js';
import type { DelegationPort } from '../ports/delegation.js';
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
  const inFlight = new Map<string, Promise<RunnerOutput>>();
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
    if ((await options.records.read(child.taskId)) !== undefined)
      throw new DelegationDenied('identity');
    await options.records.create({
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
    });
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
      // Reserve ownership synchronously to close concurrent duplicate dispatch races.
      if (inFlight.has(request.childTaskId))
        return Promise.reject(new DelegationDenied('identity'));
      const operation = spawn(structuredClone(parent), structuredClone(request));
      inFlight.set(request.childTaskId, operation);
      return operation;
    },
  };
}
