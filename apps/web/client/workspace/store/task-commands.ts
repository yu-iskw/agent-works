// Which member commands a task accepts in its current state. The sets mirror TEAMWORK_TRANSITIONS
// in the domain package; task-commands.test.ts checks them against that table so they cannot drift.

import type { TaskDetailPage } from '../../../shared/contract.js';
import type { TeamworkStatus } from '@agent-works/domain/teamwork';

/** Statuses from which `cancel` is accepted (a transition to cancel_requested or cancelled). */
export const CANCELLABLE: ReadonlySet<TeamworkStatus> = new Set<TeamworkStatus>([
  'planning',
  'plan_review',
  'running',
  'needs_input',
  'synthesizing',
  'ready',
  'awaiting_action_approval',
  'failed',
]);

export const canCancel = (status: TeamworkStatus): boolean => CANCELLABLE.has(status);
export const canRetry = (status: TeamworkStatus): boolean => status === 'failed';
export const canReconcile = (status: TeamworkStatus): boolean => status === 'outcome_uncertain';

/** Assignments the member can still retry or proceed without, while the task waits for input. */
export function missingAssignments(detail: TaskDetailPage) {
  if (detail.task.status !== 'needs_input') return [];
  return detail.assignments.filter(
    (a) => a.status === 'failed' || a.status === 'timed_out' || a.status === 'cancelled',
  );
}

/** A plan can be decided only while it is the live proposal of a task in review. */
export function planDecisionBlocker(detail: TaskDetailPage, version: number): string | null {
  const plan = detail.plans.find((p) => p.version === version);
  if (plan === undefined) return 'This plan version no longer exists.';
  if (plan.state !== 'proposed') return `Version ${version} was already ${plan.state}.`;
  const newest = Math.max(...detail.plans.map((p) => p.version));
  if (newest > version) return `Version ${newest} replaced this plan.`;
  if (detail.task.status !== 'plan_review')
    return 'The task is no longer waiting for a plan decision.';
  return null;
}
