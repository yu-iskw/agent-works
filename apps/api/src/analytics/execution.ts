import { reject } from './errors.js';

export type AnalyticsExecution = { signal?: AbortSignal; deadline?: number };
export function checkAnalyticsExecution(execution?: AnalyticsExecution): void {
  if (execution?.signal?.aborted === true) reject('ANALYST_CANCELLED', 409);
  if (
    execution?.deadline !== undefined &&
    (!Number.isFinite(execution.deadline) || Date.now() >= execution.deadline)
  )
    reject('ANALYST_TIMEOUT', 409);
}
