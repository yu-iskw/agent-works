import { delegationContextSchema } from '@agent-works/domain/delegation';
import { intersectAuthority } from '@agent-works/domain/delegation-authority';

import { DelegationDenied } from './errors.js';

import type { BudgetLimits } from '@agent-works/domain/budget';
import type { DelegationContext } from '@agent-works/domain/delegation';
import type { RequestedGrant } from '@agent-works/domain/delegation-authority';
export type DelegationRequest = {
  readonly childTaskId: string;
  readonly grants: readonly RequestedGrant[];
  readonly budgetShare: BudgetLimits;
};
/** Input is a trusted execution context, not a parsed model message. Only requested grants may be proposed. */
export function childContext(
  parentInput: DelegationContext,
  request: DelegationRequest,
  maxDepth: number,
  now: Date,
): DelegationContext {
  const parent = delegationContextSchema.parse(parentInput);
  if (!Number.isSafeInteger(maxDepth) || maxDepth < 0 || parent.depth >= maxDepth)
    throw new DelegationDenied('depth');
  if (Date.parse(parent.authority.expiresAt) <= now.getTime())
    throw new DelegationDenied('expired');
  if (
    parent.budgetScope.taskId !== parent.rootTaskId ||
    parent.budgetScope.userSubject !== parent.authority.subject
  )
    throw new DelegationDenied('identity');
  if (request.childTaskId === parent.taskId || request.childTaskId === parent.rootTaskId)
    throw new DelegationDenied('identity');
  const share = request.budgetShare;
  if (
    share.estimatedCostMicros > parent.budgetShare.estimatedCostMicros ||
    share.inferenceSteps > parent.budgetShare.inferenceSteps ||
    share.parallelism > parent.budgetShare.parallelism
  )
    throw new DelegationDenied('budget_share');
  return delegationContextSchema.parse({
    ...parent,
    taskId: request.childTaskId,
    parentTaskId: parent.taskId,
    depth: parent.depth + 1,
    authority: intersectAuthority(parent.authority, request.grants),
    budgetShare: share,
  });
}
