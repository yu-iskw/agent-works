import type {
  BudgetCharge,
  BudgetDimension,
  BudgetLimits,
  BudgetScope,
  BudgetUsage,
} from '@agent-works/domain/budget';

type BudgetMode = 'observe' | 'isolated-test-enforce';
export type BudgetPolicy = {
  readonly task: BudgetLimits;
  readonly user: BudgetLimits;
  readonly mode: BudgetMode;
};
export type BudgetEvent = {
  readonly eventId: string;
  readonly kind: 'charged' | 'exceeded' | 'released';
  readonly operationId: string;
  readonly scope: BudgetScope;
  readonly dimension: BudgetDimension | null;
  readonly estimatedCostMicros: number;
  readonly inferenceSteps: number;
  readonly mode: BudgetMode;
};
export type Reservation = {
  readonly charge: BudgetCharge;
  readonly taskUsage: BudgetUsage;
  readonly userUsage: BudgetUsage;
  readonly exceeded: BudgetDimension | null;
  readonly allowed: boolean;
};
export interface BudgetPort {
  /** Must atomically check both scopes, reserve and append its evidence. */
  reserve(charge: BudgetCharge, policy: BudgetPolicy): Promise<Reservation>;
  /** Idempotent: releases concurrency only, never erases incurred cost or inference steps. */
  release(operationId: string): Promise<void>;
  events(): Promise<readonly BudgetEvent[]>;
}
