export type RoutineKind = 'one_time' | 'recurring';
export type RoutineScope = { readonly action: string; readonly resource: string };

export type RoutineRecord = {
  /** The schedule id, derived from the grant and idempotency key, never from model output. */
  readonly routineId: string;
  readonly grantId: string;
  readonly sponsor: string;
  readonly idempotencyKey: string;
  readonly digest: string;
  readonly kind: RoutineKind;
  /** The (scope, source) pairs the routine may use; each one is inside the grant. */
  readonly scopes: readonly RoutineScope[];
  readonly state: 'active' | 'cancelled';
  readonly cancelReason: string | null;
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly cancelledAt: string | null;
};

export type CreateOutcome =
  | { readonly outcome: 'created'; readonly record: RoutineRecord }
  | { readonly outcome: 'existing'; readonly record: RoutineRecord }
  | { readonly outcome: 'conflict' }
  | { readonly outcome: 'fan_out_exceeded' };

/** Atomic per grant: the idempotency lookup, the cap count and the insert commit together. */
export type RoutineStore = {
  create(record: RoutineRecord, maxActive: number): Promise<CreateOutcome>;
  get(routineId: string): Promise<RoutineRecord | undefined>;
  listActive(): Promise<readonly RoutineRecord[]>;
  /** Idempotent: a cancelled routine is returned unchanged. */
  cancel(routineId: string, reason: string, at: string): Promise<RoutineRecord | undefined>;
};
