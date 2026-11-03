import type { InvocationContext } from '@agent-works/policy';

export type ScopeKind = 'member' | 'bot' | 'segment';
export type Outcome = 'succeeded' | 'failed' | 'cancelled';
export type ReservationState = Outcome | 'active' | 'expired';
export type DenialReason =
  | 'member_cap'
  | 'bot_cap'
  | 'segment_cap'
  | 'member_share'
  | 'cost_budget'
  | 'provider_throttle'
  | 'suspended';
export type AdmissionRequest = {
  /** The logical execution id. Retries and redeliveries of one execution share it. */
  readonly executionId: string;
  readonly memberId: string;
  readonly botId: string;
  readonly segmentId: string;
  /** Owner-defined budget window the estimate is charged to. */
  readonly windowKey: string;
  readonly estimatedCostMicros: number;
  readonly provider?: string;
  readonly providerTokens?: number;
  /** Required when the service was built with a suspension enforcer. */
  readonly invocation?: InvocationContext;
};
export type AdmissionResult =
  | { readonly admitted: true; readonly replay: boolean; readonly expiresAt: Date }
  | {
      readonly admitted: false;
      readonly reason: DenialReason;
      /** Present only when waiting helps (token refill). The caller waits; no lock is held. */
      readonly retryAfterMs?: number;
    }
  | { readonly admitted: false; readonly reason: 'already_finished'; readonly state: Outcome };
export type LimitConfig = {
  readonly maxConcurrent?: number;
  /** Segment only: ceiling for one member's share of maxConcurrent, in basis points. */
  readonly maxShareBps?: number;
  readonly maxCostMicros?: number;
};
