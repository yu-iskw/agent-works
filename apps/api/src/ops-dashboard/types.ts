type OpsScopeKind = 'member' | 'bot' | 'segment' | 'all';
export type OpsScope = { readonly kind: OpsScopeKind; readonly id: string };

/** Resolved server-side from the verified subject. Never read from the request body. */
export type OpsPrincipal = {
  readonly subject: string;
  readonly memberId: string;
  readonly ownedBotIds: readonly string[];
  readonly adminSegmentIds: readonly string[];
  readonly platformAdmin: boolean;
};

export type OpsWindow = { readonly from: string; readonly to: string };

/** Integer micro-units of USD throughout. */
export type CostCategories = {
  /** Our own ledger numbers. Never a bill. */
  readonly estimated: {
    readonly executions: number;
    readonly estimatedMicros: number;
    readonly recordedMicros: number;
  };
  /** Operator-provided billing lines that resolve to an execution or a team. */
  readonly billed: {
    readonly status: 'not_provided' | 'provided';
    readonly lines: number;
    readonly micros: number;
  };
  /** Billing lines nobody owns. Visible only at the all scope. */
  readonly unassigned: {
    readonly lines: number;
    readonly micros: number;
    readonly noLabel: number;
    readonly unknownExecution: number;
  };
  readonly perSuccessfulTaskMicros: number | null;
  readonly succeededExecutions: number;
};

export type OpsDashboard = {
  readonly scope: OpsScope;
  readonly window: OpsWindow;
  readonly generatedAt: string;
  readonly dueToClaim: {
    readonly samples: number;
    readonly p50Ms: number | null;
    readonly p95Ms: number | null;
    readonly maxMs: number | null;
  };
  readonly backlog: {
    readonly queued: number;
    readonly running: number;
    readonly awaitingOrQuarantined: number;
    readonly oldestQueuedMs: number;
  };
  readonly outbox: {
    readonly pending: number;
    readonly published: number;
    readonly abandoned: number;
    readonly oldestPendingMs: number;
  };
  readonly retries: {
    readonly executions: number;
    readonly attempts: number;
    readonly retries: number;
    readonly amplification: number | null;
  };
  readonly quota: {
    readonly active: number;
    readonly byState: Readonly<Record<string, number>>;
    /** null when no owner-set limit exists for the scope. Nothing is invented. */
    readonly limits: { maxConcurrent: number | null; maxCostMicros: number | null } | null;
  };
  readonly cost: CostCategories;
};

export class OpsDenied extends Error {
  constructor() {
    super('ops scope denied');
  }
}
